import type { MaterializationEvent } from '@treecrdt/interface/engine'
import type { TreecrdtClient } from '@treecrdt/wa-sqlite'
import _ from 'lodash'
import type Index from '../../../@types/IndexType'
import type Thought from '../../../@types/Thought'
import type { ThoughtspaceMaterializationBridge } from '../../thoughtspace'
import { refreshAttributeChildrenFromChanges } from '../attributeChildren'
import {
  getTreecrdtWriteBarrierVersion,
  isStaleTreecrdtMaterialization,
  waitForTreecrdtWriteBarrier,
} from '../writeBarrier'
import { enqueueMaterializedThoughtsToStoreWork, getMaterializedThoughtsToStoreVersion } from './materializationQueue'
import { type MaterializationStore, refreshThoughtsFromMaterializationChanges } from './materializationThoughtUpdates'

/** Dependencies captured when a client registers its materialization listener. */
type MaterializationContext = Readonly<{
  bridge?: ThoughtspaceMaterializationBridge
  client: TreecrdtClient
  db: MaterializationStore
  pending: { event: MaterializationEvent; keys: Promise<string[]>; generation: number | undefined }[]
}>

/** Serializes UI refreshes without putting index persistence behind the local-write barrier. */
const applyMaterializedThoughtsToStore = (
  event: MaterializationEvent,
  { bridge, client, db, pending }: MaterializationContext,
  changedKeys: Promise<string[]>,
): Promise<void> => {
  pending.push({ event, keys: changedKeys, generation: bridge?.getSnapshot().generation })
  return enqueueMaterializedThoughtsToStoreWork(async () => {
    if (pending.length === 0) return
    let events: MaterializationContext['pending'] = []

    // A later optimistic edit or materialization invalidates an asynchronous read. Retry from current storage.
    while (true) {
      await waitForTreecrdtWriteBarrier()
      events.push(...pending.splice(0))
      // Index persistence is independent of UI publication, including discarded generations.
      await Promise.all(events.map(entry => entry.keys))
      if (!bridge) return
      const snapshot = bridge.getSnapshot()
      events = events.filter(
        entry =>
          entry.generation === snapshot.generation && !isStaleTreecrdtMaterialization(entry.event, snapshot.generation),
      )
      if (events.length === 0) return
      const writeVersion = getTreecrdtWriteBarrierVersion()
      const materializationVersion = getMaterializedThoughtsToStoreVersion()
      const changes = events.flatMap(entry => entry.event.changes)
      const keys = [...new Set((await Promise.all(events.map(entry => entry.keys))).flat())]
      await refreshAttributeChildrenFromChanges(client, changes)
      const thoughtIndexUpdates: Index<Thought | null> = {}
      const { deletedIds, thoughts } = await refreshThoughtsFromMaterializationChanges(changes, db)
      for (const id of deletedIds) thoughtIndexUpdates[id] = null
      for (const latest of thoughts) {
        const previous = snapshot.thoughtIndex[latest.id]
        const pending = previous?.pending || snapshot.thoughtIndex[latest.parentId]?.pending
        thoughtIndexUpdates[latest.id] = {
          ...latest,
          ...(pending ? { pending } : null),
          ...(previous?.generating !== undefined ? { generating: previous.generating } : null),
          ...(previous?.splitSource !== undefined ? { splitSource: previous.splitSource } : null),
        }
      }
      const values = await db.getLexemesByIds(keys)
      const current = bridge.getSnapshot()
      if (
        snapshot.lexemeIndex !== current.lexemeIndex ||
        snapshot.thoughtIndex !== current.thoughtIndex ||
        writeVersion !== getTreecrdtWriteBarrierVersion() ||
        materializationVersion !== getMaterializedThoughtsToStoreVersion()
      )
        continue

      const lexemeIndexUpdates = Object.fromEntries(
        keys.flatMap((key, i) => (_.isEqual(values[i], snapshot.lexemeIndex[key]) ? [] : [[key, values[i] ?? null]])),
      )
      if (Object.keys(lexemeIndexUpdates).length > 0 || Object.keys(thoughtIndexUpdates).length > 0) {
        await bridge.apply({
          thoughtIndex: thoughtIndexUpdates,
          lexemeIndex: lexemeIndexUpdates,
        })
      }
      return
    }
  })
}

export default applyMaterializedThoughtsToStore
