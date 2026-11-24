import type { Operation } from '@treecrdt/interface'
import { VIEW_NODE_PREFIX } from '@treecrdt/interface/views'
import { type TreecrdtClient, createTreecrdtClient } from '@treecrdt/wa-sqlite'
import type ThoughtId from '../../../@types/ThoughtId'
import type Timestamp from '../../../@types/Timestamp'
import {
  ABSOLUTE_TOKEN,
  EM_TOKEN,
  GLOBAL_ROOT_TOKEN,
  HOME_TOKEN,
  ROOT_PARENT_ID,
  SETTINGS_TOKEN,
  SETTINGS_VALUE,
} from '../../../constants'
import hashThought from '../../../util/hashThought'
import type { DataProvider } from '../../DataProvider'
import { encodeThoughtPayload } from '../payload'
import createTreecrdtThoughtspace from '../runtime'
import createTreecrdtDataProvider from '../thoughtspace'

/** Initializes an isolated in-memory TreeCRDT client and thoughtspace for unit tests. */
const treecrdt = createTreecrdtThoughtspace()
const treecrdtThoughtspace = treecrdt.db

/** Initializes the bound in-memory test runtime. */
const initTestThoughtspace = async (): Promise<void> => {
  await treecrdt.init({ storage: 'memory' })
}

const PIN_ID = '00000000000000000000000000000101' as ThoughtId
const FALSE_ID = '00000000000000000000000000000102' as ThoughtId
const PIN_DUPLICATE_ID = '00000000000000000000000000000103' as ThoughtId
const PARENT_ID = '00000000000000000000000000000110' as ThoughtId
const OTHER_PARENT_ID = '00000000000000000000000000000111' as ThoughtId
const THOUGHT_A_ID = '00000000000000000000000000000112' as ThoughtId
const THOUGHT_Y_ID = '00000000000000000000000000000113' as ThoughtId
const THOUGHT_B_ID = '00000000000000000000000000000114' as ThoughtId
const THOUGHT_X_ID = '00000000000000000000000000000115' as ThoughtId
// The =favorite children that favorite the thoughts above.
const FAVORITE_A_ID = '00000000000000000000000000000122' as ThoughtId
const FAVORITE_Y_ID = '00000000000000000000000000000123' as ThoughtId
const FAVORITE_B_ID = '00000000000000000000000000000124' as ThoughtId
const FAVORITE_X_ID = '00000000000000000000000000000125' as ThoughtId
const FAVORITE_X_AGAIN_ID = '00000000000000000000000000000126' as ThoughtId

/** Creates a minimal thought fixture for provider-level ordering tests. */
const thought = (id: ThoughtId, parentId: ThoughtId, value: string, rank: number, created = 1) => ({
  id,
  parentId,
  value,
  rank,
  childrenMap: {},
  created: created as Timestamp,
  lastUpdated: created as Timestamp,
  updatedBy: 'test',
})

/** Persists thoughts through the real TreeCRDT data provider. */
const persistThoughtsTo = (
  db: Pick<DataProvider, 'updateThoughts'>,
  thoughts: ReturnType<typeof thought>[],
  movePlacements?: Record<ThoughtId, ThoughtId | null>,
) =>
  db.updateThoughts({
    thoughtIndexUpdates: Object.fromEntries(thoughts.map(thought => [thought.id, thought])),
    movePlacements,
  })

/** Persists thoughts through the shared test thoughtspace. */
const persistThoughts = (
  thoughts: ReturnType<typeof thought>[],
  movePlacements?: Record<ThoughtId, ThoughtId | null>,
) => persistThoughtsTo(treecrdtThoughtspace, thoughts, movePlacements)

/** A top-level thought and the =favorite child that favorites it, both created at `created`. */
const favorite = (thoughtId: ThoughtId, favoriteId: ThoughtId, created: number) => [
  thought(thoughtId, ROOT_PARENT_ID, `thought ${created}`, created, created),
  thought(favoriteId, thoughtId, '=favorite', 0, created),
]

