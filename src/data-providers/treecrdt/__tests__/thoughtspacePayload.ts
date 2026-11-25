import type ThoughtId from '../../../@types/ThoughtId'
import hashThought from '../../../util/hashThought'
import { encodeThoughtPayload } from '../payload'

it('keeps em rank out of the serialized TreeCRDT thought payload and keys it by its Lexeme', () => {
  const encoded = encodeThoughtPayload('00000000000000000000000000000201' as ThoughtId, {
    value: 'a',
    created: 1,
    lastUpdated: 2,
    updatedBy: 'test',
  })

  expect(JSON.parse(new TextDecoder().decode(encoded))).toEqual({
    value: 'a',
    created: 1,
    lastUpdated: 2,
    updatedBy: 'test',
    lexeme: hashThought('a'),
  })
})
