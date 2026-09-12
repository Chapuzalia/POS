import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  compileComponent,
  createHookHarness,
  jsxRuntime,
  nodes,
} from './helpers/component-harness.mjs'

const source = await readFile(new URL('../src/features/crm/shared/components/CrmSelect.tsx', import.meta.url), 'utf8')
const heroUi = {
  ListBox: 'listbox',
  ListBoxItem: Object.assign('option', { Indicator: 'indicator' }),
  Select: Object.assign('select', { Popover: 'popover', Trigger: 'trigger', Value: 'value' }),
}

test('el selector CRM conserva en el formulario el valor realmente elegido', () => {
  const hooks = createHookHarness()
  const changes = []
  const { CrmSelect } = compileComponent(source, {
    '../../../../components/ui/Input': { Input: 'input' },
    '../../../../lib/format': { normalizeText: (value) => value.toLocaleLowerCase() },
    '@heroui/react': heroUi,
    'lucide-react': { Check: 'check', ChevronDown: 'chevron', Search: 'search' },
    react: hooks.react,
    'react/jsx-runtime': jsxRuntime,
  })
  const props = {
    defaultValue: 'venue-a',
    name: 'venueId',
    onChange: (value) => changes.push(value),
    options: [{ label: 'A', value: 'venue-a' }, { label: 'B', value: 'venue-b' }],
  }
  const initial = hooks.render(CrmSelect, props)

  nodes(initial).find((node) => node.type === heroUi.Select).props.onSelectionChange('venue-b')
  const updated = hooks.render(CrmSelect, props)
  const formField = nodes(updated).find((node) => node.type === 'input' && node.props.name === 'venueId')

  assert.deepEqual(changes, ['venue-b'])
  assert.equal(formField.props.value, 'venue-b')
  assert.equal(nodes(updated).find((node) => node.type === heroUi.Select).props.selectedKey, 'venue-b')
})
