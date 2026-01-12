import type { Operation, OperationKind } from '@treecrdt/interface'
import { ROOT_NODE_ID_HEX, bytesToHex, nodeIdToBytes16 } from '@treecrdt/interface/ids'
import type { Filter, SyncBackend, SyncSubscription } from '@treecrdt/sync'
import { SyncPeer } from '@treecrdt/sync'
import { treecrdtSyncV0ProtobufCodec } from '@treecrdt/sync/protobuf'
import type { DuplexTransport } from '@treecrdt/sync/transport'
import { wrapDuplexTransportWithCodec } from '@treecrdt/sync/transport'
import type { TreecrdtClient } from '@treecrdt/wa-sqlite/client'
import { createTreecrdtClient } from '@treecrdt/wa-sqlite/client'

import type Index from '../@types/IndexType'
import type Lexeme from '../@types/Lexeme'
import type Thought from '../@types/Thought'
import { updateThoughtsActionCreator } from '../actions/updateThoughts'
import { HOME_TOKEN } from '../constants'
import db from '../data-providers/yjs/thoughtspace'
import { clientIdReady, tsid } from '../data-providers/yjs'
import store from '../stores/app'
import offlineStatusStore from '../stores/offlineStatusStore'
import head from '../util/head'

const FILTER_ALL: Filter = { all: {} }

const wsBaseDefault = import.meta.env.VITE_TREECRDT_SYNC_WS_BASE || 'ws://localhost:8787'

const randomSessionId = (): string => {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID()
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
}

const getOrCreateSyncSessionId = (): string => {
  try {
    if (typeof sessionStorage === 'undefined') return randomSessionId()
    const key = 'treecrdtSyncSessionId'
    const existing = sessionStorage.getItem(key)
    if (existing) return existing
    const id = randomSessionId()
    sessionStorage.setItem(key, id)
    return id
  } catch {
    return randomSessionId()
  }
}

/**
 * Store serialized em update batches inside the TreeCRDT doc as a "blob log":
 * - root -> messageRoot -> [chunkNodes...]
 * - each chunkNodeId is XOR-encoded with messageRoot id, so ids are message-unique without extra metadata.
 *
 * Encoding note:
 * - v1 stored raw 16-byte chunks directly in node ids. This can collide when two chunks are identical, since node ids must be unique.
 * - v2 prefixes each chunk with a 2-byte chunk index (so node ids are unique within a message), and stores 14 bytes of payload per node.
 */
const EM_SYNC_MESSAGE_ROOT_PREFIX_HEX = '656d' // "em"
const EM_SYNC_LOG_MAGIC_V1 = new Uint8Array([0x45, 0x4d, 0x54, 0x31]) // "EMT1"
const EM_SYNC_LOG_MAGIC_V2 = new Uint8Array([0x45, 0x4d, 0x54, 0x32]) // "EMT2"
const EM_SYNC_LOG_V2_CHUNK_INDEX_BYTES = 2
const EM_SYNC_LOG_V2_CHUNK_DATA_BYTES = 14

type EmSyncMessageV1 = {
  v: 1
  sender: string
  schemaVersion: number
  thoughtIndexUpdates: Index<Thought | null>
  lexemeIndexUpdates: Index<Lexeme | null>
  lexemeIndexUpdatesOld: Index<Lexeme | undefined>
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const xor16 = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  if (a.length !== 16 || b.length !== 16) throw new Error('xor16 expects 16-byte inputs')
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i += 1) out[i] = a[i] ^ b[i]
  return out
}

