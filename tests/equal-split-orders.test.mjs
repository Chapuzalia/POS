import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createCompiledHookRunner, expandedNodes, jsxRuntime } from './helpers/component-harness.mjs'
import { createRestaurantControllerHarness, deferred, flush } from './helpers/restaurant-controller-harness.mjs'

const migration = await readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')
const discountMigration = await readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')
const completeDatabase = await readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')
const modal = await readFile(new URL('../src/features/tables/components/EqualSplitOrderModal.tsx', import.meta.url), 'utf8')

test('la division a partes iguales persiste el progreso y cada cobro por separado', () => {
  assert.match(migration, /create table(?: if not exists)? public\.restaurant_order_equal_splits/i)
  assert.match(migration, /create table public\.restaurant_order_equal_split_payments/i)
  assert.match(migration, /create function public\.configure_restaurant_order_equal_split/i)
  assert.match(migration, /create(?: or replace)? function public\.pay_restaurant_order_equal_part/i)
  assert.match(migration, /insert into public\.tickets/)
  assert.match(migration, /insert into public\.sales/)
  assert.match(migration, /insert into public\.sale_payments/)
  assert.match(migration, /unique \(split_id, part_number\)/i)
})

test('los centimos se reparten exactamente y la mesa solo se libera con la ultima parte', () => {
  assert.match(migration, /base_amount := split_row\.total_cents \/ split_row\.part_count/)
  assert.match(migration, /remainder := mod\(split_row\.total_cents, split_row\.part_count\)/)
  assert.match(migration, /part_subtotal := base_amount \+ case when part_number <= remainder then 1 else 0 end/)
  assert.match(migration, /status = case when s\.paid_parts \+ 1 = s\.part_count then 'completed'/)
  assert.match(migration, /if remaining_orders = 0 then[\s\S]+released_at = now\(\)/)
  assert.match(migration, /'nextOrderId'/)
})

test('tras el primer pago no se puede alterar el contenido que sustenta el reparto', () => {
  assert.match(migration, /guard_paid_equal_split_order_lines/)
  assert.match(migration, /s\.status = 'open' and s\.paid_parts > 0/)
  assert.match(migration, /No se puede modificar una comanda con partes ya cobradas/)
  assert.match(migration, /guard_equal_split_order_close/)
})

test('configurar y cobrar una parte ejecuta una sola acción aunque se repita el intento', async () => {
  const rpc = deferred()
  const configurations = []
  let payments = 0
  const split = {
    id: 'split-1', nextDefaultDiscount: { name: 'Heredado' }, nextDefaultTotalCents: 300, nextPartCents: 300,
    paidParts: 0, partCount: 2, remainingCents: 600, remainingParts: 2, status: 'open', totalCents: 600,
  }
  const cashlogyTransaction = { changeCents: 0, id: 'cashlogy-tx', receivedCents: 300, requestId: 'cashlogy-request', requestedAmountCents: 300 }
  let serviceTransaction
  const harness = createRestaurantControllerHarness({ cashlogyTransaction, tableService: {
    configureRestaurantEqualSplit: async (...args) => { configurations.push(args); return split },
    payRestaurantEqualPart: async (...args) => { payments += 1; serviceTransaction = args.at(-1); return rpc.promise },
  } })
  harness.options.appliedDiscount = { name: 'Heredado', type: 'manual' }
  let controller = harness.render()
  await controller.configureEqualSplit(2)
  controller = harness.render()

  const first = controller.payEqualSplitPart('cash', null, false, null, true)
  await flush()
  await assert.rejects(controller.payEqualSplitPart('cash', null, false, null, true), /cobro en curso/)
  assert.equal(payments, 1)

  rpc.resolve({ completed: false, paidAmountCents: 300, paymentId: 'payment', requiresConfirmation: false, saleId: 'sale', split: { ...split, paidParts: 1, remainingCents: 300, remainingParts: 1 }, ticketId: 'ticket' })
  harness.mapRefresh.resolve({ areas: [{ id: 'area' }], tables: [] })
  await first

  assert.equal(configurations.length, 1)
  assert.equal(configurations[0][1], 2)
  assert.equal(configurations[0][3].name, 'Heredado')
  assert.equal(harness.render().equalSplit.paidParts, 1)
  assert.equal(payments, 1)
  assert.strictEqual(serviceTransaction, cashlogyTransaction)
  assert.deepEqual(harness.calls.cashlogySettlements, [300])
})

test('el descuento previo se hereda sin multiplicar importes fijos', () => {
  assert.match(discountMigration, /default_discount jsonb/)
  assert.match(discountMigration, /resolve_ticket_discount\([\s\S]+p_default_discount/)
  assert.match(discountMigration, /default_discount = excluded\.default_discount/)
  assert.match(discountMigration, /default_discount ->> 'amountCents'\)::integer, 0\) \/ split_row\.part_count/)
  assert.match(discountMigration, /nextDefaultDiscount/)
  const allocate = (cents, parts) => Array.from({ length: parts }, (_, index) =>
    Math.floor(cents / parts) + (index < cents % parts ? 1 : 0))
  const grossParts = allocate(1001, 3)
  const inheritedDiscountParts = allocate(200, 3)
  assert.deepEqual(grossParts, [334, 334, 333])
  assert.deepEqual(inheritedDiscountParts, [67, 67, 66])
  assert.equal(grossParts.reduce((sum, cents, index) => sum + cents - inheritedDiscountParts[index], 0), 801)
})

