import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const shell = await readFile(new URL('../src/features/crm/layout/CrmShell.tsx', import.meta.url), 'utf8')
const modal = await readFile(new URL('../src/features/crm/shared/components/CrmModal.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

test('the CRM theme is scoped and persists independently from the POS theme', () => {
  assert.match(shell, /data-crm-theme={crmTheme}/)
  assert.ok(shell.includes('localStorage.setItem(CRM_THEME_STORAGE_KEY, nextTheme)'))
  assert.ok(styles.includes(".crm-shell[data-crm-theme='dark']"))
  assert.ok(!styles.includes(":root[data-theme='club-night'] .crm-shell"))
})

test('CRM modals fit their content and only scroll after reaching the viewport limit', () => {
  assert.doesNotMatch(modal, /size="full"/)
  assert.match(modal, /!h-auto !min-h-0/)
  assert.match(modal, /!max-h-\[calc\(100dvh-24px\)\]/)
  assert.match(modal, /style=\{\{ maxWidth \}\}/)
})
