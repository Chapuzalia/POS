import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const page = await readFile(new URL('../src/components/crm/CrmPage.tsx', import.meta.url), 'utf8')
const shell = await readFile(new URL('../src/features/crm/layout/CrmShell.tsx', import.meta.url), 'utf8')
const selector = await readFile(new URL('../src/components/crm/CrmVenueSelector.tsx', import.meta.url), 'utf8')
const customSelect = await readFile(new URL('../src/features/crm/shared/components/CrmSelect.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../src/components/crm/crm.css', import.meta.url), 'utf8')

test('the CRM venue selector uses the shared themed dropdown', () => {
  assert.match(shell, /<CrmVenueSelector/)
  assert.match(selector, /<CrmSelect/)
  assert.doesNotMatch(selector, /<select/)
  assert.match(customSelect, /role="listbox"/)
  assert.match(customSelect, /role="option"/)
})

test('the shared selector supports keyboard navigation and outside dismissal', () => {
  assert.match(customSelect, /event\.key === 'ArrowDown'/)
  assert.match(customSelect, /event\.key === 'ArrowUp'/)
  assert.match(customSelect, /event\.key === 'Home'/)
  assert.match(customSelect, /event\.key === 'End'/)
  assert.match(customSelect, /document\.addEventListener\('pointerdown'/)
  assert.match(customSelect, /window\.addEventListener\('scroll'/)
})

test('the selected venue remains connected to the CRM state', () => {
  assert.match(shell, /onChange=\{onVenueChange\}/)
  assert.match(page, /setSelectedVenueId\(venueId\)/)
  assert.match(selector, /onChange=\{onChange\}/)
  assert.match(customSelect, /aria-selected=\{selected\}/)
})

test('focus styling does not draw a square around the rounded venue trigger', () => {
  assert.doesNotMatch(styles, /\.crm-venue-selector:focus-within/)
  assert.match(selector, /className="crm-custom-venue-selector/)
  assert.match(customSelect, /!rounded-\[10px\]/)
})
