import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const select = await readFile(new URL('../src/components/ui/Select.tsx', import.meta.url), 'utf8')
const nativeSelect = await readFile(new URL('../src/components/ui/NativeSelect.tsx', import.meta.url), 'utf8')

test('TPV selects only render the tick for the selected option', () => {
  assert.match(select, /option\.value === value \? \(\s*<ListBoxItem\.Indicator(?:\s+[^>]*)?>/)
  assert.match(nativeSelect, /option\.value === selectedValue \? \(\s*<ListBoxItem\.Indicator(?:\s+[^>]*)?>/)
})
