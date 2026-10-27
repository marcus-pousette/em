import _ from 'lodash'
import Index from '../@types/IndexType'
import Path from '../@types/Path'
import PushBatch from '../@types/PushBatch'
import State from '../@types/State'
import Thought from '../@types/Thought'
import ThoughtId from '../@types/ThoughtId'
import Thunk from '../@types/Thunk'
import updateThoughts from '../actions/updateThoughts'
import { clientId } from '../data-providers/thoughtspaceSession'
import { getChildrenRanked } from '../selectors/getChildren'
import { getLexeme } from '../selectors/getLexeme'
import getMovePlacement from '../selectors/getMovePlacement'
import getSortPreference from '../selectors/getSortPreference'
import getSortedRank from '../selectors/getSortedRank'
import getThoughtById from '../selectors/getThoughtById'
import rootedParentOf from '../selectors/rootedParentOf'
import thoughtToPath from '../selectors/thoughtToPath'
import { registerActionMetadata } from '../util/actionMetadata.registry'
import appendToPath from '../util/appendToPath'
import equalPathHead from '../util/equalPathHead'
import hashPath from '../util/hashPath'
import hashThought from '../util/hashThought'
import headValue from '../util/headValue'
import isDescendant from '../util/isDescendant'
import isEmptyOrEmojiOnly from '../util/isEmptyOrEmojiOnly'
import keyValueBy from '../util/keyValueBy'
import reducerFlow from '../util/reducerFlow'
import timestamp from '../util/timestamp'

interface Payload {
  pathParent: Path
  thoughtId: ThoughtId
  /** If both local and remote are false, only deallocate thoughts from State, but do not delete them permanently. This is used by freeThoughts. The parent is marked as pending so that the thought will be automatically restored if it becomes visible again. */
  local?: boolean
  remote?: boolean
}

interface ThoughtUpdates {
  path: Path
  thoughtIndex: Index<Thought | null>
  pendingDeletes?: PushBatch['pendingDeletes']
}

