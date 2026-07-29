import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/features/local-printing/components/PrintJobsTable.tsx', import.meta.url), 'utf8')

test('the empty print jobs state is rendered outside the HeroUI table collection', () => {
  assert.match(source, /if\s*\(!jobs\.length\)/)
  assert.doesNotMatch(source, /colSpan=/)
})
