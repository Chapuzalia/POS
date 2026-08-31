import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url))

async function findDataTableConsumers(directory) {
  const sources = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) sources.push(...await findDataTableConsumers(path))
    else if (entry.name.endsWith('.tsx') && entry.name !== 'DataTable.tsx') {
      const source = await readFile(path, 'utf8')
      if (source.includes('<DataTable')) sources.push({ path: relative(srcRoot, path), source })
    }
  }
  return sources
}

const sources = await findDataTableConsumers(srcRoot)

test('las tablas unificadas entregan filas tr directas en lugar de componentes de fila', () => {
  assert.ok(sources.length >= 8, 'la auditoría debe incluir los consumidores actuales de DataTable')
  const customRowComponent = /^\s*\{\s*[A-Za-z0-9_.]+\.map\(\([^)]*\)\s*=>\s*(?:\(\s*)?<([A-Z][A-Za-z0-9_]*)/

  for (const { path, source } of sources) {
    const bodies = [...source.matchAll(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/g)]
    assert.ok(bodies.length > 0, `${path} debe conservar al menos un tbody inspeccionable`)
    for (const [, body] of bodies) {
      assert.doesNotMatch(
        body,
        customRowComponent,
        `${path} pasa un componente de fila a DataTable; debe entregar el <tr> ya resuelto`,
      )
    }
  }
})
