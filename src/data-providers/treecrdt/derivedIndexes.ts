import type { MaterializationEvent } from '@treecrdt/interface/engine'
import type { TreecrdtClient } from '@treecrdt/wa-sqlite'
import { applyAttributeChildren, clearAttributeChildren } from './attributeChildren'
import createLexemeIndex, { payloadKeys } from './lexemes'

const INDEX_VERSION = 1
const PAGE_SIZE = 500

/**
 * Keeps em's derived SQLite indexes (attribute children and lexeme memberships) in step with one TreeCRDT client.
 *
 * The indexes store the headSeq they have read up to and resume with changedSince, so changes made while the app was
 * closed, or interrupted mid-update, are applied by the next catch-up instead of forcing a rebuild. A version change
 * clears both indexes and reads every node.
 */
const createDerivedIndexes = async (client: TreecrdtClient) => {
  const { changedSince } = client.tree
  if (!changedSince) throw new Error('TreeCRDT client does not report changed nodes.')
  const lexemes = await createLexemeIndex(client)
  await client.runner.exec(`CREATE TABLE IF NOT EXISTS em_derived_indexes (
    id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, cursor INTEGER NOT NULL
  )`)
  const stored = await client.runner.getText('SELECT cursor FROM em_derived_indexes WHERE version = ?1', [
    INDEX_VERSION,
  ])
  let cursor = stored === null ? 0 : Number(stored)
  if (stored === null) {
    await lexemes.clear()
    await clearAttributeChildren(client)
  }

  /** Applies every change after the cursor, then advances it; resolves with the affected lexeme keys. */
  const catchUp = async (): Promise<string[]> => {
    const keys = new Set<string>()
    let page = await changedSince(cursor, { payloads: true, limit: PAGE_SIZE })
    for (;;) {
      for (const key of await lexemes.applyNodes(page.nodes)) keys.add(key)
      await applyAttributeChildren(client, page.nodes)
      if (!page.next) break
      page = await changedSince(page.next, { payloads: true, limit: PAGE_SIZE })
    }
    // Applying a node twice is harmless, so the cursor is saved after the rows instead of with them.
    if (page.headSeq !== cursor) {
      cursor = page.headSeq
      await client.runner.getText(
        'INSERT OR REPLACE INTO em_derived_indexes (id, version, cursor) VALUES (1, ?1, ?2)',
        [INDEX_VERSION, cursor],
      )
    }
    return [...keys]
  }

  await catchUp()
  let indexQueue = Promise.resolve()

  /** Queues a catch-up after a materialization event; resolves with the affected lexeme keys. */
  const updateIndexes = (event: MaterializationEvent): Promise<string[]> => {
    const keys = indexQueue.then(catchUp).then(rowKeys => [...new Set([...payloadKeys(event.changes), ...rowKeys])])
    // A failed catch-up leaves the cursor in place, so the next one retries the same changes.
    indexQueue = keys.then(
      () => undefined,
      err => console.error('TreeCRDT derived indexing failed', err),
    )
    return keys
  }

  /** Waits for all queued catch-ups, including ones queued while waiting. */
  const waitForIndexes = async () => {
    let pending: Promise<void>
    do {
      pending = indexQueue
      await pending
    } while (pending !== indexQueue)
  }

  return { lexemes, updateIndexes, waitForIndexes }
}

export default createDerivedIndexes
