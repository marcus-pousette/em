import newThought from '../../actions/newThought'
import updateThoughts from '../../actions/updateThoughts'
import getLexeme from '../../selectors/getLexeme'
import contextToThought from '../../test-helpers/contextToThought'
import initialState from '../../util/initialState'

it('does not derive memberships when an explicit empty lexeme patch is supplied', () => {
  const state = newThought('cat')(initialState())
  const thought = contextToThought(state, ['cat'])!

  const stateNew = updateThoughts(state, {
    thoughtIndexUpdates: { [thought.id]: { ...thought, value: 'dog' } },
    lexemeIndexUpdates: {},
  })

  expect(stateNew.thoughts.thoughtIndex[thought.id].value).toBe('dog')
  expect(getLexeme(stateNew, 'cat')).toEqual(getLexeme(state, 'cat'))
  expect(getLexeme(stateNew, 'dog')).toBeUndefined()
})
