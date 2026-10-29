import type { TreecrdtClient } from '@treecrdt/wa-sqlite'

/** Payload of a visible node; null when it is absent, deleted, or has no payload. */
export const getNodePayload = async (client: TreecrdtClient, id: string): Promise<Uint8Array | null> =>
  (await (await client.tree.get(id))?.payload()) ?? null

/** Parent of a visible node; null for ROOT and when the node or its parent is not visible. */
export const getNodeParent = async (client: TreecrdtClient, id: string): Promise<string | null> =>
  (await (await client.tree.get(id))?.parent())?.id ?? null

/** Live children of a visible node, in sibling order. */
export const getNodeChildren = async (client: TreecrdtClient, id: string): Promise<string[]> =>
  ((await (await client.tree.get(id))?.children()) ?? []).map(child => child.id)

/** True when the node exists and is not deleted. */
export const nodeExists = async (client: TreecrdtClient, id: string): Promise<boolean> =>
  (await client.tree.get(id)) !== undefined

export default {
  getNodeChildren,
  getNodeParent,
  getNodePayload,
  nodeExists,
}
