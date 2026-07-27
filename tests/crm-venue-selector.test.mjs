import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const page = await readFile(new URL('../src/components/crm/CrmPage.tsx', import.meta.url), 'utf8')
const shell = await readFile(new URL('../src/features/crm/layout/CrmShell.tsx', import.meta.url), 'utf8')
const selector = await readFile(new URL('../src/components/crm/CrmVenueSelector.tsx', import.meta.url), 'utf8')
const customSelect = await readFile(new URL('../src/features/crm/shared/components/CrmSelect.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

test('the CRM venue selector uses the shared HeroUI dropdown', () => {
  assert.match(shell, /<CrmVenueSelector/)
  assert.match(selector, /<CrmSelect/)
  assert.doesNotMatch(selector, /<select/)
  assert.match(customSelect, /from '@heroui\/react'/)
  assert.match(customSelect, /<ListBoxItem/)
})

test('the shared selector delegates keyboard navigation and dismissal to React Aria', () => {
  assert.match(customSelect, /<Select\.Trigger/)
  assert.match(customSelect, /<Select\.Popover/)
  assert.match(customSelect, /onSelectionChange=/)
  assert.doesNotMatch(customSelect, /event\.key === 'ArrowDown'/)
  assert.doesNotMatch(customSelect, /document\.addEventListener/)
})

test('the selected venue remains connected to the CRM state', () => {
  assert.match(shell, /onChange=\{onVenueChange\}/)
  assert.match(page, /setSelectedVenueId\(venueId\)/)
  assert.match(selector, /onChange=\{onChange\}/)
  assert.match(customSelect, /selectedKey=\{selectedValue \|\| null\}/)
})

test('focus styling preserves the rounded venue trigger', () => {
  assert.doesNotMatch(styles, /\.crm-venue-selector:focus-within/)
  assert.match(selector, /className="crm-custom-venue-selector/)
  assert.match(customSelect, /!rounded-\[10px\]/)
})
