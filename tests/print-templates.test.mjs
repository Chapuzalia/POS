import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { getMockPrintTemplateContext } from '../src/features/print-templates/catalog.ts'
import { getSafeDefaultPrintTemplate } from '../src/features/print-templates/defaults.ts'
import { renderPrintTemplate, renderPrintTemplateWithFallback } from '../src/features/print-templates/renderer.ts'
import { printTemplateDefinitionSchema } from '../src/features/print-templates/schema.ts'
import { PRINT_TEMPLATE_TYPES } from '../src/features/print-templates/types.ts'
import { mapSaleToPrintRequest } from '../src/features/local-printing/services/ticketPrintMapper.ts'

const layout = { columns: 48, paperWidth: 80, characterSet: 'CP858' }

test('cada tipo tiene una plantilla predeterminada válida y renderizable', () => {
  for (const type of PRINT_TEMPLATE_TYPES) {
    const definition = getSafeDefaultPrintTemplate(type)
    assert.equal(printTemplateDefinitionSchema.safeParse(definition).success, true, type)
    assert.ok(renderPrintTemplate(definition, getMockPrintTemplateContext(type), layout).lines.length > 0, type)
  }
})

test('sustituye variables simples y colecciones anidadas de forma determinista', () => {
  const definition = { version: 1, blocks: [
    { id: 'venue', type: 'text', value: '{{venue.name}}' },
    { id: 'items', type: 'repeat', source: 'items', blocks: [
      { id: 'item', type: 'text', value: '{{quantity}}x {{name}}' },
      { id: 'details', type: 'repeat', source: 'details', blocks: [{ id: 'detail', type: 'text', value: '{{text}}' }] },
    ] },
  ] }
  const rendered = renderPrintTemplate(definition, {
    venue: { name: 'Local A' },
    items: [{ quantity: 2, name: 'Ensalada', details: [{ text: 'Sin cebolla' }] }, { quantity: 1, name: 'Café', details: [] }],
  }, layout)
  assert.deepEqual(rendered.lines, ['Local A', '2x Ensalada', 'Sin cebolla', '1x Café'])
})

test('la comanda agrupada contiene los encabezados y productos de todos sus destinos', () => {
  const rendered = renderPrintTemplate(
    getSafeDefaultPrintTemplate('production'),
    getMockPrintTemplateContext('production'),
    layout,
  )
  const output = rendered.lines.join('\n')
  assert.match(output, /COCINA/)
  assert.match(output, /PLANCHA/)
  assert.match(output, /2x Ensalada/)
  assert.match(output, /2x Entrecot/)
})

test('una variable desconocida queda vacía y las rutas peligrosas nunca se ejecutan', () => {
  globalThis.__templateExecuted = false
  const rendered = renderPrintTemplate({ version: 1, blocks: [
    { id: 'unknown', type: 'text', value: 'Valor: {{unknown.value}}' },
    { id: 'constructor', type: 'text', value: '{{constructor.constructor}}' },
    { id: 'literal', type: 'text', value: 'globalThis.__templateExecuted = true' },
  ] }, {}, layout)
  assert.deepEqual(rendered.lines, ['Valor:', '', 'globalThis.__templateExecuted = true'])
  assert.equal(globalThis.__templateExecuted, false)
  delete globalThis.__templateExecuted
})

test('una plantilla vacía o inválida cae al diseño seguro', () => {
  const fallback = { version: 1, blocks: [{ id: 'safe', type: 'text', value: 'TICKET SEGURO' }] }
  const rendered = renderPrintTemplateWithFallback(
    { version: 1, blocks: [{ id: 'blank', type: 'text', value: '{{missing}}' }] },
    fallback,
    {},
    layout,
  )
  assert.deepEqual(rendered.lines, ['TICKET SEGURO'])
})

test('restaurar obtiene una copia limpia del diseño inicial', () => {
  const initial = getSafeDefaultPrintTemplate('simplified_invoice')
  const customized = getSafeDefaultPrintTemplate('simplified_invoice')
  customized.blocks[0].value = 'DISEÑO PERSONALIZADO'
  assert.deepEqual(getSafeDefaultPrintTemplate('simplified_invoice'), initial)
})

