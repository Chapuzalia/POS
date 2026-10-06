import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compileComponent, jsxRuntime } from './helpers/component-harness.mjs'

const source = name => readFileSync(new URL(`../src/components/ui/${name}`, import.meta.url), 'utf8')

function modalHarness(props = {}) {
  const Modal = Object.assign(() => null, {
    Trigger: 'trigger', Backdrop: 'backdrop', Container: 'container', Dialog: 'dialog',
  })
  const { AppModal } = compileComponent(source('AppModal.tsx'), {
    'react/jsx-runtime': jsxRuntime,
    '@heroui/react': { Modal },
  }, { document: { querySelector: () => ({ dataset: { crmTheme: 'dark' } }) } })
  let closes = 0
  const tree = AppModal({ children: 'Contenido', label: 'Prueba', onClose: () => closes++, ...props })
  const backdrop = tree.props.children.find(node => node.type === 'backdrop')
  return { tree, backdrop, closes: () => closes }
}

test('busy POS and CRM dialogs reject dismissal and keep all close protections', () => {
  for (const theme of ['pos', 'crm']) {
    const h = modalHarness({ theme, dismissDisabled: true })
    assert.equal(h.backdrop.props.isDismissable, false)
    assert.equal(h.backdrop.props.isKeyboardDismissDisabled, true)
    h.tree.props.onOpenChange(false)
    assert.equal(h.closes(), 0)
  }
})

test('outside-click protection does not disable deliberate keyboard cancellation', () => {
  const h = modalHarness({ closeOnOutsidePress: false })
  assert.equal(h.backdrop.props.isDismissable, false)
  assert.equal(h.backdrop.props.isKeyboardDismissDisabled, false)
  h.tree.props.onOpenChange(false)
  assert.equal(h.closes(), 1)
})

function dialogStore() {
  return compileComponent(source('appDialogStore.ts'), {})
}

test('confirmation executes only after accepting and cancellation stays false', async () => {
  const store = dialogStore()
  let actions = 0
  const run = async () => { if (await store.appConfirm('Eliminar')) actions++ }
  const cancelled = run()
  store.settleAppDialog(store.getAppDialogSnapshot().id, null)
  await cancelled
  assert.equal(actions, 0)
  const accepted = run()
  store.settleAppDialog(store.getAppDialogSnapshot().id, true)
  await accepted
  assert.equal(actions, 1)
  assert.equal(store.getAppDialogSnapshot(), null)
})

test('double clicks cannot create another confirmation or execute an action twice', async () => {
  const store = dialogStore()
  let actions = 0
  const run = async () => { if (await store.appConfirm('Eliminar')) actions++ }
  const first = run()
  const id = store.getAppDialogSnapshot().id
  const second = run()
  await second
  assert.equal(store.getAppDialogSnapshot().id, id)
  assert.equal(actions, 0)
  store.settleAppDialog(id, true)
  store.settleAppDialog(id, true)
  await first
  assert.equal(actions, 1)
})

test('prompts preserve initial values, empty input and cancellation', async () => {
  const store = dialogStore()
  const first = store.appPrompt('Nombre', 'Barra')
  assert.equal(store.getAppDialogSnapshot().initialValue, 'Barra')
  store.settleAppDialog(store.getAppDialogSnapshot().id, '')
  assert.equal(await first, '')
  const second = store.appPrompt('Nombre', 'Barra')
  store.settleAppDialog(store.getAppDialogSnapshot().id, null)
  assert.equal(await second, null)
})

test('a stale close event cannot cancel the next dialog and listeners unsubscribe', async () => {
  const store = dialogStore()
  let updates = 0
  const unsubscribe = store.subscribeAppDialog(() => updates++)
  const first = store.appConfirm('Primero')
  const firstId = store.getAppDialogSnapshot().id
  store.settleAppDialog(firstId, true)
  await first
  const next = store.appConfirm('Segundo')
  const nextId = store.getAppDialogSnapshot().id
  store.settleAppDialog(firstId, null)
  assert.equal(store.getAppDialogSnapshot().id, nextId)
  assert.equal(updates, 3)
  unsubscribe()
  store.settleAppDialog(nextId, false)
  assert.equal(await next, false)
  assert.equal(updates, 3)
})

test('CRM permits cancellation offline but blocks it during an active operation', () => {
  let busy = false
  const contextSource = readFileSync(new URL('../src/features/crm/shared/components/CrmModalBusyContext.ts', import.meta.url), 'utf8')
  const { useCrmModalBusy } = compileComponent(contextSource, {
    react: { createContext: () => ({}), useContext: () => busy },
  })
  assert.equal(useCrmModalBusy(true), false)
  busy = true
  assert.equal(useCrmModalBusy(true), true)
  busy = null
  assert.equal(useCrmModalBusy(true), true)
})