const encodeEmSyncMessage = (rootHex: string, msg: EmSyncMessageV1): string[] => {
  const payloadBytes = textEncoder.encode(JSON.stringify(msg))

  const header = new Uint8Array(16)
  header.set(EM_SYNC_LOG_MAGIC_V2, 0)
  new DataView(header.buffer).setUint32(4, payloadBytes.length, true)

  const full = new Uint8Array(16 + payloadBytes.length)
  full.set(header, 0)
  full.set(payloadBytes, 16)

  const rootBytes = nodeIdToBytes16(rootHex)
  const chunkCount = Math.ceil(full.length / EM_SYNC_LOG_V2_CHUNK_DATA_BYTES)
  const encodedNodeIds: string[] = []

  for (let i = 0; i < chunkCount; i += 1) {
    const chunk = new Uint8Array(16)
    // Prefix with a 2-byte chunk index so node ids are unique even when chunk payload repeats.
    // Store 14 bytes of data per node id.
    new DataView(chunk.buffer).setUint16(0, i, true)
    chunk.set(
      full.subarray(
        i * EM_SYNC_LOG_V2_CHUNK_DATA_BYTES,
        i * EM_SYNC_LOG_V2_CHUNK_DATA_BYTES + EM_SYNC_LOG_V2_CHUNK_DATA_BYTES,
      ),
      EM_SYNC_LOG_V2_CHUNK_INDEX_BYTES,
    )
    encodedNodeIds.push(bytesToHex(xor16(chunk, rootBytes)))
  }

  return encodedNodeIds
}

const decodeEmSyncMessageV1 = (rootHex: string, chunkNodeIds: string[]): EmSyncMessageV1 | null => {
  if (chunkNodeIds.length === 0) return null

  const rootBytes = nodeIdToBytes16(rootHex)
  const full = new Uint8Array(chunkNodeIds.length * 16)

  for (let i = 0; i < chunkNodeIds.length; i += 1) {
    const encoded = nodeIdToBytes16(chunkNodeIds[i]!)
    full.set(xor16(encoded, rootBytes), i * 16)
  }

  const header = full.subarray(0, 16)
  for (let i = 0; i < 4; i += 1) {
    if (header[i] !== EM_SYNC_LOG_MAGIC_V1[i]) return null
  }

  const payloadLen = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(4, true)
  const payloadStart = 16
  const payloadEnd = payloadStart + payloadLen
  if (payloadEnd > full.length) return null

  const json = textDecoder.decode(full.subarray(payloadStart, payloadEnd))
  const parsed = JSON.parse(json) as Partial<EmSyncMessageV1>
  if (parsed.v !== 1) return null
  if (typeof parsed.sender !== 'string') return null
  if (typeof parsed.schemaVersion !== 'number') return null
  if (!parsed.thoughtIndexUpdates || !parsed.lexemeIndexUpdates || !parsed.lexemeIndexUpdatesOld) return null

  return parsed as EmSyncMessageV1
}

const decodeEmSyncMessageV2 = (rootHex: string, chunkNodeIds: string[]): EmSyncMessageV1 | null => {
  if (chunkNodeIds.length === 0) return null

  const rootBytes = nodeIdToBytes16(rootHex)
  const chunksByIndex = new Map<number, Uint8Array>()

  for (const chunkId of chunkNodeIds) {
    const encoded = nodeIdToBytes16(chunkId)
    const decoded = xor16(encoded, rootBytes)
    const index = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength).getUint16(0, true)
    const data = decoded.subarray(EM_SYNC_LOG_V2_CHUNK_INDEX_BYTES, 16)
    chunksByIndex.set(index, data)
  }

  // Need at least chunk 0 and 1 to read the 16-byte header (14 + 2 bytes).
  const c0 = chunksByIndex.get(0)
  const c1 = chunksByIndex.get(1)
  if (!c0 || !c1) return null

  const header = new Uint8Array(16)
  header.set(c0.subarray(0, 14), 0)
  header.set(c1.subarray(0, 2), 14)

  for (let i = 0; i < 4; i += 1) {
    if (header[i] !== EM_SYNC_LOG_MAGIC_V2[i]) return null
  }

  const payloadLen = new DataView(header.buffer).getUint32(4, true)
  const totalLen = 16 + payloadLen
  const requiredChunks = Math.ceil(totalLen / EM_SYNC_LOG_V2_CHUNK_DATA_BYTES)

  const full = new Uint8Array(requiredChunks * EM_SYNC_LOG_V2_CHUNK_DATA_BYTES)
  for (let i = 0; i < requiredChunks; i += 1) {
    const data = chunksByIndex.get(i)
    if (!data) return null
    full.set(data, i * EM_SYNC_LOG_V2_CHUNK_DATA_BYTES)
  }

  const payloadStart = 16
  const payloadEnd = payloadStart + payloadLen
  if (payloadEnd > totalLen) return null

  const json = textDecoder.decode(full.subarray(payloadStart, payloadEnd))
  const parsed = JSON.parse(json) as Partial<EmSyncMessageV1>
  if (parsed.v !== 1) return null
  if (typeof parsed.sender !== 'string') return null
  if (typeof parsed.schemaVersion !== 'number') return null
  if (!parsed.thoughtIndexUpdates || !parsed.lexemeIndexUpdates || !parsed.lexemeIndexUpdatesOld) return null

  return parsed as EmSyncMessageV1
}

