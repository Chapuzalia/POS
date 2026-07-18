import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const page = await readFile(new URL('../src/components/crm/CrmPage.tsx', import.meta.url), 'utf8')
const selector = await readFile(new URL('../src/components/crm/CrmVenueSelector.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../src/components/crm/crm.css', import.meta.url), 'utf8')

test('the CRM uses a themed venue selector instead of a native select', () => {
  assert.match(page, /<CrmVenueSelector/)
  assert.doesNotMatch(selector, /<select/)
  assert.match(selector, /role="listbox"/)
  assert.match(selector, /role="option"/)
})

test('the venue selector supports keyboard navigation and outside dismissal', () => {
  assert.match(selector, /event\.key === 'ArrowDown'/)
  assert.match(selector, /event\.key === 'ArrowUp'/)
  assert.match(selector, /event\.key === 'Home'/)
  assert.match(selector, /event\.key === 'End'/)
  assert.match(selector, /document\.addEventListener\('pointerdown'/)
  assert.match(selector, /document\.addEventListener\('keydown'/)
})

test('the selected venue remains connected to the existing CRM state', () => {
  assert.match(page, /setSelectedVenueId\(venueId\)/)
  assert.match(selector, /onChange\(venueId\)/)
  assert.match(selector, /aria-selected=\{selected\}/)
})

test('focus styling does not draw a square around the rounded venue trigger', () => {
  assert.doesNotMatch(styles, /\.crm-venue-selector:focus-within/)
  assert.doesNotMatch(selector, /className="crm-venue-selector/)
  assert.match(selector, /className="crm-custom-venue-selector/)
  assert.match(selector, /!rounded-\[11px\]/)
})
