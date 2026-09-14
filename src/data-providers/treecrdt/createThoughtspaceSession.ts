import type { TreecrdtClient } from '@treecrdt/wa-sqlite'
import type Index from '../../@types/IndexType'
import type ThoughtId from '../../@types/ThoughtId'
import { GLOBAL_ROOT_TOKEN } from '../../constants'
import hashThought from '../../util/hashThought'
import timestamp from '../../util/timestamp'
import { SYSTEM_ROOT_THOUGHT_IDS } from './systemThoughtIds'
import createTreecrdtDataProvider from './thoughtspace'

type Mutation =
  | { type: 'create'; id: ThoughtId; parentId: ThoughtId; after: ThoughtId | null; value: string }
  | { type: 'edit'; id: ThoughtId; value: string }
  | { type: 'delete'; id: ThoughtId }

type View = {
  /** Missing keys are unloaded; null means the thought was read and does not exist. */
  values: Readonly<Index<string | null>>
  lexemes: Readonly<Index<{ readonly contexts: readonly ThoughtId[]; readonly complete: boolean }>>
}

type PendingWrite = {
  readonly writeId: number
  readonly mutation: Readonly<Mutation>
  readonly status: 'pending' | 'failed'
  readonly error?: unknown
}

type Snapshot = {
  /** Counts committed reads, not pending edits, CRDT time, or remote-sync acknowledgements. */
  readonly revision: number
  readonly committed: Readonly<View>
  readonly pending: readonly PendingWrite[]
  readonly view: Readonly<View>
}

/**
 * Experimental text/membership session, not connected to Redux.
 * Borrows an initialized client exclusively: all reads and writes must go through this session.
 * There is no inbound sync, optimistic tree projection, or subtree deletion in this prototype.
 * Closing detaches the provider; the caller still owns the client's storage lifetime.
 */
