import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { createCompiledHookRunner, jsxRuntime, nodes } from '../helpers/component-harness.mjs'

const source = readFileSync(new URL('../../src/features/local-printing/components/CashlogyPaymentModal.tsx', import.meta.url), 'utf8')

function harness(status: string | null = 'unknown', finalize = vi.fn(async (_transaction: object) => {}), confirm = vi.fn(async (_message: string) => true)) {
  const transaction = { id: 'tx', requestId: 'request', status: 'completed', automaticAcceptedCents: 1250, returnedCents: 0 }
  const state = {
    modalOpen: true, intent: { requestId: 'request', amountCents: 1250 },
    transaction: status ? { ...transaction, status } : null, error: new Error('Error de prueba') as Error | null,
    levels: [] as Array<{ index: number; valueCents: number; percentage: number; state: string }>,
    isStarting: false, isPolling: false, isRecovering: false, isCancelling: false, missingTransaction: false,
    recover: vi.fn(async (): Promise<typeof transaction | null> => { throw new Error('La recuperación ha fallado') }),
    cancelAttempt: vi.fn(async () => { state.modalOpen = false }),
    confirmPaid: vi.fn(async () => transaction),
  }
  const cancelled = vi.fn()
  const runner = createCompiledHookRunner(source, 'CashlogyPaymentModal', {
    'react/jsx-runtime': jsxRuntime, '../../../components/ui/appDialogStore': { appConfirm: confirm }, 'lucide-react': { AlertTriangle: 'icon', LoaderCircle: 'spinner' },
    'zustand/react/shallow': { useShallow: (selector: object) => selector },
    '../../../components/ui': { AppModal: 'modal', Button: 'button', Metric: 'metric' },
    '../../../lib/format': { formatMoney: (cents: number) => String(cents) },
    './CashlogyLevelCards': { CashlogyLevelCards: 'levels' },
    '../cashlogy/useCashlogyStore': { useCashlogyStore: Object.assign((selector: (value: typeof state) => object) => selector(state), { getState: () => state }) },
  }, { Error })
  const render = (props: { finalizeDisabled?: boolean } = {}) => runner.render({ onFinalizeRecovered: finalize, onCancelled: cancelled, ...props })
  const buttons = () => nodes(render()).filter(node => node.type === 'button')
  return { state, finalize, cancelled, confirm, render, buttons,
    click: (label: string) => buttons().find(node => node.props.children === label).props.onClick() }
}

it.each([null, 'unknown', 'needs_attention', 'failed', 'cancelled'])('offers cancel and a recovery action in error state %s', status => {
  const h = harness(status)
  expect(h.buttons().map(button => button.props.children)).toEqual(['Cancelar cobro', 'Reintentar'])
  expect(h.buttons()[0].props.disabled).toBeFalsy()
  expect(nodes(h.render()).some(node => node.props?.role === 'alert')).toBe(true)
  expect(nodes(h.render()).some(node => node.type === 'input')).toBe(false)
})

it('keeps cancellation enabled while recovering and ignores a late successful recovery', async () => {
  const h = harness()
  let finish = (_value: NonNullable<typeof h.state.transaction>) => {}
  h.state.recover.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  h.click('Reintentar')
  const buttons = nodes(h.render({ finalizeDisabled: true })).filter(node => node.type === 'button')
  expect(buttons.map(button => button.props.children)).toEqual(['Cancelar cobro'])
  expect(buttons[0].props.disabled).toBeFalsy()
  buttons[0].props.onClick()
  buttons[0].props.onClick()
  await vi.waitFor(() => expect(h.cancelled).toHaveBeenCalledOnce())
  expect(h.state.cancelAttempt).toHaveBeenCalledOnce()
  finish({ ...h.state.transaction, id: 'tx', requestId: 'request', status: 'completed', automaticAcceptedCents: 1250, returnedCents: 0 })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(h.finalize).not.toHaveBeenCalled()
  expect(h.render()).toBeNull()
})

it('does not let a cancelled recovery failure unlock or change a new retry', async () => {
  const h = harness()
  let fail = (_error: Error) => {}
  h.state.recover.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  h.click('Reintentar')
  h.click('Cancelar cobro')
  await vi.waitFor(() => expect(h.cancelled).toHaveBeenCalledOnce())
  h.state.modalOpen = true
  h.state.intent = { requestId: 'next-request', amountCents: 500 }
  h.state.recover.mockImplementationOnce(() => new Promise(() => {}))
  h.click('Reintentar')
  fail(new Error('Respuesta tardía'))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(h.buttons().map(button => button.props.children)).toEqual(['Cancelar cobro'])
  expect(JSON.stringify(h.render())).not.toContain('Respuesta tardía')
  h.click('Cancelar cobro')
  await vi.waitFor(() => expect(h.cancelled).toHaveBeenCalledTimes(2))
  expect(h.state.cancelAttempt).toHaveBeenCalledTimes(2)
})