/** Opens a device of the `docId` thoughtspace that holds `ops`, with a bound provider, closed when the test finishes. */
const openDevice = async (docId: string, replica: number, ops: Operation[] = []) => {
  const client = await createTreecrdtClient({ docId })
  const closers: (() => Promise<void>)[] = [() => client.drop()]
  onTestFinished(async () => {
    for (const close of closers.reverse()) await close()
  })
  if (ops.length > 0) await client.ops.appendMany(ops)
  const provider = createTreecrdtDataProvider()
  closers.push(await provider.bindClient(client, new Uint8Array(32).fill(replica)))
  return {
    client,
    db: provider.db,
    /** The Favorites Lexeme as this device reads it. */
    favorites: () => provider.db.getLexemeById(hashThought('=favorite')),
  }
}

/** Gives each client every op the other has. */
const exchangeOps = async (a: TreecrdtClient, b: TreecrdtClient) => {
  await b.ops.appendMany(await a.ops.all())
  await a.ops.appendMany(await b.ops.all())
}

/**
 * Opens devices `a` and `b` of one thoughtspace. Device `a` favorites thoughts A, B and X, created in that order, through
 * its provider, and `b` receives them.
 */
const openFavoritesDevices = async (docId: string) => {
  const a = await openDevice(docId, 1)
  const b = await openDevice(docId, 2)
  await persistThoughtsTo(a.db, [
    ...favorite(THOUGHT_A_ID, FAVORITE_A_ID, 10),
    ...favorite(THOUGHT_B_ID, FAVORITE_B_ID, 20),
    ...favorite(THOUGHT_X_ID, FAVORITE_X_ID, 30),
  ])
  await exchangeOps(a.client, b.client)
  return { a, b }
}

afterEach(async () => {
  await treecrdt.drop()
})

it('seeds fixed system thoughts in the TreeCRDT provider', async () => {
  await initTestThoughtspace()

  const em = await treecrdtThoughtspace.getThoughtById(EM_TOKEN)
  expect(em?.childrenMap[SETTINGS_TOKEN]).toBe(SETTINGS_TOKEN)

  const settings = await treecrdtThoughtspace.getThoughtById(SETTINGS_TOKEN)
  expect(settings).toMatchObject({
    id: SETTINGS_TOKEN,
    parentId: EM_TOKEN,
    value: SETTINGS_VALUE,
  })

  const settingsLexeme = await treecrdtThoughtspace.getLexemeById(hashThought(SETTINGS_VALUE))
  expect(settingsLexeme?.contexts).toEqual([SETTINGS_TOKEN])

  // Root payloads carry no Lexeme key.
  const roots = [GLOBAL_ROOT_TOKEN, HOME_TOKEN, EM_TOKEN, ABSOLUTE_TOKEN]
  await expect(treecrdtThoughtspace.getLexemesByIds(roots.map(hashThought))).resolves.toEqual(
    roots.map(() => undefined),
  )
})

it('does not write seed operations again when binding a seeded client', async () => {
  const client = await createTreecrdtClient({ docId: 'seeded-client' })
  const replicaId = new Uint8Array(32).fill(1)
  try {
    const close = await createTreecrdtDataProvider().bindClient(client, replicaId)
    const operations = await client.ops.all()
    await close()
    await createTreecrdtDataProvider().bindClient(client, replicaId)
    await expect(client.ops.all()).resolves.toEqual(operations)
  } finally {
    await client.drop()
  }
})

