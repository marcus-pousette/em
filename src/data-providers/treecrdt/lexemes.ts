import type { Operation } from '@treecrdt/interface'
import { createTreecrdtView } from '@treecrdt/interface/views'
import type { TreecrdtClient } from '@treecrdt/wa-sqlite'
import type Lexeme from '../../@types/Lexeme'
import type ThoughtId from '../../@types/ThoughtId'
import type Timestamp from '../../@types/Timestamp'
import hashThought from '../../util/hashThought'
import { LEXEME_PATH, decodeThoughtPayload } from './payload'
import { createTreecrdtLocalWriteOptions } from './writeBarrier'

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
 * Lexemes are a TreeCRDT view whose groups are the Lexeme keys in thought payloads. SQLite indexes the key in the write
 * that sets the value, so a Lexeme always matches the values and nothing derives or stores its contexts. Unordered
 * Lexemes list their contexts by created time. The first drag orders a Lexeme: it becomes a subtree of the document,
 * with a reference node per context's parent that is ordered like any thought.
 */
const createLexemeIndex = async (client: TreecrdtClient, replica: Uint8Array) => {
  const view = await createTreecrdtView(client, {
    name: 'em-lexemes',
    index: { name: 'em_lexemes', path: LEXEME_PATH },
    replica,
    // A Favorites reference is the favorited thought, so a thought favorited again keeps its place.
    reference: 'parent',
    // The view clamps the rank, so an odd created time (a pasted Roam create-time, say) still lists.
    rank: ({ payload }) => Number(decodeThoughtPayload(payload).created),
    data: ({ payload }): Metadata => {
      const { created, lastUpdated, updatedBy } = decodeThoughtPayload(payload)
      return { created: created as Timestamp, lastUpdated: lastUpdated as Timestamp, updatedBy }
    },
    // Tag the view's writes like the app's other writes, so the readback treats them as local.
    writeOptions: createTreecrdtLocalWriteOptions,
    onError: (error, node) => console.error('TreeCRDT Lexeme view skipped a thought', node, error),
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

  /** A Favorites drag. The first one orders Favorites, pinning every favorite where it shows. */
  const moveFavorite = (id: ThoughtId, before: ThoughtId | null): Promise<Operation[]> =>
    view.place(FAVORITES, id, { before })

  /**
   * Moves each member that the requested Favorites order moves, and none of the members it keeps in place. Callers that
   * know the drag should use moveFavorite: a list read from a stale order moves members nobody dragged.
   */
  const setFavoriteOrder = async (contexts: ThoughtId[]): Promise<Operation[]> => {
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
      ops.push(...(await view.place(FAVORITES, wanted[i], { before })))
    }
    return ops
  }

  /**
   * Writes a reference for each context of an ordered Lexeme that has none, such as a new favorite, where it lists now.
   * Call it after this device's own writes, so a device that only receives writes nothing.
   */
  const repair = (): Promise<Operation[]> => view.repair()

  return { view, getLexemesByIds, moveFavorite, setFavoriteOrder, repair }
}

export default createLexemeIndex
