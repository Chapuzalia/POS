import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const select = await readFile(new URL('../src/features/crm/shared/components/CrmSelect.tsx', import.meta.url), 'utf8')

async function collectTsxFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return collectTsxFiles(entryPath)
    return entry.name.endsWith('.tsx') ? [entryPath] : []
  }))
  return nested.flat()
}

test('all CRM dropdowns use the shared CRM select instead of native selects', async () => {
  const directories = [
    path.join(root.pathname.slice(1), 'src/features/crm'),
    path.join(root.pathname.slice(1), 'src/components/crm'),
  ]
  const files = (await Promise.all(directories.map(collectTsxFiles))).flat()
  const nativeSelects = []
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    if (/<select(?:\s|>)/.test(source)) nativeSelects.push(file)
  }
  assert.deepEqual(nativeSelects, [])
})

test('CRM select delegates accessible listbox and keyboard behavior to HeroUI', () => {
  assert.match(select, /from '@heroui\/react'/)
  assert.match(select, /aria-haspopup="listbox"/)
  assert.match(select, /<ListBox/)
  assert.match(select, /<ListBoxItem/)
  assert.match(select, /onSelectionChange=/)
  assert.match(select, /selectedKey=\{selectedValue \|\| null\}/)
  assert.doesNotMatch(select, /document\.addEventListener/)
})

test('CRM select retains form values and uses CRM theme tokens', () => {
  assert.match(select, /<Select\.Popover/)
  assert.match(select, /type="hidden" value=\{selectedValue\}/)
  assert.match(select, /!bg-\[var\(--crm-input-bg\)\]/)
  assert.match(select, /!border-\[var\(--crm-input-border\)\]/)
  assert.match(select, /!bg-\[var\(--crm-popover-bg\)\]/)
  assert.match(select, /!shadow-\[var\(--crm-shadow-floating\)\]/)
  assert.doesNotMatch(select, /crm-select(?:__|\s)/)
})
