import { type TreecrdtClient, createTreecrdtClient } from '@treecrdt/wa-sqlite'
import { clearActionCreator as clear } from '../../actions/clear'
import { importTextActionCreator as importText } from '../../actions/importText'
import { pullActionCreator as pull } from '../../actions/pull'
import { redoActionCreator as redo } from '../../actions/redo'
import { undoActionCreator as undo } from '../../actions/undo'
import { updateThoughtsActionCreator as updateThoughts } from '../../actions/updateThoughts'
import { HOME_TOKEN } from '../../constants'
import db from '../../data-providers/thoughtspace'
import { waitForTreecrdtWriteBarrier } from '../../data-providers/treecrdt/writeBarrier'
import getLexeme from '../../selectors/getLexeme'
import store from '../../stores/app'
import contextToThought from '../../test-helpers/contextToThought'
import { editThoughtByContextActionCreator as editThought } from '../../test-helpers/editThoughtByContext'
import initStore from '../../test-helpers/initStore'
import waitForThoughtspaceIdle from '../../test-helpers/waitForThoughtspaceIdle'

vi.mock('@treecrdt/wa-sqlite', async importOriginal => {
  const actual = await importOriginal<typeof import('@treecrdt/wa-sqlite')>()
  return { ...actual, createTreecrdtClient: vi.fn(actual.createTreecrdtClient) }
})

let client: TreecrdtClient

/** Controls an external I/O boundary without replacing provider or Redux behavior. */
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(complete => {
    resolve = complete
  })
  return { promise, resolve }
}

beforeEach(async () => {
  await initStore()
  client = await vi.mocked(createTreecrdtClient).mock.results.at(-1)!.value
})

afterEach(async () => {
  await waitForThoughtspaceIdle()
  vi.restoreAllMocks()
})

it('confirms unloaded memberships after rename, undo, and redo through the real Redux provider path', async () => {
  store.dispatch(importText({ text: '- other\n  - branch\n    - hidden\n      - cat\n- dog' }))
  await waitForThoughtspaceIdle()
  const hidden = contextToThought(store.getState(), ['other', 'branch', 'hidden', 'cat'])!
  const edited = contextToThought(store.getState(), ['dog'])!
  store.dispatch(clear())
  await store.dispatch(pull([HOME_TOKEN], { maxDepth: 1 }))
  expect(store.getState().thoughts.thoughtIndex[hidden.id]).toBeUndefined()
  expect(getLexeme(store.getState(), 'cat')).toBeUndefined()

  store.dispatch(editThought(['dog'], 'cat'))
  expect(getLexeme(store.getState(), 'cat')?.contexts).toEqual([edited.id])
  await waitForThoughtspaceIdle()
  expect(getLexeme(store.getState(), 'cat')?.contexts.slice().sort()).toEqual([hidden.id, edited.id].sort())
  expect(store.getState().pendingThoughtWrites).toEqual({})

  store.dispatch(undo())
  await waitForThoughtspaceIdle()
  expect(getLexeme(store.getState(), 'cat')?.contexts).toEqual([hidden.id])
  await expect(db.getThoughtById(edited.id)).resolves.toMatchObject({ value: 'dog' })

  store.dispatch(redo())
  await waitForThoughtspaceIdle()
  expect(getLexeme(store.getState(), 'cat')?.contexts.slice().sort()).toEqual([hidden.id, edited.id].sort())
  await expect(db.getThoughtById(edited.id)).resolves.toMatchObject({ value: 'cat' })
})

it('applies an older completion beneath a newer pending edit', async () => {
  store.dispatch(importText({ text: '- cat' }))
  await waitForThoughtspaceIdle()
  const thought = contextToThought(store.getState(), ['cat'])!
  const firstStarted = deferred()
  const firstReleased = deferred()
  const secondStarted = deferred()
  const secondReleased = deferred()
  const payload = client.local.payload.bind(client.local)
  vi.spyOn(client.local, 'payload')
    .mockImplementationOnce(async (...args) => {
      firstStarted.resolve()
      await firstReleased.promise
      return payload(...args)
    })
    .mockImplementationOnce(async (...args) => {
      secondStarted.resolve()
      await secondReleased.promise
      return payload(...args)
    })

  store.dispatch(editThought(['cat'], 'dog'))
  await firstStarted.promise
  store.dispatch(editThought(['dog'], 'bird'))
  firstReleased.resolve()
  await secondStarted.promise
  const during = store.getState()
  secondReleased.resolve()
  await waitForThoughtspaceIdle()

  expect(during.pendingThoughtWrites[thought.id].thought?.value).toBe('bird')
  expect(getLexeme(during, 'bird')?.contexts).toEqual([thought.id])
  expect(getLexeme(during, 'dog')).toBeUndefined()
  expect(store.getState().pendingThoughtWrites).toEqual({})
  await expect(db.getThoughtById(thought.id)).resolves.toMatchObject({ value: 'bird' })
})

it('acknowledges a no-op without requiring a materialization event', async () => {
  store.dispatch(importText({ text: '- cat' }))
  await waitForThoughtspaceIdle()
  const thought = contextToThought(store.getState(), ['cat'])!
  const operations = await client.ops.all()

  store.dispatch(updateThoughts({ thoughtIndexUpdates: { [thought.id]: thought } }))
  expect(store.getState().pendingThoughtWrites[thought.id]).toBeDefined()
  await waitForThoughtspaceIdle()

  expect(store.getState().pendingThoughtWrites).toEqual({})
  expect(await client.ops.all()).toEqual(operations)
})

it('retains a failed edit until a later successful edit supersedes it', async () => {
  store.dispatch(importText({ text: '- cat' }))
  await waitForThoughtspaceIdle()
  const thought = contextToThought(store.getState(), ['cat'])!
  const failure = new Error('disk write failed')
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(client.local, 'payload').mockRejectedValueOnce(failure)

  store.dispatch(editThought(['cat'], 'dog'))
  await expect(waitForTreecrdtWriteBarrier()).rejects.toBe(failure)
  expect(store.getState().pendingThoughtWrites[thought.id]).toMatchObject({
    thought: { value: 'dog' },
    error: String(failure),
  })
  expect(getLexeme(store.getState(), 'dog')?.contexts).toEqual([thought.id])
  await expect(db.getThoughtById(thought.id)).resolves.toMatchObject({ value: 'cat' })

  store.dispatch(editThought(['dog'], 'bird'))
  await waitForThoughtspaceIdle()
  expect(store.getState().pendingThoughtWrites).toEqual({})
  expect(getLexeme(store.getState(), 'dog')).toBeUndefined()
  await expect(db.getThoughtById(thought.id)).resolves.toMatchObject({ value: 'bird' })
})

it('does not publish a previous generation after clearing Redux during a write', async () => {
  store.dispatch(importText({ text: '- cat' }))
  await waitForThoughtspaceIdle()
  const started = deferred()
  const released = deferred()
  const payload = client.local.payload.bind(client.local)
  vi.spyOn(client.local, 'payload').mockImplementationOnce(async (...args) => {
    started.resolve()
    await released.promise
    return payload(...args)
  })

  store.dispatch(editThought(['cat'], 'dog'))
  await started.promise
  store.dispatch(clear())
  released.resolve()
  await waitForThoughtspaceIdle()

  expect(store.getState().pendingThoughtWrites).toEqual({})
  expect(getLexeme(store.getState(), 'dog')).toBeUndefined()
})
