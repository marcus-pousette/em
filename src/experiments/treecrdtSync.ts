import type { Operation, OperationKind } from '@treecrdt/interface'
import { ROOT_NODE_ID_HEX, bytesToHex } from '@treecrdt/interface/ids'
import type { Filter, SyncBackend } from '@treecrdt/sync'
import { SyncPeer } from '@treecrdt/sync'
import { treecrdtSyncV0ProtobufCodec } from '@treecrdt/sync/protobuf'
import type { DuplexTransport } from '@treecrdt/sync/transport'
import { wrapDuplexTransportWithCodec } from '@treecrdt/sync/transport'
import type { TreecrdtClient } from '@treecrdt/wa-sqlite/client'
import { createTreecrdtClient } from '@treecrdt/wa-sqlite/client'

import { clientIdReady, tsid } from '../data-providers/yjs'

const FILTER_ALL: Filter = { all: {} }

const wsBaseDefault = import.meta.env.VITE_TREECRDT_SYNC_WS_BASE || 'ws://localhost:8787'

const createBackend = (client: TreecrdtClient, docId: string): SyncBackend<Operation> => ({
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

export const startTreecrdtSync = async (opts: { docId?: string; wsBase?: string } = {}) => {
  const docId = opts.docId ?? tsid
  const wsBase = (opts.wsBase ?? wsBaseDefault).replace(/\/$/, '')
  const wsUrl = `${wsBase}/sync?docId=${encodeURIComponent(docId)}`

  const client = await createTreecrdtClient({ docId, storage: 'memory', preferWorker: false })
  const ws = await openWebSocket(wsUrl)

  const wire = createWebSocketTransport(ws)
  const transport = wrapDuplexTransportWithCodec(wire, treecrdtSyncV0ProtobufCodec)
  const backend = createBackend(client, docId)
  const peer = new SyncPeer<Operation>(backend)
  const detach = peer.attach(transport)

  const sub = peer.subscribe(transport, FILTER_ALL, { intervalMs: 0, immediate: true })

  const replicaId = `em:${await clientIdReady}`
  let counter = await client.meta.replicaMaxCounter(replicaId)
  let lamport = await client.meta.headLamport()

  const append = async (kind: OperationKind): Promise<Operation> => {
    counter += 1
    lamport = Math.max(lamport, await client.meta.headLamport()) + 1
    const op: Operation = { meta: { id: { replica: replicaId, counter }, lamport }, kind }
    await client.ops.append(op)
    await peer.syncOnce(transport, FILTER_ALL)
    return op
  }

  let stopped = false
  const api = {
    client,
    peer,
    ws,
    syncAll: () => peer.syncOnce(transport, FILTER_ALL),
    insertRootChild: async () => {
      const children = await client.tree.children(ROOT_NODE_ID_HEX)
      const node = randomNodeId()
      await append({ type: 'insert', parent: ROOT_NODE_ID_HEX, node, position: children.length })
      return node
    },
    stop: () => {
      if (stopped) return
      stopped = true
      sub.stop()
      detach()
      ws.close()
      void client.close()
    },
  }

  ws.addEventListener('close', () => api.stop(), { once: true })
  ;(window as any).treecrdtSync = api
}