it('preserves requested order, duplicates, and missing entries when reading persisted thoughts and lexemes', async () => {
  await initTestThoughtspace()
  await persistThoughts([thought(PARENT_ID, EM_TOKEN, 'parent', 0)])

  await expect(treecrdtThoughtspace.getThoughtById(OTHER_PARENT_ID)).resolves.toBeUndefined()
  await expect(treecrdtThoughtspace.getLexemeById(hashThought('missing'))).resolves.toBeUndefined()

  const thoughts = await treecrdtThoughtspace.getThoughtsByIds([PARENT_ID, OTHER_PARENT_ID, SETTINGS_TOKEN, PARENT_ID])
  expect(thoughts.map(thought => thought?.id)).toEqual([PARENT_ID, undefined, SETTINGS_TOKEN, PARENT_ID])

  const lexemes = await treecrdtThoughtspace.getLexemesByIds(
    ['parent', 'missing', SETTINGS_VALUE, 'parent'].map(hashThought),
  )
  expect(lexemes.map(lexeme => lexeme?.contexts)).toEqual([[PARENT_ID], undefined, [SETTINGS_TOKEN], [PARENT_ID]])
})

it('does not delete persisted lexemes when freeing cache', async () => {
  await initTestThoughtspace()

  const settingsKey = hashThought(SETTINGS_VALUE)
  await treecrdtThoughtspace.freeLexeme(settingsKey)

  const settingsLexeme = await treecrdtThoughtspace.getLexemeById(settingsKey)
  expect(settingsLexeme?.contexts).toEqual([SETTINGS_TOKEN])
})

it('does not require an initialized TreeCRDT client when freeing lexeme cache', async () => {
  await expect(treecrdtThoughtspace.freeLexeme(hashThought('missing'))).resolves.toBeUndefined()
})

it('keys an attribute under its new parent and drops the key once it is renamed', async () => {
  await initTestThoughtspace()
  await persistThoughts([thought(PARENT_ID, EM_TOKEN, 'parent', 0), thought(OTHER_PARENT_ID, EM_TOKEN, 'other', 1)])
  await persistThoughts([
    thought(PIN_ID, PARENT_ID, '=pin', 0),
    thought(PIN_DUPLICATE_ID, PARENT_ID, '=pin', 1),
    thought(FALSE_ID, PARENT_ID, 'false', 2),
  ])

  const parent = await treecrdtThoughtspace.getThoughtById(PARENT_ID)
  expect(Object.entries(parent?.childrenMap ?? {})).toEqual([
    ['=pin', PIN_ID],
    [PIN_DUPLICATE_ID, PIN_DUPLICATE_ID],
    [FALSE_ID, FALSE_ID],
  ])

  await persistThoughts([thought(PIN_ID, OTHER_PARENT_ID, '=pin', 0)], { [PIN_ID]: null })
  expect((await treecrdtThoughtspace.getThoughtById(OTHER_PARENT_ID))?.childrenMap['=pin']).toBe(PIN_ID)

  await persistThoughts([thought(PIN_ID, OTHER_PARENT_ID, 'pin', 0)])
  expect((await treecrdtThoughtspace.getThoughtById(OTHER_PARENT_ID))?.childrenMap['=pin']).toBeUndefined()
})

it('falls back to rank placement when explicit afterId is stale', async () => {
  await initTestThoughtspace()

  await persistThoughts([thought(PARENT_ID, EM_TOKEN, 'parent', 0), thought(OTHER_PARENT_ID, EM_TOKEN, 'other', 1)])
  await persistThoughts([thought(THOUGHT_A_ID, PARENT_ID, 'a', 0)])
  await persistThoughts([thought(THOUGHT_Y_ID, PARENT_ID, 'y', 1)])
  await persistThoughts([thought(THOUGHT_B_ID, PARENT_ID, 'b', 2)])
  await persistThoughts([thought(THOUGHT_X_ID, PARENT_ID, 'x', 3)])

  await persistThoughts([thought(THOUGHT_Y_ID, OTHER_PARENT_ID, 'y', 0)], {
    [THOUGHT_Y_ID]: null,
  })

  await expect(
    persistThoughts([thought(THOUGHT_X_ID, PARENT_ID, 'x', 1)], {
      [THOUGHT_X_ID]: THOUGHT_Y_ID,
    }),
  ).resolves.toBeDefined()

  const parent = await treecrdtThoughtspace.getThoughtById(PARENT_ID)
  expect(Object.values(parent?.childrenMap ?? {})).toEqual([THOUGHT_A_ID, THOUGHT_X_ID, THOUGHT_B_ID])
})

