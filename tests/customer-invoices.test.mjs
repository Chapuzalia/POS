import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { normalizeCustomerTaxId, validateCustomerCreateInput } from '../src/features/customers/customerValidation.ts'
import { buildSalePayload } from '../src/features/quick-sale/services/salePayload.ts'
import { mapSaleToPrintRequest } from '../src/features/local-printing/services/ticketPrintMapper.ts'

const migration = await readFile(new URL('../supabase/migrations/20260821180000_add_invoice_customers.sql', import.meta.url), 'utf8')
const fiscalMigration = await readFile(new URL('../supabase/migrations/20260803220000_add_verifacti_integration.sql', import.meta.url), 'utf8')
const customerService = await readFile(new URL('../src/features/customers/service.ts', import.meta.url), 'utf8')
const customerModal = await readFile(new URL('../src/features/customers/CustomerInvoiceModal.tsx', import.meta.url), 'utf8')
const quickSaleHook = await readFile(new URL('../src/features/quick-sale/hooks/useQuickSale.ts', import.meta.url), 'utf8')
const posPage = await readFile(new URL('../src/app/PosPage.tsx', import.meta.url), 'utf8')

const customer = {
  id: 'customer-1', tenantId: 'tenant', legalName: 'Alteil Solutions S.L.', taxId: 'B12345678',
  address: 'Calle Mayor 1', postalCode: '08700', city: 'Igualada', province: 'Barcelona', country: 'España',
  email: 'facturas@alteil.test', phone: null, createdAt: '2026-08-21T10:00:00Z', updatedAt: '2026-08-21T10:00:00Z',
}
const context = {
  tenantId: 'tenant', venueId: 'venue', venueDefaultTaxRate: 21, deviceId: 'device', userId: 'user',
}
const cashSession = { id: 'cash', cashRegisterId: 'register' }
const layout = { columns: 48, paperWidth: 80, characterSet: 'CP858' }

function line(id, cents, vatRate) {
  return {
    id, productId: `product-${id}`, productName: id, variantId: `variant-${id}`, variantName: id,
    basePriceCents: cents, componentDeltaCents: 0, modifierDeltaCents: 0, unitPriceCents: cents, quantity: 1,
    modifiers: [], components: [], catalogSnapshot: {
      placementId: null, productType: 'standard', productId: `product-${id}`, productName: id,
      variantId: `variant-${id}`, variantName: id, basePriceCents: cents, vatRate,
      categoryId: null, categoryName: '', catalogTabId: null, catalogTabName: '', saleFormatId: null, saleFormatName: id,
    },
  }
}

