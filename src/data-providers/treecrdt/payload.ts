import type ThoughtId from '../../@types/ThoughtId'
import { GLOBAL_ROOT_TOKEN } from '../../constants'
import hashThought from '../../util/hashThought'
import { SYSTEM_ROOT_THOUGHT_IDS } from './systemThoughtIds'

export type ThoughtPayload = {
  value: string
  created: number
  lastUpdated: number
  updatedBy: string
  archived?: number
}

/** JSON path of the Lexeme key in a thought payload, which TreeCRDT indexes to find the contexts of a Lexeme. */
export const LEXEME_PATH = '$.lexeme'

/** Roots are in no Lexeme, so their payloads carry no Lexeme key. */
const ROOT_IDS = new Set<string>([GLOBAL_ROOT_TOKEN, ...SYSTEM_ROOT_THOUGHT_IDS])

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Encodes a thought payload to bytes. Every thought but a root gets the key of its Lexeme, so the write that sets a
 * value also moves the thought to its Lexeme.
 */
export function encodeThoughtPayload(id: ThoughtId, payload: ThoughtPayload): Uint8Array {
  return encoder.encode(JSON.stringify(ROOT_IDS.has(id) ? payload : { ...payload, lexeme: hashThought(payload.value) }))
}

/** Decodes bytes to a thought payload. */
export function decodeThoughtPayload(bytes: Uint8Array): ThoughtPayload {
  return JSON.parse(decoder.decode(bytes)) as ThoughtPayload
}