it('excludes the moving thought from stale rank placement', async () => {
  await initTestThoughtspace()

  await persistThoughts([thought(PARENT_ID, EM_TOKEN, 'parent', 0), thought(OTHER_PARENT_ID, EM_TOKEN, 'other', 1)])
  await persistThoughts([thought(THOUGHT_X_ID, PARENT_ID, 'x', 0)])
  await persistThoughts([thought(THOUGHT_Y_ID, PARENT_ID, 'y', 1)])
  await persistThoughts([thought(THOUGHT_A_ID, PARENT_ID, 'a', 2)])

  await persistThoughts([thought(THOUGHT_Y_ID, OTHER_PARENT_ID, 'y', 0)], {
    [THOUGHT_Y_ID]: null,
  })

  await expect(
    persistThoughts([thought(THOUGHT_X_ID, PARENT_ID, 'x', 1)], {
      [THOUGHT_X_ID]: THOUGHT_Y_ID,
    }),
  ).resolves.toBeDefined()

  const parent = await treecrdtThoughtspace.getThoughtById(PARENT_ID)
  expect(Object.values(parent?.childrenMap ?? {})).toEqual([THOUGHT_X_ID, THOUGHT_A_ID])
})

// https://github.com/cybersemics/em/pull/4325#issuecomment-5248342036
it('reads sibling order once per thought when inserting a wide batch', async () => {
  const client = await createTreecrdtClient({ docId: 'wide-batch' })
  const provider = createTreecrdtDataProvider()

  try {
    await provider.bindClient(client, new Uint8Array(32).fill(1))
    await persistThoughtsTo(provider.db, [thought(PARENT_ID, EM_TOKEN, 'parent', 0)])

    const childIds = Array.from({ length: 40 }, (_, index) => (index + 512).toString(16).padStart(32, '0') as ThoughtId)
    const read = vi.spyOn(client.tree, 'read')

    await persistThoughtsTo(
      provider.db,
      childIds.map((id, index) => thought(id, PARENT_ID, `child-${index}`, index + 0.5)),
    )

    expect(read).toHaveBeenCalledTimes(childIds.length)
    const children = await client.tree.node(PARENT_ID).children()
    expect(children.map(child => child.id)).toEqual(childIds)
  } finally {
    await client.drop()
  }
})

it('queues writes issued before initialization and applies them to the bound client', async () => {
  let writeSettled = false
  const write = persistThoughts([thought(PARENT_ID, EM_TOKEN, 'queued', 0)]).finally(() => {
    writeSettled = true
  })

  await Promise.resolve()
  expect(writeSettled).toBe(false)

  await initTestThoughtspace()
  await expect(write).resolves.toBeDefined()
  await expect(treecrdtThoughtspace.getThoughtById(PARENT_ID)).resolves.toMatchObject({ value: 'queued' })
})

it('keeps separately created thoughtspace instances isolated', async () => {
  const first = createTreecrdtThoughtspace()
  const second = createTreecrdtThoughtspace()

  try {
    await first.init({ storage: 'memory' })
    await second.init({ storage: 'memory' })

    await persistThoughtsTo(first.db, [thought(PARENT_ID, EM_TOKEN, 'first', 0)])
    await persistThoughtsTo(second.db, [thought(PARENT_ID, EM_TOKEN, 'second', 0)])

    await expect(first.db.getThoughtById(PARENT_ID)).resolves.toMatchObject({ value: 'first' })
    await expect(second.db.getThoughtById(PARENT_ID)).resolves.toMatchObject({ value: 'second' })
  } finally {
    await first.drop()
    await second.drop()
  }
})

