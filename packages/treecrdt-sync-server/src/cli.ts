import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { startTreecrdtSyncServer } from './server'

const parseNumberEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`invalid ${name}: ${raw}`)
  return value
}

const getEmRoot = (): string => {
  const filename = fileURLToPath(import.meta.url)
  const dir = path.dirname(filename)
  return path.resolve(dir, '../../..')
}

async function main() {
  const host = process.env.HOST ?? '0.0.0.0'
  const port = parseNumberEnv('PORT', 8787)

  const emRoot = getEmRoot()
  const dbDir = path.resolve(process.env.TREECRDT_DB_DIR ?? path.join(emRoot, '.treecrdt', 'sync-server'))
  const idleCloseMs = parseNumberEnv('TREECRDT_IDLE_CLOSE_MS', 30_000)
  const maxPayloadBytes = parseNumberEnv('TREECRDT_MAX_PAYLOAD_BYTES', 10 * 1024 * 1024)

  const handle = await startTreecrdtSyncServer({ host, port, dbDir, idleCloseMs, maxPayloadBytes })

  console.log(`TreeCRDT sync server listening on http://${handle.host}:${handle.port}`)
  console.log(`- health: http://${handle.host}:${handle.port}/health`)
  console.log(`- ws: ws://${handle.host}:${handle.port}/sync?docId=YOUR_DOC_ID`)
  console.log(`- dbDir: ${handle.dbDir}`)

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down...`)
    void handle.close().finally(() => process.exit(0))
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
