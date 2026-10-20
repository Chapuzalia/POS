#!/usr/bin/env node
import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const segment = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/
const sourceFile = /\.(?:ts|tsx|js|mjs|json|lock|wasm)$/

export async function prepareEdgeFunctions(source, output, router = new URL('./edge-router.ts', import.meta.url)) {
  await mkdir(output, { recursive: true })
  async function copy(directory, target, depth = 0) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!segment.test(entry.name) || entry.name.includes('..') || entry.name === 'node_modules' ||
          (depth === 0 && ['main', 'pos-release.json'].includes(entry.name))) {
        throw new Error('Unsupported or reserved Edge Functions path.')
      }
      const path = join(directory, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new Error('Edge Functions symlinks are forbidden.')
      if (info.isDirectory()) {
        await mkdir(join(target, entry.name))
        await copy(path, join(target, entry.name), depth + 1)
      } else if (info.isFile() && sourceFile.test(entry.name)) {
        await copyFile(path, join(target, entry.name))
      } else {
        throw new Error('Unsupported Edge Functions file; do not package secrets or build artifacts.')
      }
    }
  }
  await copy(source, output)
  await mkdir(join(output, 'main'))
  await copyFile(router, join(output, 'main', 'index.ts'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4) throw new Error('Usage: prepare-edge-functions.mjs <source> <output>')
  await prepareEdgeFunctions(process.argv[2], process.argv[3])
}
