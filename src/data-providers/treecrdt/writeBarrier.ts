import type { LocalWriteOptions, MaterializationEvent } from '@treecrdt/interface/engine'

let pendingTreecrdtWrite = Promise.resolve()
let pendingTreecrdtWriteError: unknown = null
let pendingTreecrdtWriteVersion = 0
let localWriteCounter = 0

const localWriteSourceId =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

const localWriteIdPrefix = `em-local:${localWriteSourceId}:`

/**
 * Queues em -> TreeCRDT persistence work and exposes an idle barrier for materialization refreshes.
 * This is a local ordering guard, not a CRDT requirement; it keeps app-state refreshes from racing local persistence.
 */
export function withTreecrdtWriteBarrier<T>(work: () => Promise<T>): Promise<T> {
  pendingTreecrdtWriteVersion += 1
  const run = pendingTreecrdtWrite.then(work, work)
  pendingTreecrdtWrite = run.then(
    () => undefined,
    err => {
      pendingTreecrdtWriteError = err
    },
  )
  return run
}

/** Monotonically increases whenever TreeCRDT persistence work is queued. */
export const getTreecrdtWriteBarrierVersion = (): number => pendingTreecrdtWriteVersion

/** Waits until TreeCRDT persistence is idle, including work queued while waiting. */
export async function waitForTreecrdtWriteBarrier(): Promise<void> {
  let pending: Promise<void>
  do {
    pending = pendingTreecrdtWrite
    await pending
  } while (pending !== pendingTreecrdtWrite)

  if (pendingTreecrdtWriteError) {
    const err = pendingTreecrdtWriteError
    pendingTreecrdtWriteError = null
    throw err
  }
}

/** Namespaces app write IDs to this tab, with unique IDs for bootstrap/provider-only writes. */
export function createTreecrdtLocalWriteOptions(writeId?: string): LocalWriteOptions {
  localWriteCounter += 1
  return { writeId: `${localWriteIdPrefix}${writeId ?? localWriteCounter}` }
}

/** True when every change belongs to this tab's writes from a cleared Redux generation. */
export const isStaleTreecrdtMaterialization = (event: MaterializationEvent, generation: number): boolean =>
  event.changes.length > 0 &&
  event.changes.every(change =>
    change.source?.writeIds?.length
      ? change.source.writeIds.every(
          id =>
            id.startsWith(`${localWriteIdPrefix}generation:`) &&
            !id.startsWith(`${localWriteIdPrefix}generation:${generation}:`),
        )
      : false,
  )

export default {
  createTreecrdtLocalWriteOptions,
  getTreecrdtWriteBarrierVersion,
  isStaleTreecrdtMaterialization,
  waitForTreecrdtWriteBarrier,
  withTreecrdtWriteBarrier,
}