it('keeps a payload that is not a thought out of Lexemes and indexes later thoughts', async () => {
  const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const client = await createTreecrdtClient({ docId: 'undecodable-payload' })
  const replica = new Uint8Array(32).fill(1)
  try {
    const provider = createTreecrdtDataProvider()
    const close = await provider.bindClient(client, replica)
    // A peer's payload that is not a thought (corrupt, or not decryptable on this device yet) has no Lexeme key, so it
    // joins no Lexeme, and neither its write nor a later one fails.
    await client.local.insert(
      new Uint8Array(32).fill(2),
      client.tree.root.id,
      THOUGHT_X_ID,
      { type: 'last' },
      new TextEncoder().encode('not json'),
    )
    const later = encodeThoughtPayload(THOUGHT_Y_ID, { value: 'later', created: 1, lastUpdated: 1, updatedBy: 'test' })
    await client.local.insert(replica, client.tree.root.id, THOUGHT_Y_ID, { type: 'last' }, later)

    await expect(provider.db.getLexemeById(hashThought('later'))).resolves.toMatchObject({ contexts: [THOUGHT_Y_ID] })
    expect(report).not.toHaveBeenCalled()
    await close()
  } finally {
    report.mockRestore()
    await client.drop()
  }
})

it('syncs the Favorites order between devices, pinning every favorite with the first drag', async () => {
  const { a, b } = await openFavoritesDevices('favorites-sync')
  await expect(b.favorites()).resolves.toMatchObject({ contexts: [FAVORITE_A_ID, FAVORITE_B_ID, FAVORITE_X_ID] })

  // Device A drags X to the top. The first drag orders Favorites: the view's root and group nodes, references for A and
  // B where they show, and X's at the drop. The ops are returned, so live sync pushes them.
  const opsA = (await a.client.ops.all()).length
  const returned = await a.db.updateThoughts({
    thoughtIndexUpdates: {},
    favoriteMove: { id: FAVORITE_X_ID, before: FAVORITE_A_ID },
  })
  expect((await a.client.ops.all()).length - opsA).toBe(5)
  expect(returned).toHaveLength(5)
  await expect(a.favorites()).resolves.toMatchObject({ contexts: [FAVORITE_X_ID, FAVORITE_A_ID, FAVORITE_B_ID] })
  await exchangeOps(a.client, b.client)
  await expect(b.favorites()).resolves.toMatchObject({ contexts: [FAVORITE_X_ID, FAVORITE_A_ID, FAVORITE_B_ID] })

  // Device B drags A to the end: one move.
  const opsB = (await b.client.ops.all()).length
  await b.db.updateThoughts({ thoughtIndexUpdates: {}, favoriteMove: { id: FAVORITE_A_ID, before: null } })
  expect((await b.client.ops.all()).length - opsB).toBe(1)

  // Before syncing, device A (still showing X, A, B) drags B to the top. Only B moves, so A stays where device B put it.
  await a.db.updateThoughts({ thoughtIndexUpdates: {}, favoriteMove: { id: FAVORITE_B_ID, before: FAVORITE_X_ID } })
  await exchangeOps(a.client, b.client)
  await expect(a.favorites()).resolves.toMatchObject({ contexts: [FAVORITE_B_ID, FAVORITE_X_ID, FAVORITE_A_ID] })
  await expect(b.favorites()).resolves.toMatchObject({ contexts: [FAVORITE_B_ID, FAVORITE_X_ID, FAVORITE_A_ID] })

  // A new device that receives everything shows the same order and writes nothing of its own.
  const c = await openDevice('favorites-sync', 3, await a.client.ops.all())
  await expect(c.favorites()).resolves.toMatchObject({ contexts: [FAVORITE_B_ID, FAVORITE_X_ID, FAVORITE_A_ID] })
  expect((await c.client.ops.all()).length).toBe((await a.client.ops.all()).length)
})