test('una plantilla personalizada modifica el PrintRequest posterior sin cambiar el mapper', () => {
  const request = mapSaleToPrintRequest({
    sale: sampleSale,
    establishment: { name: 'Local A' },
    printerId: 'main',
    printerLayout: layout,
    template: { version: 1, blocks: [{ id: 'custom', type: 'text', value: 'PERSONALIZADO {{ticket.number}}', bold: true }] },
  })
  assert.deepEqual(request.lines, ['PERSONALIZADO T-1'])
  assert.deepEqual(request.elements, [{ type: 'text', value: 'PERSONALIZADO T-1', bold: true }])
  assert.deepEqual(request.options, { cut: true, openCashDrawer: false, copies: 1 })
})

test('migraciones aíslan plantillas por local y agrupan dispatches físicos por impresora', async () => {
  const templates = await readFile(new URL('../supabase/migrations/20260902150000_add_print_templates.sql', import.meta.url), 'utf8')
  const production = await readFile(new URL('../supabase/migrations/20260902151000_group_production_dispatches_by_printer.sql', import.meta.url), 'utf8')
  assert.match(templates, /unique \(tenant_id, venue_id, type\)/i)
  assert.match(templates, /user_has_venue_access\(tenant_id, venue_id\)/i)
  assert.match(templates, /user_is_tenant_admin\(tenant_id\)/i)
  assert.match(templates, /__proto__\|prototype\|constructor/i)
  assert.match(templates, /print_template_defaults/i)
  assert.match(templates, /when insufficient_privilege then\s+raise/i)
  assert.match(production, /group by scoped\.tenant_id, scoped\.venue_id, scoped\.agent_id, scoped\.printer_id/i)
  assert.match(production, /array_agg\(scoped\.destination_id/i)
  assert.match(production, /production_batch_print_context\(p_batch_id, target\.destination_ids\)/i)
  assert.match(production, /'options'.*'cut', true/s)
  assert.doesNotMatch(production, /update public\.production_items[\s\S]*destination_id/i)
})

test('el CRM permite guardar y restaurar sin duplicar el renderer de preview', async () => {
  const page = await readFile(new URL('../src/features/crm/printing/pages/PrintTemplatesPage.tsx', import.meta.url), 'utf8')
  assert.match(page, /savePrintTemplate/)
  assert.match(page, /restoreDefaultPrintTemplate/)
  assert.match(page, /renderPrintTemplateWithFallback/)
  assert.match(page, /PRINT_TEMPLATE_VARIABLES/)
})

test('la resolución usa personalizada, predeterminada persistida y fallback local seguro', async () => {
  const service = await readFile(new URL('../src/features/print-templates/service.ts', import.meta.url), 'utf8')
  assert.match(service, /from\('print_templates'\)/)
  assert.match(service, /from\('print_template_defaults'\)/)
  assert.match(service, /source: 'database-default'/)
  assert.match(service, /source: 'safe-default'/)
})

const sampleSale = {
  ticket: { id: 'T-1', tenantId: 'tenant', cashSessionId: 'cash', cashRegisterId: 'register', venueId: 'venue', deviceId: 'device', userId: 'user', subtotalCents: 1000, discount: null, discountAmountCents: 0, totalCents: 1000, createdAt: '2026-09-02T12:00:00+02:00' },
  lines: [{ id: 'line', ticketId: 'T-1', tenantId: 'tenant', productId: 'p', variantId: null, productName: 'Café', variantName: '', quantity: 1, unitPriceCents: 1000, lineTotalCents: 1000, netTotalCents: 1000, modifiers: [], components: [], fiscalSnapshot: { taxRate: 10, taxableBaseCents: 909, taxAmountCents: 91, grossTotalCents: 1000 } }],
  sale: { id: 'sale', tenantId: 'tenant', ticketId: 'T-1', cashSessionId: 'cash', cashRegisterId: 'register', venueId: 'venue', deviceId: 'device', userId: 'user', totalCents: 1000, paymentMethod: 'card', createdAt: '2026-09-02T12:00:00+02:00' },
  payment: { id: 'pay', tenantId: 'tenant', saleId: 'sale', method: 'card', amountCents: 1000, receivedCents: null, changeCents: 0 },
}