const decodeEmSyncMessage = (rootHex: string, chunkNodeIds: string[]): EmSyncMessageV1 | null => {
  return decodeEmSyncMessageV2(rootHex, chunkNodeIds) ?? decodeEmSyncMessageV1(rootHex, chunkNodeIds)
}

const createBackend = (
  client: TreecrdtClient,
  docId: string,
  opts: {
    onAppliedOps?: (ops: Operation[]) => void
  } = {},
): SyncBackend<Operation> => ({
  docId,

  async maxLamport() {
    return BigInt(await client.meta.headLamport())
  },

  async listOpRefs(filter) {
    if ('all' in filter) {
      return client.opRefs.all()
    }
    return client.opRefs.children(bytesToHex(filter.children.parent))
  },

  async getOpsByOpRefs(opRefs) {
    return client.ops.get(opRefs)
  },

  async applyOps(ops) {
    if (ops.length === 0) return
    await client.ops.appendMany(ops)
    if (opts.onAppliedOps) {
      queueMicrotask(() => opts.onAppliedOps?.(ops))
    }
  },
})

const openWebSocket = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    ws.addEventListener('open', () => resolve(ws), { once: true })
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true })
  })

const createWebSocketTransport = (ws: WebSocket): DuplexTransport<Uint8Array> => ({
  send: async msg => {
    ws.send(msg)
  },
  onMessage: handler => {
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data
      if (data instanceof ArrayBuffer) {
        handler(new Uint8Array(data))
      } else if (data instanceof Blob) {
        data.arrayBuffer().then(buf => handler(new Uint8Array(buf)))
      }
    }
    ws.addEventListener('message', onMessage)
    return () => ws.removeEventListener('message', onMessage)
  },
})

const randomNodeId = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(16)))

const randomEmMessageRootId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[0] = 0x65 // 'e'
  bytes[1] = 0x6d // 'm'
  return bytesToHex(bytes)
}

const normalizeNodeIdHex = (id: string) => bytesToHex(nodeIdToBytes16(id))

const isEmMessageRootId = (id: string): boolean => normalizeNodeIdHex(id).startsWith(EM_SYNC_MESSAGE_ROOT_PREFIX_HEX)

const parseEmThoughtIdAsNodeIdHex = (id: string): string | null => {
  if (id === HOME_TOKEN) return ROOT_NODE_ID_HEX
  if (/^[0-9a-fA-F]{32}$/.test(id)) return id.toLowerCase()
  return null
}

const childrenFilter = (parentHex: string): Filter => ({
  children: { parent: nodeIdToBytes16(parentHex) },
})