function payload(lines, discount = null, invoiceCustomer = null) {
  const originalWindow = globalThis.window
  globalThis.window = { ...originalWindow, crypto: globalThis.crypto }
  try {
    return buildSalePayload(context, cashSession, lines, 'card', null, discount, invoiceCustomer)
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
}

test('valida los campos obligatorios y normaliza NIF/CIF equivalentes', () => {
  assert.equal(normalizeCustomerTaxId(' b-12 345.678 '), 'B12345678')
  assert.throws(() => validateCustomerCreateInput({ ...customer, legalName: '' }), /razón social/i)
  assert.throws(() => validateCustomerCreateInput({ ...customer, postalCode: '' }), /código postal/i)
  assert.equal(validateCustomerCreateInput(customer).country, 'España')
  assert.equal(validateCustomerCreateInput({ ...customer, country: '' }).country, 'España')
})

test('crear cliente valida y persiste todos los datos fiscales desde el modal', () => {
  assert.match(customerModal, /Nombre \/ Razón social/)
  assert.match(customerModal, /Guardar y seleccionar/)
  assert.match(customerService, /rpc\('create_invoice_customer'/)
  assert.match(migration, /insert into public\.customers[\s\S]*legal_name, tax_id, address, postal_code, city, province, country, email, phone/i)
})

test('buscar cliente admite nombre, razón social y NIF/CIF con resultados compactos', () => {
  assert.match(customerModal, /Busca por nombre, razón social o NIF\/CIF/)
  assert.match(customerService, /rpc\('search_invoice_customers'/)
  assert.match(migration, /customer\.legal_name ilike/i)
  assert.match(migration, /customer\.tax_id_normalized like/i)
})

test('RLS aísla clientes por tenant', () => {
  assert.match(migration, /alter table public\.customers enable row level security/i)
  assert.match(migration, /create policy customers_select[\s\S]*user_has_tenant_access\(tenant_id\)/i)
  assert.match(migration, /customer\.tenant_id = p_tenant_id/i)
})

test('evita NIF/CIF duplicado dentro del mismo tenant incluso con formato distinto', () => {
  assert.match(migration, /unique \(tenant_id, tax_id_normalized\)/i)
  assert.match(migration, /CUSTOMER_TAX_ID_DUPLICATE/i)
  assert.equal(normalizeCustomerTaxId('B-12345678'), normalizeCustomerTaxId('b 12345678'))
})

test('la migración crea, busca y aísla clientes por tenant, con NIF/CIF único normalizado', () => {
  assert.match(migration, /create table public\.customers/i)
  assert.match(migration, /unique \(tenant_id, tax_id_normalized\)/i)
  assert.match(migration, /create policy customers_select[\s\S]*user_has_tenant_access\(tenant_id\)/i)
  assert.match(migration, /create policy customers_insert[\s\S]*with check \(public\.user_has_tenant_access\(tenant_id\)\)/i)
  assert.match(migration, /create or replace function public\.search_invoice_customers/i)
  assert.match(migration, /customer\.tenant_id = p_tenant_id/i)
  assert.match(migration, /CUSTOMER_TAX_ID_DUPLICATE/i)
  assert.match(customerService, /rpc\('search_invoice_customers'/)
  assert.match(customerService, /rpc\('create_invoice_customer'/)
})

test('asocia y quita cliente sin cambiar el ticket normal', () => {
  const normal = payload([line('Café', 1100, 10)])
  const invoice = payload([line('Café', 1100, 10)], null, customer)
  assert.equal(normal.ticket.invoice, null)
  assert.equal(invoice.ticket.invoice.customerId, customer.id)
  assert.equal(invoice.ticket.invoice.customer.legalName, customer.legalName)
  assert.match(quickSaleHook, /removeInvoiceCustomer: \(\) => setInvoiceCustomer\(null\)/)
  assert.match(posPage, /Factura ·|invoiceCustomerName/)
})

test('quitar cliente devuelve el borrador a ticket normal', () => {
  assert.match(quickSaleHook, /removeInvoiceCustomer: \(\) => setInvoiceCustomer\(null\)/)
  assert.match(posPage, /onRemoveInvoiceCustomer=\{removeInvoiceCustomer\}/)
})

test('un ticket normal no contiene cliente ni consume numeración de factura', () => {
  const normal = payload([line('Agua', 200, 10)])
  assert.equal(normal.ticket.invoice, null)
  assert.match(migration, /customer_id_value := nullif\(current_setting\('app\.invoice_customer_id', true\), ''\)::uuid/i)
  assert.match(migration, /if customer_id_value is null then return new; end if/i)
})

test('una factura contiene cliente y snapshot fiscal antes de sincronizar', () => {
  const billed = payload([line('Agua', 200, 10)], null, customer)
  assert.equal(billed.ticket.invoice.customerId, customer.id)
  assert.deepEqual(billed.ticket.invoice.customer, {
    legalName: customer.legalName, taxId: customer.taxId, address: customer.address,
    postalCode: customer.postalCode, city: customer.city, province: customer.province,
    country: customer.country, email: customer.email, phone: customer.phone,
  })
})

test('el snapshot fiscal queda desacoplado de cambios posteriores del cliente', () => {
  const sourceCustomer = { ...customer }
  const invoice = payload([line('Café', 1100, 10)], null, sourceCustomer)
  sourceCustomer.legalName = 'Nombre cambiado después'
  sourceCustomer.address = 'Otra dirección'
  assert.equal(invoice.ticket.invoice.customer.legalName, 'Alteil Solutions S.L.')
  assert.equal(invoice.ticket.invoice.customer.address, 'Calle Mayor 1')
  assert.match(migration, /new\.customer_snapshot := jsonb_build_object/i)
  assert.match(migration, /INVOICE_SNAPSHOT_IMMUTABLE/i)
})

test('la numeración usa la secuencia fiscal atómica y una restricción única concurrente', () => {
  assert.match(migration, /next_fiscal_invoice_number\(new\.tenant_id, new\.invoice_series\)/i)
  assert.match(fiscalMigration, /update public\.fiscal_invoice_sequences[\s\S]*set last_value = last_value \+ 1[\s\S]*returning last_value into v_number/i)
  assert.match(migration, /new\.invoice_series := 'F-' \|\| to_char/i)
  assert.match(migration, /new\.invoice_number := lpad\(sequence_value::text, 6, '0'\)/i)
  assert.match(migration, /create unique index tickets_tenant_invoice_number_idx[\s\S]*tenant_id, invoice_series, invoice_number/i)
  assert.doesNotMatch(migration, /max\s*\(\s*invoice_number|order by invoice_number desc/i)
})

test('la numeración correlativa se asigna en base de datos, nunca con last + 1 en frontend', () => {
  assert.match(fiscalMigration, /insert into public\.fiscal_invoice_sequences[\s\S]*on conflict \(tenant_id, series\)[\s\S]*set last_value = last_value \+ 1/i)
  assert.match(migration, /next_fiscal_invoice_number\(new\.tenant_id, new\.invoice_series\)/i)
  assert.doesNotMatch(customerService + quickSaleHook, /last\s*\+\s*1|max\s*\(\s*invoice/i)
})

test('una restricción única protege frente a números duplicados concurrentes', () => {
  assert.match(migration, /create unique index tickets_tenant_invoice_number_idx[\s\S]*where is_invoice/i)
  assert.match(fiscalMigration, /update public\.fiscal_invoice_sequences[\s\S]*returning last_value into v_number/i)
})

test('el ticket normal conserva su impresión y la factura añade emisor, destinatario y número', () => {
  const normal = payload([line('Café', 1100, 10)])
  const billed = payload([line('Café', 1100, 10)], null, customer)
  billed.ticket.invoice = { ...billed.ticket.invoice, series: 'F-2026', number: '000123', issuedAt: '2026-08-21T12:00:00+02:00' }
  const establishment = { name: 'TICKIT BAR', legalName: 'TICKIT BAR S.L.', taxId: 'B87654321', address: 'Plaça Major 2' }
  const normalText = mapSaleToPrintRequest({ sale: normal, establishment, printerId: 'main', printerLayout: layout }).lines.join('\n')
  const invoiceText = mapSaleToPrintRequest({ sale: billed, establishment, printerId: 'main', printerLayout: layout }).lines.join('\n')
  assert.doesNotMatch(normalText, /FACTURA|Alteil Solutions/)
  assert.match(normalText, /Ticket/)
  assert.match(invoiceText, /FACTURA/)
  assert.match(invoiceText, /F-2026-000123/)
  assert.match(invoiceText, /TICKIT BAR S\.L\./)
  assert.match(invoiceText, /Alteil Solutions S\.L\./)
  assert.match(invoiceText, /B12345678/)
  assert.match(invoiceText, /Calle Mayor 1/)
  assert.match(invoiceText, /08700 Igualada/)
  assert.match(invoiceText, /Barcelona/)
})

test('la previsualización de factura muestra borrador y no usa el UUID como número fiscal', () => {
  const billed = payload([line('Café', 1100, 10)], null, customer)
  const text = mapSaleToPrintRequest({
    sale: billed,
    establishment: { name: 'TICKIT BAR' },
    printerId: 'main',
    printerLayout: layout,
    isPreTicket: true,
  }).lines.join('\n')
  assert.match(text, /FACTURA \(BORRADOR\)/)
  assert.match(text, /Pendiente de numeración/)
  assert.doesNotMatch(text, new RegExp(billed.ticket.id))
})

test('la factura imprime descuentos y varios tipos de IVA desde los importes finales cobrados', () => {
  const discount = { discountId: null, name: 'Descuento 20 %', type: 'manual', calculationType: 'percentage', value: 20, roundingIncrementCents: null, color: null }
  const billed = payload([line('IVA 21', 1210, 21), line('IVA 10', 1100, 10)], discount, customer)
  billed.ticket.invoice = { ...billed.ticket.invoice, series: 'F-2026', number: '000124', issuedAt: billed.sale.createdAt }
  const text = mapSaleToPrintRequest({ sale: billed, establishment: { name: 'TICKIT BAR' }, printerId: 'main', printerLayout: layout }).lines.join('\n')
  assert.equal(billed.sale.totalCents, 1848)
  assert.match(text, /Descuento[ ]+-4,62 €/)
  assert.match(text, /Base imponible[ ]+16,00 €/)
  assert.match(text, /IVA 10 %[ ]+0,80 €/)
  assert.match(text, /IVA 21 %[ ]+1,68 €/)
  assert.match(text, /TOTAL[ ]+18,48 €/)
})

test('la factura de mesa y la venta rápida pasan el customerId solo a RPC de servidor', () => {
  assert.match(migration, /create or replace function public\.sync_invoice_sale_created/i)
  assert.match(migration, /create or replace function public\.close_restaurant_order_with_invoice/i)
  assert.match(migration, /set_config\('app\.invoice_customer_id', p_customer_id::text, true\)/i)
  assert.match(migration, /El cliente no pertenece al negocio/i)
})
