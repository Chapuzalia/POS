import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compileComponent, createHookHarness, expandedNodes, jsxRuntime } from './helpers/component-harness.mjs'

const source = readFileSync(new URL('../src/components/modals/SessionTicketsModal.tsx', import.meta.url), 'utf8')

function harness() {
  const hooks = createHookHarness()
  const { SessionTicketsModal } = compileComponent(source, {
    react: hooks.react,
    'react/jsx-runtime': jsxRuntime,
    'lucide-react': Object.fromEntries(['Banknote', 'ChevronLeft', 'ChevronRight', 'CreditCard', 'LoaderCircle', 'Minus', 'Plus', 'Printer', 'RotateCcw', 'Search', 'Trash2', 'X'].map(name => [name, name])),
    '../../lib/format': { formatMoney: value => String(value), formatTicketNumber: value => String(value) },
    '../ui': { AppModal: 'modal', Button: 'button', Input: 'input' },
    '../ui/NumericKeypadModal': { NumericKeypadModal: 'keypad' },
    '../../features/local-printing': { usePrintAgent: () => ({ isPrintingTicket: false }) },
    '../../features/cash-registers/services/sessionTicketHistoryModel.ts': { getVisibleTicketPages: () => [1], SESSION_TICKETS_PAGE_SIZE: 20 },
  })
  const ticket = {
    id: 'sale', totalCents: 240, status: 'active', paymentMethod: 'cash', ticketNumber: 42,
    createdAt: '2026-10-06T12:00:00Z',
    payload: { ticket: {}, lines: [
      { id: 'whole', productName: '1906', quantity: 1, modifiers: [], lineTotalCents: 160 },
      { id: 'fraction', productName: 'Producto fraccionado', quantity: 1.5, modifiers: [], lineTotalCents: 80 },
    ] },
  }
  const page = { currentPage: 1, totalResults: 1, tickets: [{ ticket }] }
  const refunds = []
  const props = { canReprint: false, initialPage: page, isBusy: false, loadPage: async () => page,
    onChangePayment() {}, onClose() {}, onReprint() {}, onVoidTicket() {},
    onRefund: (_, lines, method) => refunds.push({ lines, method }),
  }
  const render = () => expandedNodes(hooks.render(SessionTicketsModal, props))
  const text = children => Array.isArray(children) ? children.map(text).join('') : typeof children === 'string' ? children : ''
  const button = name => render().find(node => node.type === 'button' && (node.props['aria-label'] === name || text(node.props.children).trim() === name))
  button('Modificar').props.onClick()
  button('Devolución').props.onClick()
  return { button, refunds, render }
}

test('refund touch controls respect zero and original quantities and omit unselected lines', () => {
  const h = harness()
  assert.equal(h.button('Aumentar cantidad de 1906').props.disabled, true)
  h.button('Reducir cantidad de 1906').props.onClick()
  assert.equal(h.button('Reducir cantidad de 1906').props.disabled, true)
  h.button('Reducir cantidad de Producto fraccionado').props.onClick()
  h.button('Aumentar cantidad de Producto fraccionado').props.onClick()
  assert.equal(h.button('Aumentar cantidad de Producto fraccionado').props.disabled, true)
  h.button('Confirmar devolución').props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(h.refunds)), [{ lines: [{ lineId: 'fraction', quantity: 1.5 }], method: 'cash' }])
})

test('refund keypad clamps excessive amounts, accepts fractional quantities and preserves cancellation', () => {
  const h = harness()
  const keypad = () => h.render().find(node => node.type === 'keypad')
  h.button('Editar cantidad de 1906').props.onClick()
  keypad().props.onConfirm('999')
  assert.equal(h.button('Aumentar cantidad de 1906').props.disabled, true)
  h.button('Editar cantidad de 1906').props.onClick()
  keypad().props.onConfirm('0')
  h.button('Editar cantidad de Producto fraccionado').props.onClick()
  keypad().props.onConfirm('1,25')
  h.button('Editar cantidad de Producto fraccionado').props.onClick()
  keypad().props.onCancel()
  h.button('Tarjeta').props.onClick()
  h.button('Confirmar devolución').props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(h.refunds)), [{ lines: [{ lineId: 'fraction', quantity: 1.25 }], method: 'card' }])
})
