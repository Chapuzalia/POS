import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { closeOnModalBackdrop } from '../src/components/modals/modalBackdrop.ts'

test('a modal closes only when the backdrop itself is clicked', () => {
  let closes = 0
  const backdrop = {}

  closeOnModalBackdrop({ currentTarget: backdrop, target: {} }, () => { closes += 1 })
  assert.equal(closes, 0)

  closeOnModalBackdrop({ currentTarget: backdrop, target: backdrop }, () => { closes += 1 })
  assert.equal(closes, 1)

  closeOnModalBackdrop({ currentTarget: backdrop, target: backdrop }, () => { closes += 1 }, true)
  assert.equal(closes, 1)
})

test('POS modal families share the backdrop dismissal rule', async () => {
  const modalSources = [
    '../src/components/modals/CashPaymentModal.tsx',
    '../src/components/modals/CashMovementModal.tsx',
    '../src/components/modals/CloseCashModal.tsx',
    '../src/components/modals/DiscountModal.tsx',
    '../src/components/modals/ProductDialog.tsx',
    '../src/components/modals/SessionTicketsModal.tsx',
    '../src/components/modals/CashClosingResultModal.tsx',
    '../src/components/modals/CashClosingsHistoryModal.tsx',
    '../src/components/modals/ConfigModal.tsx',
    '../src/features/tables/components/RemoveOrderLineModal.tsx',
    '../src/features/tables/components/EqualSplitOrderModal.tsx',
    '../src/features/tables/components/SplitOrderModal.tsx',
    '../src/features/tables/components/TableMapView.tsx',
    '../src/features/local-printing/components/PrintAgentSetupWizard.tsx',
    '../src/features/local-printing/components/CertificateHelpDialog.tsx',
    '../src/app/PosPage.tsx',
  ]

  for (const sourcePath of modalSources) {
    const source = await readFile(new URL(sourcePath, import.meta.url), 'utf8')
    assert.match(source, /closeOnModalBackdrop/, `${sourcePath} must dismiss from its backdrop`)
  }
})