const createThoughtspaceSession = async ({
  client,
  replicaId,
  updatedBy,
}: {
  client: TreecrdtClient
  replicaId: Uint8Array
  updatedBy: string
}) => {
  const provider = createTreecrdtDataProvider()
  const unbind = await provider.bindClient(client, replicaId)
  const db = provider.db
  let committed: View = { values: {}, lexemes: {} }
  let pending: readonly PendingWrite[] = []
  let revision = 0
  let nextWriteId = 0
  let closed = false
  let closing: Promise<void> | undefined
  let tail = Promise.resolve()
  let snapshot: Snapshot = { revision, committed, pending, view: committed }
  const listeners = new Set<() => void>()

  /** Publishes the current committed cache with only the latest pending intent for each thought overlaid. */
  const publish = () => {
    const values = { ...committed.values }
    const lexemes = { ...committed.lexemes }
    const latest = new Map(pending.map(write => [write.mutation.id, write.mutation]))
    latest.forEach(mutation => {
      const value = mutation.type === 'delete' ? null : mutation.value
      const key = value === null ? null : hashThought(value)
      values[mutation.id] = value
      Object.entries(lexemes).forEach(([otherKey, lexeme]) => {
        if (otherKey !== key && lexeme.contexts.includes(mutation.id)) {
          lexemes[otherKey] = { ...lexeme, contexts: lexeme.contexts.filter(id => id !== mutation.id) }
        }
      })
      if (key !== null && !lexemes[key]?.contexts.includes(mutation.id)) {
        lexemes[key] = {
          contexts: [...(lexemes[key]?.contexts ?? []), mutation.id],
          // An optimistic occurrence does not prove there are no unloaded occurrences.
          complete: lexemes[key]?.complete ?? false,
        }
      }
    })
    snapshot = { revision, committed, pending, view: { values, lexemes } }
    if (!closed) listeners.forEach(listener => listener())
  }

  /** Serializes provider I/O without delaying optimistic publication; a failure pauses further I/O. */
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(() => {
      if (closed) throw new Error('Thoughtspace session is closed')
      return work()
    })
    tail = result.then(() => undefined)
    // The public promise reports the failure. Keep the queue rejected until this session is closed.
    void tail.catch(() => undefined)
    return result
  }

  /** Reads a committed text/membership slice while this session's write queue cannot advance. */
  const read = async (ids: readonly ThoughtId[], extraKeys: readonly string[] = []): Promise<View> => {
    const entries = await Promise.all(
      ids.map(async id => {
        // Deleted nodes retain payload bytes, so a payload read alone is not an existence check.
        const thought = (await client.tree.exists(id)) ? await db.getThoughtById(id) : undefined
        return [id, thought?.value ?? null] as const
      }),
    )
    const keys = [
      ...new Set([
        ...extraKeys,
        ...ids.flatMap(id => (typeof committed.values[id] === 'string' ? [hashThought(committed.values[id])] : [])),
        ...entries.flatMap(([, value]) => (value === null ? [] : [hashThought(value)])),
      ]),
    ]
    const lexemes = await db.getLexemesByIds(keys)
    return {
      values: { ...committed.values, ...Object.fromEntries(entries) },
      lexemes: {
        ...committed.lexemes,
        ...Object.fromEntries(keys.map((key, i) => [key, { contexts: lexemes[i]?.contexts ?? [], complete: true }])),
      },
    }
  }

  return {
    /** Returns one stable snapshot until the next publication. */
    getSnapshot: (): Snapshot => snapshot,

    /** Subscribes to pending edits and committed results without importing the app's Redux store. */
    subscribe: (listener: () => void) => {
      if (closed) throw new Error('Thoughtspace session is closed')
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    /** Loads complete memberships for the requested thoughts, retaining any edits submitted during the read. */
    load: (ids: readonly ThoughtId[]): Promise<void> => {
      const input = [...ids]
      return enqueue(async () => {
        committed = await read(input)
        revision += 1
        publish()
      })
    },

    /** Applies an intent immediately to the view and returns its exact local-storage completion. */
    apply: (input: Mutation) => {
      if (closed) throw new Error('Thoughtspace session is closed')
      if (input.id === GLOBAL_ROOT_TOKEN || SYSTEM_ROOT_THOUGHT_IDS.includes(input.id)) {
        throw new Error('System roots cannot be changed through this session')
      }
      const mutation = { ...input }
      const writeId = ++nextWriteId
      const now = timestamp()
      pending = [...pending, { writeId, mutation, status: 'pending' }]

      const work = enqueue(async () => {
        const exists = await client.tree.exists(mutation.id)
        const thought = exists ? await db.getThoughtById(mutation.id) : undefined
        const keys = thought ? [hashThought(thought.value)] : []
        if (mutation.type !== 'delete') keys.push(hashThought(mutation.value))

        if (mutation.type === 'create') {
          if (exists) throw new Error(`Thought ${mutation.id} already exists`)
          if (!(await client.tree.exists(mutation.parentId))) throw new Error('The parent does not exist')
          const siblings = await client.tree.children(mutation.parentId)
          if (mutation.after !== null && !siblings.includes(mutation.after)) {
            throw new Error('The placement anchor is not a child of the parent')
          }
          await db.updateThoughts({
            thoughtIndexUpdates: {
              [mutation.id]: {
                id: mutation.id,
                parentId: mutation.parentId,
                childrenMap: {},
                rank: mutation.after === null ? 0 : siblings.indexOf(mutation.after) + 1,
                value: mutation.value,
                created: now,
                lastUpdated: now,
                updatedBy,
              },
            },
            movePlacements: { [mutation.id]: mutation.after },
            lexemeIndexUpdates: {},
          })
        } else if (mutation.type === 'edit') {
          if (!thought) throw new Error(`Thought ${mutation.id} does not exist`)
          if (thought.value !== mutation.value) {
            await db.updateThoughts({
              thoughtIndexUpdates: {
                [mutation.id]: { ...thought, value: mutation.value, lastUpdated: now, updatedBy },
              },
              lexemeIndexUpdates: {},
            })
          }
        } else if (exists) {
          if ((await client.tree.children(mutation.id)).length > 0) {
            throw new Error('Subtree deletion is not supported by this prototype')
          }
          await db.updateThoughts({ thoughtIndexUpdates: { [mutation.id]: null }, lexemeIndexUpdates: {} })
        }

        return read([mutation.id], keys)
      })
      const done = work.then(
        view => {
          committed = view
          revision += 1
          pending = pending.filter(write => write.writeId !== writeId)
          publish()
          return { writeId, revision }
        },
        error => {
          pending = pending.map(write => (write.writeId === writeId ? { ...write, status: 'failed', error } : write))
          publish()
          throw error
        },
      )
      publish()
      return { writeId, done }
    },

    /** Stops publication, rejects work that has not started, and detaches after in-flight work settles. */
    close: (): Promise<void> => {
      if (closing) return closing
      closed = true
      listeners.clear()
      closing = tail.catch(() => undefined).then(unbind)
      return closing
    },
  }
}

export default createThoughtspaceSession