it('prevents cancellation once the recovered payment is being registered', async () => {
  const finalize = vi.fn((_transaction: object) => new Promise<void>(() => {}))
  const h = harness('completed', finalize)
  h.click('Reintentar')
  expect(h.buttons().map(button => button.props.children)).toEqual(['Cancelar cobro'])
  expect(h.buttons()[0].props.disabled).toBe(true)
  h.click('Cancelar cobro')
  expect(h.state.cancelAttempt).not.toHaveBeenCalled()
  expect(finalize).toHaveBeenCalledOnce()
})

it('a failed recovery replaces retry with cancel and mark paid, without starting another charge', async () => {
  const h = harness()
  h.click('Reintentar')
  await vi.waitFor(() => expect(h.buttons().map(button => button.props.children)).toEqual(['Cancelar cobro', 'Marcar como pagado']))
  expect(h.state.recover).toHaveBeenCalledOnce()
  expect(h.finalize).not.toHaveBeenCalled()
  h.click('Marcar como pagado')
  await vi.waitFor(() => expect(h.finalize).toHaveBeenCalledOnce())
  expect(h.state.confirmPaid).toHaveBeenCalledOnce()
})

it('retries registration directly when Cashlogy already confirmed the payment', async () => {
  const finalize = vi.fn(async (_transaction: object) => { throw new Error('No se pudo guardar la venta') })
  const h = harness('completed', finalize)
  h.click('Reintentar')
  await vi.waitFor(() => expect(JSON.stringify(h.render())).toContain('No se pudo guardar la venta'))
  expect(h.buttons().map(button => button.props.children)).toEqual(['Cancelar cobro', 'Marcar como pagado'])
  expect(h.state.recover).not.toHaveBeenCalled()
  expect(h.finalize).toHaveBeenCalledOnce()
  expect(JSON.stringify(h.render())).toContain('No se pudo guardar la venta')
})

it('cancels and returns to the ticket without another confirmation', async () => {
  const h = harness()
  h.click('Reintentar')
  await vi.waitFor(() => expect(h.buttons()).toHaveLength(2))
  h.click('Cancelar cobro')
  await vi.waitFor(() => expect(h.cancelled).toHaveBeenCalledOnce())
  expect(h.render()).toBeNull()
  expect(h.finalize).not.toHaveBeenCalled()
})

it('does not apply a previous recovery failure to a different payment attempt', async () => {
  const h = harness()
  h.click('Reintentar')
  await vi.waitFor(() => expect(h.buttons()).toHaveLength(2))
  h.state.intent = { requestId: 'next-request', amountCents: 500 }
  expect(h.buttons().map(button => button.props.children)).toEqual(['Cancelar cobro', 'Reintentar'])
})

it('shows the coins and notes available for change while charging', () => {
  const h = harness('waiting_for_cash')
  h.state.error = null
  h.state.levels = [{ index: 0, valueCents: 200, percentage: 40, state: 'ok' }, { index: 1, valueCents: 1000, percentage: 5, state: 'low' }]
  const levelCards = nodes(h.render()).filter(node => node.type === 'levels')
  expect(levelCards).toHaveLength(1)
  expect(levelCards[0].props).toEqual({ levels: h.state.levels, variant: 'payment' })
})

it('keeps cancel enabled while Cashlogy waits for cash, even with the sale busy', async () => {
  const h = harness('waiting_for_cash')
  h.state.error = null
  h.state.isPolling = true
  const buttons = nodes(h.render({ finalizeDisabled: true })).filter(node => node.type === 'button')
  expect(buttons.map(button => button.props.children)).toEqual(['Cancelar cobro'])
  expect(buttons[0].props.disabled).toBeFalsy()
  buttons[0].props.onClick()
  await vi.waitFor(() => expect(h.cancelled).toHaveBeenCalledOnce())
  expect(h.confirm).not.toHaveBeenCalled()
})

it('asks before cancelling a charge Cashlogy already collected, and keeps it when declined', async () => {
  const h = harness('completed', undefined, vi.fn(async (_message: string) => false))
  h.state.error = null
  h.click('Cancelar cobro')
  await vi.waitFor(() => expect(h.confirm).toHaveBeenCalledOnce())
  expect(h.state.cancelAttempt).not.toHaveBeenCalled()
  h.confirm.mockResolvedValueOnce(true)
  h.click('Cancelar cobro')
  await vi.waitFor(() => expect(h.cancelled).toHaveBeenCalledOnce())
})