test('cada parte puede conservar, cambiar o quitar su descuento', () => {
  assert.match(discountMigration, /p_discount jsonb default null/i)
  assert.match(discountMigration, /p_use_default_discount boolean default true/i)
  assert.match(discountMigration, /if p_use_default_discount and split_row\.default_discount is not null/)
  assert.match(discountMigration, /resolve_ticket_discount\([\s\S]+part_subtotal, p_discount/)
  assert.match(discountMigration, /discount_name, discount_type/)
  assert.match(discountMigration, /discount_amount_cents, discount, amount_cents/)
})

test('realtime no restaura un descuento quitado mientras siga siendo la misma parte', async () => {
  const ProgressBar = Object.assign((props) => ({ type: 'progress', props }), { Fill: 'progress-fill', Track: 'progress-track' })
  const runner = createCompiledHookRunner(modal, 'EqualSplitOrderModal', {
    'react/jsx-runtime': jsxRuntime,
    '../../../utils/errors.ts': { getReadableError: (error) => error?.message ?? String(error) },
    '../../../components/ui/Input': { Input: 'input' },
    '../../../components/ui/Button': { Button: 'button' },
    '../../../components/ui/AppModal': { AppModal: 'modal' },
    '@heroui/react': { ProgressBar },
    'lucide-react': { Check: 'check', Minus: 'minus', Plus: 'plus', UsersRound: 'users', X: 'close' },
    '../../../components/modals': { CashPaymentModal: 'cash-modal', DiscountModal: 'discount-modal' },
    '../../../components/pos': { PaymentPanel: 'payment-panel' },
    '../../local-printing': { usePrintAgentStore: (selector) => selector({ cashlogyConfigured: false }) },
    '../../../lib/discounts': {
      calculateAppliedDiscount: (totalCents, discount) => ({ discountAmountCents: discount ? 100 : 0, totalCents: discount ? totalCents - 100 : totalCents }),
      calculateDiscountForLines: () => ({ discountAmountCents: 0, totalCents: 600 }),
    },
    '../../../lib/format': { formatMoney: String },
  }, { window: { setTimeout() { return 1 } } })
  const onPayCalls = []
  const inherited = { name: 'Heredado', type: 'manual' }
  const split = { id: 'split-1', nextDefaultDiscount: inherited, nextDefaultDiscountAmountCents: 100, nextDefaultTotalCents: 200, nextPartCents: 300, paidParts: 0, partCount: 2, remainingCents: 600, remainingParts: 2, totalCents: 600 }
  const props = {
    defaultDiscount: inherited, discounts: [], discountSchedule: {}, isBusy: false, manualDiscountEnabled: true, manualDiscountRequiresPin: false,
    onClose() {}, onCompleted() {}, onConfigure: async () => split, onPay: async (...args) => { onPayCalls.push(args); return { completed: false, requiresConfirmation: false, split } },
    order: { lines: [{ productId: 'product', quantity: 1, unitPriceCents: 600, variantId: 'variant' }], order: { guestCount: 2 }, tables: [], totalCents: 600 },
    split, validateManualPin: async () => true, validatePin: async () => true, venueId: 'venue',
  }

  runner.render(props)
  let paymentPanel = expandedNodes(runner.render(props)).find((node) => node.type === 'payment-panel')
  assert.equal(paymentPanel.props.discount.name, 'Heredado')
  paymentPanel.props.onRemoveDiscount()

  const refreshedProps = { ...props, split: { ...split, remainingCents: 590 } }
  runner.render(refreshedProps)
  paymentPanel = expandedNodes(runner.render(refreshedProps)).find((node) => node.type === 'payment-panel')
  assert.equal(paymentPanel.props.discount, null)
  paymentPanel.props.onPayment('card')
  await flush()
  assert.equal(onPayCalls[0][3], null)
  assert.equal(onPayCalls[0][4], false)
})

test('un descuento completo permite finalizar una parte sin metodo de pago', () => {
  assert.match(discountMigration, /if part_total = 0 then[\s\S]+p_payment_method is not null/)
  assert.match(discountMigration, /if part_total > 0 then[\s\S]+insert into public\.sale_payments/)
  assert.match(discountMigration, /restaurant_order_equal_split_payments_payment_method_check/)
})

test('la publicación SQL conserva la recuperación de la división entre dispositivos', () => {
  assert.match(migration, /'restaurant_order_equal_splits'/)
  assert.match(migration, /alter publication supabase_realtime add table public\.%I/i)
})

test('la migracion esta incorporada en la base completa', () => {
  assert.match(completeDatabase, /create table(?: if not exists)? public\.restaurant_order_equal_splits/i)
  assert.match(completeDatabase, /create(?: or replace)? function public\.pay_restaurant_order_equal_part/i)
  assert.match(completeDatabase, /default_discount jsonb/)
  assert.match(completeDatabase, /discount_amount_cents integer default 0 not null/i)
})
