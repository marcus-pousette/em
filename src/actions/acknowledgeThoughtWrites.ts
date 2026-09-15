import type Index from '../@types/IndexType'
import type Lexeme from '../@types/Lexeme'
import type State from '../@types/State'
import { registerActionMetadata } from '../util/actionMetadata.registry'
import mergeUpdates from '../util/mergeUpdates'
import projectLexemes from '../util/projectLexemes'

/** Applies provider-confirmed memberships beneath newer edits, retaining failed current writes. */
const acknowledgeThoughtWrites = (
  state: State,
  { writeIds, lexemeIndex = {}, error }: { writeIds: string[]; lexemeIndex?: Index<Lexeme | null>; error?: string },
): State => {
  const completed = new Set(writeIds)
  const pendingThoughtWrites = Object.fromEntries(
    Object.entries(state.pendingThoughtWrites).flatMap(([id, write]) =>
      !completed.has(write.writeId) ? [[id, write]] : error !== undefined ? [[id, { ...write, error }]] : [],
    ),
  )
  return {
    ...state,
    pendingThoughtWrites,
    thoughts: {
      ...state.thoughts,
      lexemeIndex: projectLexemes(
        mergeUpdates(state.thoughts.lexemeIndex, lexemeIndex),
        Object.fromEntries(Object.keys(pendingThoughtWrites).map(id => [id, state.thoughts.thoughtIndex[id] ?? null])),
      ),
    },
  }
}

export default acknowledgeThoughtWrites

registerActionMetadata('acknowledgeThoughtWrites', { undoable: false })