it('keeps the place of a thought favorited again', async () => {
  const device = await openDevice('favorite-again', 1)
  await persistThoughtsTo(device.db, [
    ...favorite(THOUGHT_A_ID, FAVORITE_A_ID, 10),
    ...favorite(THOUGHT_B_ID, FAVORITE_B_ID, 20),
    ...favorite(THOUGHT_X_ID, FAVORITE_X_ID, 30),
  ])
  await device.db.updateThoughts({
    thoughtIndexUpdates: {},
    favoriteMove: { id: FAVORITE_X_ID, before: FAVORITE_A_ID },
  })
  await expect(device.favorites()).resolves.toMatchObject({ contexts: [FAVORITE_X_ID, FAVORITE_A_ID, FAVORITE_B_ID] })

  // Unfavoriting X deletes its =favorite child, and favoriting it again creates another. That one shows where X was
  // dragged, since the reference stands for X, and needs no reference of its own.
  await device.db.updateThoughts({ thoughtIndexUpdates: { [FAVORITE_X_ID]: null } })
  await expect(device.favorites()).resolves.toMatchObject({ contexts: [FAVORITE_A_ID, FAVORITE_B_ID] })
  const again = await persistThoughtsTo(device.db, [thought(FAVORITE_X_AGAIN_ID, THOUGHT_X_ID, '=favorite', 0, 40)])
  expect(again).toHaveLength(1)
  await expect(device.favorites()).resolves.toMatchObject({
    contexts: [FAVORITE_X_AGAIN_ID, FAVORITE_A_ID, FAVORITE_B_ID],
  })
})

it('gives a favorite added after the drag its reference where it lists, on both devices', async () => {
  const { a, b } = await openFavoritesDevices('favorite-added')
  await a.db.updateThoughts({ thoughtIndexUpdates: {}, favoriteMove: { id: FAVORITE_X_ID, before: FAVORITE_A_ID } })

  // Device A favorites Y, created between A and B: the two thoughts, then Y's reference where its created time lists it.
  // The reference is a create-only insert, so it never moves one that another device placed.
  const returned = (await persistThoughtsTo(a.db, favorite(THOUGHT_Y_ID, FAVORITE_Y_ID, 15))) as readonly Operation[]
  expect(returned.map(op => op.kind)).toMatchObject([
    { type: 'insert', node: THOUGHT_Y_ID },
    { type: 'insert', node: FAVORITE_Y_ID },
    { type: 'insert', ifAbsent: true },
  ])
  expect(returned[2].kind.node.startsWith(VIEW_NODE_PREFIX)).toBe(true)
  const order = [FAVORITE_X_ID, FAVORITE_A_ID, FAVORITE_Y_ID, FAVORITE_B_ID]
  await expect(a.favorites()).resolves.toMatchObject({ contexts: order })
  await exchangeOps(a.client, b.client)
  await expect(b.favorites()).resolves.toMatchObject({ contexts: order })
})

it('writes nothing on a device that only receives Favorites changes', async () => {
  const { a, b } = await openFavoritesDevices('favorites-receiver')
  const held = (await b.client.ops.all()).length
  const ordering = (await a.db.updateThoughts({
    thoughtIndexUpdates: {},
    favoriteMove: { id: FAVORITE_X_ID, before: FAVORITE_A_ID },
  })) as readonly Operation[]
  const added = (await persistThoughtsTo(a.db, favorite(THOUGHT_Y_ID, FAVORITE_Y_ID, 15))) as readonly Operation[]

  // Sync delivers Y before its reference. Device B lists Y where the reference goes, and leaves writing it to the device
  // that favorited Y.
  const order = [FAVORITE_X_ID, FAVORITE_A_ID, FAVORITE_Y_ID, FAVORITE_B_ID]
  await b.client.ops.appendMany([...ordering, ...added.slice(0, 2)])
  await expect(b.favorites()).resolves.toMatchObject({ contexts: order })
  await b.client.ops.appendMany(added.slice(2))
  await expect(b.favorites()).resolves.toMatchObject({ contexts: order })
  expect((await b.client.ops.all()).length).toBe(held + ordering.length + added.length)
})
