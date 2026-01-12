import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const run = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))
    })
  })

const findTreecrdtRoot = () => {
  const filename = fileURLToPath(import.meta.url)
  const dir = path.dirname(filename)
  return path.resolve(dir, '../../../../..')
}

const main = async () => {
  const treecrdtRoot = findTreecrdtRoot()
  const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

  try {
    await fs.stat(path.join(treecrdtRoot, 'pnpm-lock.yaml'))
  } catch {
    console.log(`TreeCRDT pnpm workspace not detected at ${treecrdtRoot}, skipping setup.`)
    return
  }

  try {
    await fs.stat(path.join(treecrdtRoot, 'node_modules'))
  } catch {
    await run(pnpmCmd, ['install'], { cwd: treecrdtRoot })
  }

  await run(pnpmCmd, ['--filter', '@treecrdt/sync', 'build'], { cwd: treecrdtRoot })
  await run(pnpmCmd, ['--filter', '@treecrdt/sync-server-core', 'build'], { cwd: treecrdtRoot })
  await run(pnpmCmd, ['--filter', '@treecrdt/sqlite-node', 'build'], { cwd: treecrdtRoot })
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