/** Removes a child from a thought and the corresponding Lexeme context. If it was the last instance of the Lexeme, removes it completely from the lexemeIndex. Removes the id from the parent thought event if the thought itself does not exist (See: importFiles > missingChildren). Does not update the cursor. Use deleteThoughtWithCursor or archiveThought for higher-level functions. */
const deleteThought = (state: State, { local = true, pathParent, thoughtId, remote = true }: Payload) => {
  const deletedThought = getThoughtById(state, thoughtId) as Thought | undefined
  if (!deletedThought) return state

  // See: Payload.local
  const persist = local || remote

  const parent = getThoughtById(state, deletedThought.parentId)

  if (!parent) {
    console.error('Parent not found!', thoughtId, deletedThought?.value)
    return state
  }

  const simplePath = thoughtToPath(state, thoughtId)
  const path = [...pathParent, thoughtId] as Path

  // TODO: Re-enable Recently Edited
  // Uncaught TypeError: Cannot perform 'IsArray' on a proxy that has been revoked at Function.isArray (#417)
  // let recentlyEdited = state.recentlyEdited
  // try {
  //   recentlyEdited = treeDelete(state, state.recentlyEdited, path)
  // } catch (e) {
  //   console.error('deleteThought: treeDelete immer error')
  //   console.error(e)
  // }

  // disable context view
  const contextViewsNew = { ...state.contextViews }
  delete contextViewsNew[hashPath(path)]

  /** Generates an update object that can be used to delete/update all descendants and delete/update thoughtIndex. */
  const recursiveDeletes = (thought: Thought, accumRecursive = {} as ThoughtUpdates): ThoughtUpdates => {
    const children = getChildrenRanked(state, thought.id)
    return children.reduce(
      (accum, child) => {
        // if pending, append to a special pendingDeletes field so all descendants can be loaded and deleted asynchronously
        if (child.pending) {
          const thoughtUpdate: ThoughtUpdates = {
            ...accum,
            // do not delete the pending thought yet since the second call to deleteThought needs a starting point
            pendingDeletes: [
              ...(accumRecursive.pendingDeletes || []),
              { path: appendToPath(pathParent, thought.id, child.id), siblingIds: children.map(child => child.id) },
            ],
          }

          return thoughtUpdate
        }

        delete contextViewsNew[hashPath(accum.path)]

        // RECURSION
        const recursiveResults = recursiveDeletes(child, accum)

        return {
          ...accum,
          path: [...accum.path, child.id],
          pendingDeletes: _.uniq([
            ...(accum.pendingDeletes || []),
            ...(accumRecursive.pendingDeletes || []),
            ...(recursiveResults.pendingDeletes || []),
          ]),
          thoughtIndex: {
            ...accum.thoughtIndex,
            ...recursiveResults.thoughtIndex,
          },
        }
      },
      {
        path: pathParent,
        thoughtIndex: {
          ...accumRecursive.thoughtIndex,
          [thought.id]: null,
        },
      } as ThoughtUpdates,
    )
  }

  const descendantUpdatesResult = recursiveDeletes(deletedThought)

  // Removing a child moves the parent's lastUpdated to now, which is its sort key in a context sorted by Updated, so
  // the parent is re-ranked among its siblings to keep their ranks matching the sort condition (#4098). Empty and
  // emoji-only thoughts are sorted to their point of creation, so they keep the rank they have.
  const parentRank =
    persist && getSortPreference(state, parent.parentId).type === 'Updated' && !isEmptyOrEmojiOnly(parent.value)
      ? getSortedRank(state, parent.parentId, parent.value, { staleId: parent.id })
      : parent.rank

  const thoughtIndexUpdates = {
    // Deleted thought's parent
    [parent.id]: {
      ...parent,
      ...(persist
        ? {
            childrenMap: keyValueBy(parent.childrenMap || {}, (key, id) => (id !== thoughtId ? { [key]: id } : null)),
            lastUpdated: timestamp(),
            rank: parentRank,
            updatedBy: clientId,
          }
        : { pending: true }),
    } as Thought,
    [thoughtId]: null,
    // descendants
    ...descendantUpdatesResult.thoughtIndex,
  }

  // Eviction keeps complete memberships while any member remains loaded; it never removes individual contexts.
  // Persisted deletions omit the patch so updateThoughts derives membership changes from the deleted IDs.
  const lexemeIndexUpdates = persist
    ? undefined
    : keyValueBy(thoughtIndexUpdates, (id, thought) => {
        if (thought) return null
        const oldThought = state.thoughts.thoughtIndex[id]
        const lexeme = oldThought && getLexeme(state, oldThought.value)
        return lexeme &&
          !lexeme.contexts.some(contextId =>
            contextId in thoughtIndexUpdates ? thoughtIndexUpdates[contextId] : getThoughtById(state, contextId),
          )
          ? { [hashThought(oldThought!.value)]: null }
          : null
      })

  // A new rank is invisible to the persistence layer on its own: sibling order is stored structurally there and only
  // changes on a move, which is minted from an explicit placement (#5126).
  const movePlacements: Index<ThoughtId | null> =
    parentRank !== parent.rank
      ? { [parent.id]: getMovePlacement(state, parent.parentId, { id: parent.id, rank: parentRank }) }
      : {}

  const isDeletedThoughtCursor = equalPathHead(simplePath, state.cursor)

  const isCursorDescendantOfDeletedThought = !!simplePath && !!state.cursor && isDescendant(simplePath, state.cursor)

  // if the deleted thought is the cursor or a descendant of the cursor, we need to calculate a new cursor.
  const cursorNew =
    isDeletedThoughtCursor || isCursorDescendantOfDeletedThought
      ? simplePath.length > 1
        ? rootedParentOf(state, simplePath)
        : null
      : state.cursor

  return reducerFlow([
    state => ({
      ...state,
      contextViews: contextViewsNew,
      cursor: cursorNew,
      editingValue: cursorNew ? headValue(state, cursorNew) : null,
    }),
    updateThoughts({
      thoughtIndexUpdates,
      lexemeIndexUpdates,
      movePlacements,
      // recentlyEdited,
      pendingDeletes: descendantUpdatesResult.pendingDeletes,
      local,
      remote,
      overwritePending: !persist,
    }),
  ])(state)
}

/** Action-creator for deleteThought. */
export const deleteThoughtActionCreator =
  (payload: Parameters<typeof deleteThought>[1]): Thunk =>
  dispatch =>
    dispatch({ type: 'deleteThought', ...payload })

export default _.curryRight(deleteThought)

// Register this action's metadata
registerActionMetadata('deleteThought', {
  undoable: true,
})
