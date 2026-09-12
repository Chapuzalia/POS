import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'

import {
  compileComponent,
  createHookHarness,
  jsxRuntime,
  nodes,
} from './helpers/component-harness.mjs'

const [selectSource, nativeSelectSource] = await Promise.all([
  readFile(new URL('../src/components/ui/Select.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/ui/NativeSelect.tsx', import.meta.url), 'utf8'),
])

const heroUi = {
  ListBox: 'listbox',
  ListBoxItem: Object.assign('option', { Indicator: 'indicator' }),
  Select: Object.assign('select', { Indicator: 'select-indicator', Popover: 'popover', Trigger: 'trigger', Value: 'value' }),
}

test('el selector TPV entrega exactamente el valor elegido', () => {
  const changes = []
  const { Select } = compileComponent(selectSource, {
    '@heroui/react': heroUi,
    'lucide-react': { Check: 'check' },
    'react/jsx-runtime': jsxRuntime,
  })
  const options = [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]
  const rendered = Select({ ariaLabel: 'selector', onChange: (value) => changes.push(value), options, value: 'a' })

  rendered.props.onSelectionChange('b')
  assert.deepEqual(changes, ['b'])
  assert.equal(Select({ ariaLabel: 'selector', onChange() {}, options, value: changes[0] }).props.selectedKey, 'b')
})

test('el selector compatible con formularios actualiza el campo y el evento de cambio', () => {
  const hooks = createHookHarness()
  const changes = []
  const { NativeSelect } = compileComponent(nativeSelectSource, {
    './Input': { Input: 'input' },
    '@heroui/react': heroUi,
    'lucide-react': { Check: 'check' },
    react: hooks.react,
    'react/jsx-runtime': jsxRuntime,
  })
  const children = jsxs(Fragment, {
    children: [
      jsx('option', { children: 'A', value: 'a' }),
      jsx('option', { children: 'B', value: 'b' }),
    ],
  })
  const props = { children, defaultValue: 'a', name: 'product', onChange: (event) => changes.push(event.target.value) }
  const initial = hooks.render(NativeSelect, props)

  nodes(initial).find((node) => node.type === heroUi.Select).props.onSelectionChange('b')
  const updated = hooks.render(NativeSelect, props)
  const formField = nodes(updated).find((node) => node.type === 'input')

  assert.deepEqual(changes, ['b'])
  assert.equal(formField.props.value, 'b')
})
