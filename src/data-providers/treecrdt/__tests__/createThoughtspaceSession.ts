import { type TreecrdtClient, createTreecrdtClient } from '@treecrdt/wa-sqlite'
import type ThoughtId from '../../../@types/ThoughtId'
import { HOME_TOKEN } from '../../../constants'
import hashThought from '../../../util/hashThought'
import createThoughtspaceSession from '../createThoughtspaceSession'

const A = '00000000000000000000000000000501' as ThoughtId
const B = '00000000000000000000000000000502' as ThoughtId
const replicaId = new Uint8Array(32).fill(5)
let client: TreecrdtClient
let session: Awaited<ReturnType<typeof createThoughtspaceSession>>

beforeEach(async () => {
  client = await createTreecrdtClient({ storage: { type: 'memory' }, runtime: { type: 'direct' } })
  session = await createThoughtspaceSession({ client, replicaId, updatedBy: 'test' })
})

afterEach(async () => {
  try {
    await session.close()
  } finally {
    await client.drop()
    vi.restoreAllMocks()
  }
})

it('derives unloaded contexts through create, rename, and delete without accepting lexeme writes', async () => {
  await session.apply({ type: 'create', id: A, parentId: HOME_TOKEN, after: null, value: 'Cats' }).done
  await session.close()
  session = await createThoughtspaceSession({ client, replicaId, updatedBy: 'test' })
  expect(session.getSnapshot().view.values[A]).toBeUndefined()

  const create = session.apply({ type: 'create', id: B, parentId: HOME_TOKEN, after: A, value: 'cat' })
  expect(session.getSnapshot().view.lexemes[hashThought('cat')]).toEqual({ contexts: [B], complete: false })
  await create.done
  expect(session.getSnapshot().view.lexemes[hashThought('cat')]).toEqual({ contexts: [A, B], complete: true })
  // Membership is complete without loading the other thought's text into the cache.
  expect(session.getSnapshot().committed.values[A]).toBeUndefined()

  const edit = session.apply({ type: 'edit', id: B, value: 'dog' })
  expect(session.getSnapshot().view.values[B]).toBe('dog')
  expect(session.getSnapshot().view.lexemes[hashThought('cat')]).toEqual({ contexts: [A], complete: true })
  await edit.done
  expect(session.getSnapshot().committed.lexemes[hashThought('dog')]).toEqual({ contexts: [B], complete: true })

  const remove = session.apply({ type: 'delete', id: B })
  expect(session.getSnapshot().view.values[B]).toBeNull()
  await remove.done
  expect(session.getSnapshot().committed.values[B]).toBeNull()
  expect(session.getSnapshot().committed.lexemes[hashThought('dog')]).toEqual({ contexts: [], complete: true })
  expect(session.getSnapshot().committed.lexemes[hashThought('cat')]).toEqual({ contexts: [A], complete: true })
  expect(session.getSnapshot().pending).toEqual([])
})

it('publishes an older read beneath a newer pending edit instead of retrying the read', async () => {
  await session.apply({ type: 'create', id: A, parentId: HOME_TOKEN, after: null, value: 'cat' }).done
  let markReadStarted!: () => void
  let releaseRead!: () => void
  const readStarted = new Promise<void>(resolve => {
    markReadStarted = resolve
  })
  const readReleased = new Promise<void>(resolve => {
    releaseRead = resolve
  })
  const getPayload = client.tree.getPayload.bind(client.tree)
  const readPayload = vi.spyOn(client.tree, 'getPayload').mockImplementationOnce(async id => {
    const bytes = await getPayload(id)
    markReadStarted()
    await readReleased
    return bytes
  })

  const load = session.load([A])
  await readStarted
  const edit = session.apply({ type: 'edit', id: A, value: 'dog' })
  releaseRead()
  await load

  expect(readPayload).toHaveBeenCalledTimes(1)
  expect(session.getSnapshot().committed.values[A]).toBe('cat')
  expect(session.getSnapshot().view.values[A]).toBe('dog')
  expect(session.getSnapshot().view.lexemes[hashThought('cat')].contexts).toEqual([])
  await edit.done
  expect(session.getSnapshot().committed.values[A]).toBe('dog')
})

