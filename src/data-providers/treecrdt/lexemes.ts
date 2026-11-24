import type { Operation } from '@treecrdt/interface'
import { createTreecrdtView } from '@treecrdt/interface/views'
import type { TreecrdtClient } from '@treecrdt/wa-sqlite'
import type Lexeme from '../../@types/Lexeme'
import type ThoughtId from '../../@types/ThoughtId'
import type Timestamp from '../../@types/Timestamp'
import { GLOBAL_ROOT_TOKEN } from '../../constants'
import hashThought from '../../util/hashThought'
import { decodeThoughtPayload } from './payload'
import { SYSTEM_ROOT_THOUGHT_IDS } from './systemThoughtIds'
import { createTreecrdtLocalWriteOptions } from './writeBarrier'

const ROOT_IDS = new Set<string>([GLOBAL_ROOT_TOKEN, ...SYSTEM_ROOT_THOUGHT_IDS])
const FAVORITES = hashThought('=favorite')

type Metadata = Pick<Lexeme, 'created' | 'lastUpdated' | 'updatedBy'>

/** Indexes (into `positions`) of one longest increasing subsequence: the members a reorder can leave in place. */
const longestIncreasing = (positions: number[]): Set<number> => {
  const tails: number[] = []
  const previous: number[] = []
  positions.forEach((position, i) => {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (positions[tails[mid]] < position) lo = mid + 1
      else hi = mid
    }
    previous[i] = lo > 0 ? tails[lo - 1] : -1
    tails[lo] = i
  })
  const kept = new Set<number>()
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = previous[i]) kept.add(i)
  return kept
}

/**
 * Lexemes are a TreeCRDT view. Membership is derived from each thought's value on this device and is never written as
 * operations. Order is replicated: a member the user placed has one record in TreeCRDT, the rest sort by created time.
 */
const createLexemeIndex = async (client: TreecrdtClient, replica: Uint8Array) => {
  const view = await createTreecrdtView(client, {
    name: 'em-lexemes',
    version: 1,
    replica,
    keys: ({ id, payload }) => (ROOT_IDS.has(id) ? [] : [hashThought(decodeThoughtPayload(payload).value)]),
    // The view clamps the rank, so an odd created time (a pasted Roam create-time, say) cannot stall indexing.
    rank: ({ payload }) => Number(decodeThoughtPayload(payload).created),
    data: ({ payload }): Metadata => {
      const { created, lastUpdated, updatedBy } = decodeThoughtPayload(payload)
      return { created: created as Timestamp, lastUpdated: lastUpdated as Timestamp, updatedBy }
    },
    // Tag order writes like the app's other writes, so the readback treats them as local.
    writeOptions: createTreecrdtLocalWriteOptions,
    onError: (error, node) => console.error('TreeCRDT derived indexing skipped a thought', node, error),
  })

  /** Assembles Lexemes in display order, preserving requested key order. */
  const getLexemesByIds = async (keys: string[]): Promise<(Lexeme | undefined)[]> => {
    if (keys.length === 0) return []
    const groups = await view.members(keys)
    return keys.map(key => {
      const members = groups.get(key)
      if (!members?.length) return undefined
      let created = Infinity
      let newest: { id: string; data: Metadata } | undefined
      for (const member of members) {
        const data = member.data as Metadata
        created = Math.min(created, data.created)
        // Like the former SQL read: the newest lastUpdated, ties going to the later (created, id).
        if (
          !newest ||
          data.lastUpdated > newest.data.lastUpdated ||
          (data.lastUpdated === newest.data.lastUpdated &&
            (data.created > newest.data.created || (data.created === newest.data.created && member.id > newest.id)))
        )
          newest = { id: member.id, data }
      }
      return {
        contexts: members.map(member => member.id as ThoughtId),
        created: created as Timestamp,
        lastUpdated: newest!.data.lastUpdated,
        updatedBy: newest!.data.updatedBy,
      }
    })
  }

  /** A Favorites drag: one record for the moved favorite. */
  const moveFavorite = (id: ThoughtId, before: ThoughtId | null): Promise<Operation[]> =>
    view.place(FAVORITES, id, before)

  /**
   * Writes a record for each member that the requested Favorites order moves, and none for the members it keeps in
   * place. Callers that know the drag should use moveFavorite: a list read from a stale order moves members nobody
   * dragged.
   */
  const setFavoriteOrder = async (contexts: ThoughtId[]): Promise<Operation[]> => {
    await view.subscription.settled()
    const current = ((await view.members([FAVORITES])).get(FAVORITES) ?? []).map(member => member.id)
    const position = new Map(current.map((id, i) => [id, i]))
    // Members the caller did not list keep their relative order after the listed ones.
    const listed = [...new Set<string>(contexts)].filter(id => position.has(id))
    const wanted = [...listed, ...current.filter(id => !listed.includes(id))]
    const kept = longestIncreasing(wanted.map(id => position.get(id)!))
    const ops: Operation[] = []
    // Right to left, so each member is placed before a successor that is already where it will stay. A member that
    // left meanwhile (a remote unfavorite) is skipped, and the next listed member that is still there takes its place.
    for (let i = wanted.length - 1; i >= 0; i--) {
      if (kept.has(i)) continue
      const live = new Set(((await view.members([FAVORITES])).get(FAVORITES) ?? []).map(member => member.id))
      if (!live.has(wanted[i])) continue
      const before = wanted.slice(i + 1).find(id => live.has(id)) ?? null
      ops.push(...(await view.place(FAVORITES, wanted[i], before)))
    }
    return ops
  }

  return { view, getLexemesByIds, moveFavorite, setFavoriteOrder }
}

export default createLexemeIndex
