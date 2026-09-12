import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  compileComponent,
  createHookHarness,
  jsxRuntime,
  nodes,
} from './helpers/component-harness.mjs'

const appModalSource = await readFile(new URL('../src/components/ui/AppModal.tsx', import.meta.url), 'utf8')
const cashlogyModalSource = await readFile(new URL('../src/features/local-printing/components/CashlogyPaymentModal.tsx', import.meta.url), 'utf8')

const Modal = Object.assign('modal', {
  Backdrop: 'modal-backdrop',
  Container: 'modal-container',
  Dialog: 'modal-dialog',
  Trigger: 'modal-trigger',
})

const { AppModal } = compileComponent(appModalSource, {
  '@heroui/react': { Modal },
  'react/jsx-runtime': jsxRuntime,
})

function modalDriver(modal) {
  const backdrop = nodes(modal).find((node) => node.type === 'modal-backdrop')
  return {
    clickBackdrop() {
      if (backdrop.props.isDismissable) modal.props.onOpenChange(false)
    },
    isOpen: () => modal.props.isOpen,
    pressEscape() {
      if (!backdrop.props.isKeyboardDismissDisabled) modal.props.onOpenChange(false)
    },
  }
}

test('el modal común se abre y Escape solicita el cierre', () => {
  let closes = 0
  const modal = AppModal({ children: null, onClose: () => { closes += 1 } })
  const driver = modalDriver(modal)

  assert.equal(driver.isOpen(), true)
  driver.pressEscape()
  assert.equal(closes, 1)
})

test('el cobro Cashlogy bloquea Escape y el cierre implícito durante todo el diálogo', () => {
  const hooks = createHookHarness()
  let implicitCloses = 0
  const state = {
    cancel() {},
    closeReviewed() {},
    discardForRetry() {},
    error: null,
    hide: () => { implicitCloses += 1 },
    intent: { amountCents: 600, chargeRequestedAt: null, recoveredFromConflict: false, requestId: 'request', saleId: 'sale' },
    isCancelling: false,
    isPolling: false,
    isStarting: true,
    levels: null,
    modalOpen: true,
    recover() {},
    startPayment() {},
    transaction: null,
  }
  const { CashlogyPaymentModal } = compileComponent(cashlogyModalSource, {
    '../../../components/ui': { AppModal, Button: 'button', Metric: 'metric' },
    '../../../lib/format': { formatMoney: String },
    '../cashlogy/cashlogyError': { isUncertainCashlogyError: () => false },
    '../cashlogy/cashlogyPolling': { cashlogyActiveStatuses: new Set(), cashlogyCancellableStatuses: new Set() },
    '../cashlogy/cashlogyPresentation': { shouldShowCashlogyOperationDetails: () => false },
    '../cashlogy/useCashlogyStore': { useCashlogyStore: (selector) => selector(state) },
    './CashlogyLevelCards': { CashlogyLevelCards: 'levels' },
    'lucide-react': { AlertTriangle: 'icon', Ban: 'icon', CheckCircle2: 'icon', LoaderCircle: 'icon' },
    react: hooks.react,
    'react/jsx-runtime': jsxRuntime,
    'zustand/react/shallow': { useShallow: (selector) => selector },
  })

  const cashlogyDialog = hooks.render(CashlogyPaymentModal, { onFinalizeRecovered() {} })
  const modal = cashlogyDialog.type(cashlogyDialog.props)
  const driver = modalDriver(modal)

  driver.pressEscape()
  driver.clickBackdrop()
  assert.equal(implicitCloses, 0)
})

test('Escape, captura de foco y devolución del foco conservan la integración actual con HeroUI', () => {
  // Falta un entorno DOM ejecutable (Playwright o Testing Library + DOM) para
  // sustituir esta protección por Tab/Escape y document.activeElement reales.
  assert.match(appModalSource, /<Modal\.Trigger[^>]*aria-hidden="true"[^>]*className="(?:hidden|sr-only)"[^>]*tabIndex=\{-1\}[^>]*\/>/)
})