it('acknowledges dog without clearing the newer bird edit', async () => {
  await session.apply({ type: 'create', id: A, parentId: HOME_TOKEN, after: null, value: 'cat' }).done
  let markBirdStarted!: () => void
  let releaseBird!: () => void
  const birdStarted = new Promise<void>(resolve => {
    markBirdStarted = resolve
  })
  const birdReleased = new Promise<void>(resolve => {
    releaseBird = resolve
  })
  const payload = client.local.payload.bind(client.local)
  vi.spyOn(client.local, 'payload')
    .mockImplementationOnce(payload)
    .mockImplementationOnce(async (...args) => {
      markBirdStarted()
      await birdReleased
      return payload(...args)
    })

  const dog = session.apply({ type: 'edit', id: A, value: 'dog' })
  const bird = session.apply({ type: 'edit', id: A, value: 'bird' })
  const displayed: (string | null)[] = []
  const unsubscribe = session.subscribe(() => {
    displayed.push(session.getSnapshot().view.values[A])
  })
  await birdStarted

  expect(await dog.done).toEqual({ writeId: dog.writeId, revision: 2 })
  expect(session.getSnapshot().committed.values[A]).toBe('dog')
  expect(session.getSnapshot().view.values[A]).toBe('bird')
  expect(session.getSnapshot().pending.map(write => write.writeId)).toEqual([bird.writeId])
  expect(session.getSnapshot().view.lexemes[hashThought('dog')].contexts).toEqual([])

  releaseBird()
  expect(await bird.done).toEqual({ writeId: bird.writeId, revision: 3 })
  expect(session.getSnapshot().pending).toEqual([])
  expect(session.getSnapshot().committed.values[A]).toBe('bird')
  expect(displayed).toEqual(['bird', 'bird'])
  unsubscribe()
})

it('completes a no-op edit even though storage emits no operation', async () => {
  await session.apply({ type: 'create', id: A, parentId: HOME_TOKEN, after: null, value: 'cat' }).done
  const counter = await client.meta.replicaMaxCounter(replicaId)
  const edit = session.apply({ type: 'edit', id: A, value: 'cat' })

  expect(await edit.done).toEqual({ writeId: edit.writeId, revision: 2 })
  expect(session.getSnapshot().pending).toEqual([])
  expect(await client.meta.replicaMaxCounter(replicaId)).toBe(counter)
})

it('retains failed edits as unsaved and does not commit later writes over the failure', async () => {
  await session.apply({ type: 'create', id: A, parentId: HOME_TOKEN, after: null, value: 'cat' }).done
  const counter = await client.meta.replicaMaxCounter(replicaId)
  const failure = new Error('storage write failed')
  vi.spyOn(client.local, 'payload').mockRejectedValueOnce(failure)

  const dog = session.apply({ type: 'edit', id: A, value: 'dog' })
  const bird = session.apply({ type: 'edit', id: A, value: 'bird' })
  await Promise.all([expect(dog.done).rejects.toBe(failure), expect(bird.done).rejects.toBe(failure)])

  expect(session.getSnapshot().committed.values[A]).toBe('cat')
  expect(session.getSnapshot().view.values[A]).toBe('bird')
  expect(session.getSnapshot().pending).toEqual([
    { writeId: dog.writeId, mutation: { type: 'edit', id: A, value: 'dog' }, status: 'failed', error: failure },
    { writeId: bird.writeId, mutation: { type: 'edit', id: A, value: 'bird' }, status: 'failed', error: failure },
  ])
  expect(await client.meta.replicaMaxCounter(replicaId)).toBe(counter)
})

it('closes during a read without publishing to detached listeners or starting a queued write', async () => {
  await session.apply({ type: 'create', id: A, parentId: HOME_TOKEN, after: null, value: 'cat' }).done
  const counter = await client.meta.replicaMaxCounter(replicaId)
  let markReadStarted!: () => void
  let releaseRead!: () => void
  const readStarted = new Promise<void>(resolve => {
    markReadStarted = resolve
  })
  const readReleased = new Promise<void>(resolve => {
    releaseRead = resolve
  })
  const getPayload = client.tree.getPayload.bind(client.tree)
  vi.spyOn(client.tree, 'getPayload').mockImplementationOnce(async id => {
    const bytes = await getPayload(id)
    markReadStarted()
    await readReleased
    return bytes
  })
  const listener = vi.fn()
  session.subscribe(listener)

  const load = session.load([A])
  await readStarted
  const edit = session.apply({ type: 'edit', id: A, value: 'dog' })
  const rejectedWrite = expect(edit.done).rejects.toThrow('Thoughtspace session is closed')
  const close = session.close()
  listener.mockClear()
  releaseRead()
  await Promise.all([load, rejectedWrite, close])

  expect(listener).not.toHaveBeenCalled()
  expect(await client.meta.replicaMaxCounter(replicaId)).toBe(counter)
  expect(() => session.apply({ type: 'edit', id: A, value: 'bird' })).toThrow('Thoughtspace session is closed')
})

it('rejects subtree deletion rather than pretending the prototype projects unloaded descendants', async () => {
  await session.apply({ type: 'create', id: A, parentId: HOME_TOKEN, after: null, value: 'parent' }).done
  await session.apply({ type: 'create', id: B, parentId: A, after: null, value: 'child' }).done

  await expect(session.apply({ type: 'delete', id: A }).done).rejects.toThrow('Subtree deletion is not supported')
  expect(await client.tree.children(HOME_TOKEN)).toEqual([A])
  expect(await client.tree.children(A)).toEqual([B])
})
