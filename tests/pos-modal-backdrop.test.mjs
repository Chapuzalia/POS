import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('the shared POS modal delegates dismissal, focus trap and Escape to HeroUI', async () => {
  const source = await readFile(new URL('../src/components/ui/AppModal.tsx', import.meta.url), 'utf8')

  assert.match(source, /from ["']@heroui\/react["']/)
  assert.match(source, /<Modal\.Backdrop/)
  assert.match(source, /isDismissable=\{!dismissDisabled\}/)
  assert.match(source, /isKeyboardDismissDisabled=\{dismissDisabled\}/)
})

test('POS modal families use the shared HeroUI modal policy', async () => {
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
    '../src/components/screens/LoginScreen.tsx',
    '../src/components/pos/MobileTicketModal.tsx',
    '../src/components/superadmin/SuperAdminPage.tsx',
    '../src/features/tables/components/RemoveOrderLineModal.tsx',
    '../src/features/tables/components/EqualSplitOrderModal.tsx',
    '../src/features/tables/components/SplitOrderModal.tsx',
    '../src/features/tables/components/TableMapView.tsx',
    '../src/features/reservations/components/ReservationFormModal.tsx',
    '../src/features/reservations/components/ReservationDetailPanel.tsx',
    '../src/features/local-printing/components/PrintAgentSetupWizard.tsx',
    '../src/features/local-printing/components/CertificateHelpDialog.tsx',
    '../src/app/PosPage.tsx',
  ]

  for (const sourcePath of modalSources) {
    const source = await readFile(new URL(sourcePath, import.meta.url), 'utf8')
    assert.match(source, /<AppModal/, `${sourcePath} must use the shared HeroUI modal`)
    assert.doesNotMatch(source, /aria-modal|role=["']dialog["']|closeOnModalBackdrop/)
  }
})

test('the cash movement modal is centered and keeps long actions inside its width', async () => {
  const source = await readFile(new URL('../src/components/modals/CashMovementModal.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /placement=["']bottom["']/)
  assert.match(source, /containerClassName=["']!p-4["']/)
  assert.match(source, /min-w-0 max-w-full/)
  assert.match(source, /!whitespace-normal/)
})

test('the ticket history payment selector renders one shared border', async () => {
  const [modal, nativeSelect] = await Promise.all([
    readFile(new URL('../src/components/modals/SessionTicketsModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/ui/NativeSelect.tsx', import.meta.url), 'utf8'),
  ])

  assert.match(nativeSelect, /triggerClassName\?: string/)
  assert.match(modal, /triggerClassName="!min-h-8 !border-0 !bg-transparent !px-0 !shadow-none"/)
  assert.match(modal, /focus-within:border-\[var\(--accent\)\]/)
})