export const startTreecrdtSync = async (
  opts: {
    docId?: string
    wsBase?: string
    mode?: 'all' | 'children'
    autoWatchExpanded?: boolean
    /** Prefetch root-children (depth=2) so leaf/parent state can update live. Default: true in `children` mode. */
    autoWatchRootChildren?: boolean
  } = {},
) => {
  const docId = (opts.docId ?? tsid).trim()
  if (!docId) throw new Error('TreeCRDT docId must not be empty')
  const wsBase = (opts.wsBase ?? wsBaseDefault).replace(/\/$/, '')
  const wsUrl = `${wsBase}/sync?docId=${encodeURIComponent(docId)}`

  const safeDoc = docId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const sessionId = getOrCreateSyncSessionId()
  const client = await createTreecrdtClient({
    docId,
    storage: 'auto',
    filename: `/em-treecrdt-${safeDoc}-${sessionId}.db`,
  })
  const ws = await openWebSocket(wsUrl)
  offlineStatusStore.update('connected')

  const wire = createWebSocketTransport(ws)
  const transport = wrapDuplexTransportWithCodec(wire, treecrdtSyncV0ProtobufCodec)
  let stopped = false
  let onRemoteAppliedOps: (ops: Operation[]) => void = () => {}

  const childSubs = new Map<string, SyncSubscription>()
  const childSubRefs = new Map<string, number>()

	  const addChildSubRef = (parentHex: string) => {
	    const key = normalizeNodeIdHex(parentHex)
	    childSubRefs.set(key, (childSubRefs.get(key) ?? 0) + 1)
	    if (childSubs.has(key)) return
	
	    const sub = peer.subscribe(transport, childrenFilter(key), { intervalMs: 0, immediate: true })
	    childSubs.set(key, sub)
	    void sub.done.catch(err => {
	      console.error('TreeCRDT live children subscription failed', { parent: key, err })
	      childSubs.delete(key)
	      childSubRefs.delete(key)
    })
  }

  const releaseChildSubRef = (parentHex: string) => {
    const key = normalizeNodeIdHex(parentHex)
    const next = (childSubRefs.get(key) ?? 0) - 1
    if (next > 0) {
      childSubRefs.set(key, next)
      return
    }
    childSubRefs.delete(key)
    const sub = childSubs.get(key)
    if (sub) {
      sub.stop()
      childSubs.delete(key)
    }
  }

  const autoWatchedRootChildren = new Set<string>()
  let autoWatchRootChildrenEnabled = false
  let autoWatchRootChildrenScheduled = false

	  const updateAutoWatchRootChildren = async () => {
	    autoWatchRootChildrenScheduled = false
	    if (stopped) return
	    if (!autoWatchRootChildrenEnabled) return
	
	    const desired = new Set<string>()
	    const rootChildren = await client.tree.children(ROOT_NODE_ID_HEX)
	    for (const child of rootChildren) {
	      const nodeId = normalizeNodeIdHex(child)
	      // Em sync messages are stored as (ROOT -> messageRoot -> chunkNodes...). They can have a large number
	      // of chunk children, so auto-watching them (depth=2) is both unnecessary and can overwhelm partial-sync.
	      if (isEmMessageRootId(nodeId)) continue
	      desired.add(nodeId)
	    }

    for (const nodeId of desired) {
      if (autoWatchedRootChildren.has(nodeId)) continue
      autoWatchedRootChildren.add(nodeId)
      addChildSubRef(nodeId)
    }

    for (const nodeId of Array.from(autoWatchedRootChildren)) {
      if (desired.has(nodeId)) continue
      autoWatchedRootChildren.delete(nodeId)
      releaseChildSubRef(nodeId)
    }
  }

  const scheduleAutoWatchRootChildren = () => {
    if (!autoWatchRootChildrenEnabled) return
    if (autoWatchRootChildrenScheduled) return
    autoWatchRootChildrenScheduled = true
    void Promise.resolve().then(updateAutoWatchRootChildren)
  }

  const startAutoWatchRootChildren = () => {
    if (autoWatchRootChildrenEnabled) return
    autoWatchRootChildrenEnabled = true
    scheduleAutoWatchRootChildren()
  }

  const stopAutoWatchRootChildren = () => {
    if (!autoWatchRootChildrenEnabled) return
    autoWatchRootChildrenEnabled = false
    autoWatchRootChildrenScheduled = false
    for (const nodeId of Array.from(autoWatchedRootChildren)) {
      autoWatchedRootChildren.delete(nodeId)
      releaseChildSubRef(nodeId)
    }
  }

  const peer = new SyncPeer<Operation>(
    createBackend(client, docId, {
      onAppliedOps: ops => {
        scheduleAutoWatchRootChildren()
        onRemoteAppliedOps(ops)
      },
    }),
  )
  const detach = peer.attach(transport, {
    onError: (err, ctx) => {
      console.error('TreeCRDT message handler failed', { err, type: ctx.message.payload.case })
    },
  })

  const autoWatchedParents = new Set<string>()
  let autoWatchUnsubscribe: (() => void) | null = null
  let autoWatchScheduled = false

  const updateAutoWatchExpanded = () => {
    autoWatchScheduled = false
    const state = store.getState()

    const desired = new Set<string>()

    const cursorPath = state.cursor ?? [HOME_TOKEN]
    for (let i = 1; i <= cursorPath.length; i += 1) {
      const id = head(cursorPath.slice(0, i))
      const nodeId = parseEmThoughtIdAsNodeIdHex(id)
      if (nodeId) desired.add(nodeId)
    }

    for (const path of Object.values(state.expanded)) {
      const id = head(path)
      const nodeId = parseEmThoughtIdAsNodeIdHex(id)
      if (nodeId) desired.add(nodeId)
    }

    for (const nodeId of desired) {
      if (autoWatchedParents.has(nodeId)) continue
      autoWatchedParents.add(nodeId)
      addChildSubRef(nodeId)
    }

    for (const nodeId of Array.from(autoWatchedParents)) {
      if (desired.has(nodeId)) continue
      autoWatchedParents.delete(nodeId)
      releaseChildSubRef(nodeId)
    }
  }

  const startAutoWatchExpanded = () => {
    if (autoWatchUnsubscribe) return
    updateAutoWatchExpanded()
    autoWatchUnsubscribe = store.subscribe(() => {
      if (autoWatchScheduled) return
      autoWatchScheduled = true
      Promise.resolve().then(updateAutoWatchExpanded)
    })
  }

  const stopAutoWatchExpanded = () => {
    if (!autoWatchUnsubscribe) return
    autoWatchUnsubscribe()
    autoWatchUnsubscribe = null
    autoWatchScheduled = false
    for (const nodeId of Array.from(autoWatchedParents)) {
      autoWatchedParents.delete(nodeId)
      releaseChildSubRef(nodeId)
    }
  }

  const mode = opts.mode ?? 'children'
	  const allSub =
	    mode === 'all' ? peer.subscribe(transport, FILTER_ALL, { intervalMs: 0, immediate: true }) : null

  if (mode === 'children') addChildSubRef(ROOT_NODE_ID_HEX)
  if (opts.autoWatchExpanded ?? mode === 'children') startAutoWatchExpanded()
  if (opts.autoWatchRootChildren ?? mode === 'children') startAutoWatchRootChildren()

  const replicaId = `em:${await clientIdReady}:${sessionId}`
  let counter = await client.meta.replicaMaxCounter(replicaId)
  let lamport = await client.meta.headLamport()

  // ---- TreeCRDT-backed em sync (experiment) ----
  const processedEmRoots = new Set<string>()
  const pendingEmRoots = new Set<string>()
  let emProcessTimer: ReturnType<typeof setTimeout> | null = null

  const originalUpdateThoughts = db.updateThoughts.bind(db)

  const appendMany = async (kinds: OperationKind[]): Promise<Operation[]> => {
    if (kinds.length === 0) return []
    lamport = Math.max(lamport, await client.meta.headLamport())

    const ops: Operation[] = []
    for (const kind of kinds) {
      counter += 1
      lamport += 1
      ops.push({ meta: { id: { replica: replicaId, counter }, lamport }, kind })
    }

    await client.ops.appendMany(ops)
    return ops
  }

  const broadcastEmUpdate = async (args: {
    thoughtIndexUpdates: Index<Thought | null>
    lexemeIndexUpdates: Index<Lexeme | null>
    lexemeIndexUpdatesOld: Index<Lexeme | undefined>
    schemaVersion: number
  }) => {
    if (stopped) return
    if (Object.keys(args.thoughtIndexUpdates).length === 0 && Object.keys(args.lexemeIndexUpdates).length === 0) return

    const messageRoot = randomEmMessageRootId()
    const msg: EmSyncMessageV1 = {
      v: 1,
      sender: replicaId,
      schemaVersion: typeof args.schemaVersion === 'number' && Number.isFinite(args.schemaVersion) ? args.schemaVersion : 0,
      thoughtIndexUpdates: args.thoughtIndexUpdates,
      lexemeIndexUpdates: args.lexemeIndexUpdates,
      lexemeIndexUpdatesOld: args.lexemeIndexUpdatesOld,
    }

    const chunkNodeIds = encodeEmSyncMessage(messageRoot, msg)
    processedEmRoots.add(messageRoot)

    const insertKind = (parent: string, node: string, position: number): OperationKind => ({
      type: 'insert',
      parent,
      node,
      position,
    })

    const kinds: OperationKind[] = [
      // Insert at the beginning to avoid needing to read (and potentially load) all existing root children.
      insertKind(ROOT_NODE_ID_HEX, messageRoot, 0),
      ...chunkNodeIds.map((chunkId, position) => insertKind(messageRoot, chunkId, position)),
    ]

    await appendMany(kinds)
    // Push just the relevant filters. `FILTER_ALL` can grow without bound due to the chunk log.
    await peer.syncOnce(transport, childrenFilter(ROOT_NODE_ID_HEX))
    await peer.syncOnce(transport, childrenFilter(messageRoot))
  }

  const applyRemoteEmUpdate = async (msg: EmSyncMessageV1) => {
    if (msg.sender === replicaId) return

    await originalUpdateThoughts({
      thoughtIndexUpdates: msg.thoughtIndexUpdates,
      lexemeIndexUpdates: msg.lexemeIndexUpdates,
      lexemeIndexUpdatesOld: msg.lexemeIndexUpdatesOld,
      schemaVersion: msg.schemaVersion,
    })

    store.dispatch(
      updateThoughtsActionCreator({
        thoughtIndexUpdates: msg.thoughtIndexUpdates,
        lexemeIndexUpdates: msg.lexemeIndexUpdates,
        local: false,
        remote: false,
        repairCursor: true,
      }),
    )
  }

  const tryProcessEmRoot = async (rootHex: string): Promise<'done' | 'retry'> => {
    const root = normalizeNodeIdHex(rootHex)
    if (processedEmRoots.has(root)) return 'done'

    await peer.syncOnce(transport, childrenFilter(root))
    const chunks = await client.tree.children(root)
    const msg = decodeEmSyncMessage(root, chunks)
    if (!msg) return 'retry'

    await applyRemoteEmUpdate(msg)
    processedEmRoots.add(root)
    pendingEmRoots.delete(root)
    return 'done'
  }

  const processPendingEmRoots = async () => {
    emProcessTimer = null
    if (stopped) return

    let needsRetry = false
    for (const root of Array.from(pendingEmRoots)) {
      const result = await tryProcessEmRoot(root)
      if (result === 'retry') needsRetry = true
    }
    if (needsRetry && pendingEmRoots.size > 0) {
      emProcessTimer = setTimeout(() => void processPendingEmRoots(), 250)
    }
  }

  const scheduleProcessPendingEmRoots = () => {
    if (emProcessTimer) return
    emProcessTimer = setTimeout(() => void processPendingEmRoots(), 0)
  }

  onRemoteAppliedOps = (ops: Operation[]) => {
    for (const op of ops) {
      if (op.kind.type !== 'insert') continue
      if (normalizeNodeIdHex(op.kind.parent) !== ROOT_NODE_ID_HEX) continue
      if (!isEmMessageRootId(op.kind.node)) continue
      pendingEmRoots.add(normalizeNodeIdHex(op.kind.node))
    }
    if (pendingEmRoots.size > 0) scheduleProcessPendingEmRoots()
  }

  // Patch the Yjs data provider to emit TreeCRDT log messages for every db update.
  db.updateThoughts = async args => {
    await originalUpdateThoughts(args)
    void broadcastEmUpdate(args).catch(err => console.error('TreeCRDT em sync broadcast failed', err))
  }

  const append = async (kind: OperationKind, syncFilter?: Filter): Promise<Operation> => {
    counter += 1
    lamport = Math.max(lamport, await client.meta.headLamport()) + 1
    const op: Operation = { meta: { id: { replica: replicaId, counter }, lamport }, kind }
    await client.ops.append(op)
    if (syncFilter) {
      await peer.syncOnce(transport, syncFilter)
    }
    return op
  }

  // Replay em message history (for fresh browser contexts).
  // Root children are already watched in `children` mode; this is just a one-time kick to process existing messages.
  void peer
    .syncOnce(transport, childrenFilter(ROOT_NODE_ID_HEX))
    .then(async () => {
      const roots = await client.tree.children(ROOT_NODE_ID_HEX)
      roots.filter(isEmMessageRootId).forEach(root => pendingEmRoots.add(normalizeNodeIdHex(root)))
      scheduleProcessPendingEmRoots()
    })
    .catch(err => console.error('TreeCRDT em sync init failed', err))

  const api = {
    client,
    peer,
    ws,
    syncAll: () => peer.syncOnce(transport, FILTER_ALL),
    syncChildren: (parentHex: string) => peer.syncOnce(transport, childrenFilter(parentHex)),
    watchChildren: (parentHex: string) => addChildSubRef(parentHex),
    unwatchChildren: (parentHex: string) => releaseChildSubRef(parentHex),
    listWatchedChildren: () => Array.from(childSubs.keys()),
    startAutoWatchExpanded,
    stopAutoWatchExpanded,
    startAutoWatchRootChildren,
    stopAutoWatchRootChildren,
    insertRootChild: async () => {
      const children = await client.tree.children(ROOT_NODE_ID_HEX)
      const node = randomNodeId()
      await append({ type: 'insert', parent: ROOT_NODE_ID_HEX, node, position: children.length }, childrenFilter(ROOT_NODE_ID_HEX))
      scheduleAutoWatchRootChildren()
      return node
    },
    insertChild: async (parentHex: string) => {
      const parent = normalizeNodeIdHex(parentHex)
      const children = await client.tree.children(parent)
      const node = randomNodeId()
      await append({ type: 'insert', parent, node, position: children.length }, childrenFilter(parent))
      scheduleAutoWatchRootChildren()
      return node
    },
    stop: () => {
      if (stopped) return
      stopped = true
      offlineStatusStore.update('offline')
      db.updateThoughts = originalUpdateThoughts
      if (emProcessTimer) clearTimeout(emProcessTimer)
      stopAutoWatchExpanded()
      stopAutoWatchRootChildren()
      allSub?.stop()
      for (const sub of childSubs.values()) sub.stop()
      childSubs.clear()
      childSubRefs.clear()
      detach()
      ws.close()
      void client.close()
    },
  }

  ws.addEventListener('close', () => api.stop(), { once: true })
  ;(window as any).treecrdtSync = api
}
