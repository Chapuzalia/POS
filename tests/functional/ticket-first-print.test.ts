import { expect, it } from 'vitest'
import { createCashTicketActionsHarness } from '../helpers/cash-ticket-actions-harness.mjs'

function renderWithPrintSpy() {
  const harness = createCashTicketActionsHarness()
  const prints: unknown[] = []
  harness.options.printTicket = async (_payload: unknown, options: unknown) => { prints.push(options) }
  return { harness, prints, actions: harness.render() }
}

it('prints a never-printed ticket as the original, not as COPIA, and without opening the drawer', async () => {
  const { harness, prints, actions } = renderWithPrintSpy()
  await actions.reprint({ ...harness.ticket, printStatus: 'not_requested' })
  expect(prints).toEqual([{ isManualPrint: true, cashDrawerAlreadyRequested: true }])
  expect(harness.calls.errors).toEqual([])
})

it.each(['printed', 'unknown', 'pending', 'failed'] as const)('keeps printing a copy once the original reached the printer (%s)', async (printStatus) => {
  const { harness, prints, actions } = renderWithPrintSpy()
  await actions.reprint({ ...harness.ticket, printStatus })
  expect(prints).toEqual([{ isReprint: true, copyNumber: 1 }])
})
