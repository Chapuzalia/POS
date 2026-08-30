import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { ProviderHttpError, requestVerifactiJson } from '../supabase/functions/_shared/verifacti/client.ts'
import { constantTimeEqual, decryptSecret, encryptSecret, webhookSignature } from '../supabase/functions/_shared/verifacti/crypto.ts'
import {
  groupTaxSnapshots,
  mapFiscalCancellation,
  mapProviderStatus,
  mapTicketBaiInvoice,
  mapVerifactuInvoice,
  stableFiscalIdempotencyKey,
} from '../supabase/functions/_shared/verifacti/mapping.ts'
import { TicketBaiProvider, VerifactuProvider } from '../supabase/functions/_shared/verifacti/providers.ts'

const tenantId = '16a9dccf-03a7-438d-9594-66b6ed820596'
const invoiceId = 'db250d8b-1f26-445e-9c95-f7fe3a620063'

function invoice(overrides = {}) {
  return {
    id: invoiceId,
    tenant_id: tenantId,
    venue_id: 'b2db3170-0dc0-42fc-bd36-30e5dfa30d17',
    ticket_id: '44d3db88-98f0-42f3-af76-935ae89ffc03',
    sale_id: null,
    provider: 'verifactu',
    environment: 'test',
    invoice_type: 'simplified',
    series: 'POS',
    number: '42',
    issue_date: '2026-08-03',
    operation_date: '2026-08-02',
    document_data: { descripcion: 'Consumiciones' },
    status: 'pending',
    pending_operation: 'create',
    idempotency_key: `${tenantId}:${invoiceId}:create`,
    external_uuid: null,
    attempts: 0,
    ...overrides,
  }
}

function ticket(overrides = {}) {
  return {
    id: '44d3db88-98f0-42f3-af76-935ae89ffc03',
    tenant_id: tenantId,
    venue_id: 'b2db3170-0dc0-42fc-bd36-30e5dfa30d17',
    total_cents: 1760,
    local_created_at: '2026-08-03T10:00:00.000Z',
    ticket_lines: [
      {
        id: 'line-21',
        product_name: 'Menu',
        variant_name: 'Grande',
        quantity: 1,
        net_total_cents: 1210,
        taxable_base_cents: 1000,
        tax_amount_cents: 210,
        tax_rate: 21,
      },
      {
        id: 'line-10',
        product_name: 'Pan',
        variant_name: '',
        quantity: 2,
        net_total_cents: 550,
        taxable_base_cents: 500,
        tax_amount_cents: 50,
        tax_rate: 10,
      },
    ],
    ...overrides,
  }
}

test('agrupa bases y cuotas por tipo de IVA usando los snapshots inmutables', () => {
  assert.deepEqual(groupTaxSnapshots(ticket().ticket_lines), [
    { baseCents: 500, taxCents: 50, rate: 10 },
    { baseCents: 1000, taxCents: 210, rate: 21 },
  ])
  assert.throws(
    () => groupTaxSnapshots([{ ...ticket().ticket_lines[0], taxable_base_cents: 999 }]),
    /no cuadra con su total neto/,
  )
  assert.throws(
    () => groupTaxSnapshots([{ ...ticket().ticket_lines[0], tax_rate: null }]),
    /snapshot fiscal completo/,
  )
})

test('mapea una factura simplificada al contrato exacto de VeriFactu', () => {
  assert.deepEqual(mapVerifactuInvoice(invoice(), ticket()), {
    serie: 'POS',
    numero: '42',
    fecha_expedicion: '03-08-2026',
    fecha_operacion: '02-08-2026',
    tipo_factura: 'F2',
    descripcion: 'Consumiciones',
    lineas: [
      {
        base_imponible: '5.00',
        tipo_impositivo: '10',
        cuota_repercutida: '0.50',
        impuesto: '01',
        calificacion_operacion: 'S1',
        clave_regimen: '01',
      },
      {
        base_imponible: '10.00',
        tipo_impositivo: '21',
        cuota_repercutida: '2.10',
        impuesto: '01',
        calificacion_operacion: 'S1',
        clave_regimen: '01',
      },
    ],
    importe_total: '17.60',
  })
})

test('diferencia facturas normales y rectificativas de VeriFactu', () => {
  const normal = mapVerifactuInvoice(invoice({
    invoice_type: 'normal',
    document_data: { recipient: { nombre: 'Cliente SL', nif: 'B12345678' } },
  }), ticket())
  assert.equal(normal.tipo_factura, 'F1')
  assert.equal(normal.nombre, 'Cliente SL')
  assert.equal(normal.nif, 'B12345678')

  const corrective = mapVerifactuInvoice(invoice({
    invoice_type: 'corrective',
    document_data: {
      codigo: 'R1',
      tipo_rectificativa: 'S',
      recipient: { nombre: 'Cliente SL', nif: 'B12345678' },
      importe_rectificativa: { base_rectificada: '0.00', cuota_rectificada: '0.00' },
      facturas_rectificadas: [{ serie: 'POS', numero: '1', fecha_expedicion: '01-08-2026' }],
    },
  }), ticket())
  assert.equal(corrective.tipo_factura, 'R1')
  assert.equal(corrective.tipo_rectificativa, 'S')
  assert.deepEqual(corrective.importe_rectificativa, { base_rectificada: '0.00', cuota_rectificada: '0.00' })
  assert.deepEqual(corrective.facturas_rectificadas, [{ serie: 'POS', numero: '1', fecha_expedicion: '01-08-2026' }])
})

test('mapea facturas simplificadas, normales y rectificativas de TicketBAI', () => {
  const simplified = mapTicketBaiInvoice(invoice({ provider: 'ticketbai' }), ticket())
  assert.equal(simplified.simplificada, true)
  assert.equal(simplified.tipo_operacion, 'servicios')
  assert.deepEqual(simplified.lineas, [
    { descripcion: 'Menu Grande', cantidad: '1', importe_unitario: '10', importe_total: '12.10' },
    { descripcion: 'Pan', cantidad: '2', importe_unitario: '2.5', importe_total: '5.50' },
  ])
  assert.deepEqual(simplified.desglose_iva, [
    { base_imponible: '5.00', tipo_impositivo: '10', cuota_impuesto: '0.50' },
    { base_imponible: '10.00', tipo_impositivo: '21', cuota_impuesto: '2.10' },
  ])

  const recipient = { nombre: 'Cliente SL', nif: 'B12345678', cp: '28001', direccion: 'Calle Uno 1' }
  const normal = mapTicketBaiInvoice(invoice({ provider: 'ticketbai', invoice_type: 'normal', document_data: { recipient } }), ticket())
  assert.equal(normal.simplificada, false)
  assert.equal(normal.nombre, 'Cliente SL')
  assert.equal(normal.nif, 'B12345678')
  assert.equal(normal.cp, '28001')

  const corrective = mapTicketBaiInvoice(invoice({
    provider: 'ticketbai',
    invoice_type: 'corrective',
    document_data: {
      codigo: 'R4',
      tipo_rectificativa: 'I',
      recipient,
      rectificativa: { base_rectificada: '10.00', cuota_rectificada: '2.10' },
      rectificadas_sustituidas: [{ serie: 'POS', numero: '1', fecha_expedicion: '01-08-2026' }],
    },
  }), ticket())
  assert.deepEqual(corrective.rectificativa, {
    codigo: 'R4',
    tipo: 'I',
    base_rectificada: '10.00',
    cuota_rectificada: '2.10',
  })
  assert.deepEqual(corrective.rectificadas_sustituidas, [{ serie: 'POS', numero: '1', fecha_expedicion: '01-08-2026' }])
})

test('genera una Idempotency-Key estable por tenant, factura y operacion', () => {
  const createKey = stableFiscalIdempotencyKey(tenantId, invoiceId, 'create')
  assert.equal(createKey, stableFiscalIdempotencyKey(tenantId, invoiceId, 'create'))
  assert.notEqual(createKey, stableFiscalIdempotencyKey(tenantId, invoiceId, 'cancel'))
  assert.match(createKey, /^[\x20-\x7e]{1,255}$/)
})

test('mapea la anulacion exacta para VeriFactu y TicketBAI, incluido rechazo previo', () => {
  assert.deepEqual(mapFiscalCancellation(invoice({ status: 'accepted' })), {
    serie: 'POS', numero: '42', fecha_expedicion: '03-08-2026',
    rechazo_previo: 'N', sin_registro_previo: 'N',
  })
  assert.deepEqual(mapFiscalCancellation(invoice({ status: 'rejected' })), {
    serie: 'POS', numero: '42', fecha_expedicion: '03-08-2026',
    rechazo_previo: 'S', sin_registro_previo: 'S',
  })
  assert.deepEqual(mapFiscalCancellation(invoice({ provider: 'ticketbai', status: 'accepted' })), {
    serie: 'POS', numero: '42', fecha_expedicion: '03-08-2026',
  })
  assert.deepEqual(mapFiscalCancellation(invoice({ provider: 'ticketbai', status: 'rejected' })), {
    serie: 'POS', numero: '42', fecha_expedicion: '03-08-2026', rechazo_previo: true,
  })
})

test('los adaptadores implementan health, create, ambos status, cancel y list con autenticacion backend', async () => {
  for (const [name, Provider] of [['verifactu', VerifactuProvider], ['ticketbai', TicketBaiProvider]]) {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init })
      return Response.json({ estado: 'Pendiente', uuid: 'external-uuid' })
    }
    const provider = new Provider({ apiKey: 'private-api-key', fetchImpl, sleep: async () => {} })
    await provider.health()
    await provider.create({ serie: 'POS' }, 'create-key')
    await provider.getStatus('external uuid')
    await provider.status({ serie: 'POS', numero: '42', fecha_expedicion: '03-08-2026' })
    await provider.cancel({ serie: 'POS', numero: '42', fecha_expedicion: '03-08-2026' }, 'cancel-key')
    await provider.list({ pagina: 1 })

    assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
      `/${name}/health`, `/${name}/create`, `/${name}/status`, `/${name}/status`, `/${name}/cancel`, `/${name}/list`,
    ])
    assert.equal(new URL(calls[2].url).searchParams.get('uuid'), 'external uuid')
    assert.deepEqual(calls.map((call) => call.init.method), ['GET', 'POST', 'GET', 'POST', 'POST', 'POST'])
    assert.ok(calls.every((call) => new Headers(call.init.headers).get('Authorization') === 'Bearer private-api-key'))
    assert.equal(new Headers(calls[1].init.headers).get('Idempotency-Key'), 'create-key')
    assert.equal(new Headers(calls[4].init.headers).get('Idempotency-Key'), 'cancel-key')
    assert.equal(JSON.parse(calls[4].init.body).serie, 'POS')
    assert.ok(calls.every((call) => !String(call.init.body ?? '').includes('private-api-key')))
  }
})

test('solo reintenta red, rate limit y servidor; nunca validacion', async () => {
  const statuses = [429, 503, 200]
  const sleeps = []
  let attempts = 0
  const recovered = await requestVerifactiJson({
    apiKey: 'secret',
    path: '/verifactu/health',
    fetchImpl: async () => {
      const status = statuses[attempts++]
      return Response.json(status === 200 ? { estado: 'OK' } : { error: 'temporal' }, { status })
    },
    sleep: async (milliseconds) => { sleeps.push(milliseconds) },
  })
  assert.equal(recovered.attempts, 3)
  assert.equal(attempts, 3)
  assert.equal(sleeps.length, 2)

  let validationAttempts = 0
  await assert.rejects(
    requestVerifactiJson({
      apiKey: 'secret',
      body: { invalid: true },
      path: '/verifactu/create',
      fetchImpl: async () => {
        validationAttempts += 1
        return Response.json({ error: 'Datos no validos' }, { status: 400 })
      },
      sleep: async () => assert.fail('No debe esperar ni reintentar un 400'),
    }),
    (error) => error instanceof ProviderHttpError && error.status === 400 && error.retryable === false,
  )
  assert.equal(validationAttempts, 1)
})

test('normaliza confirmaciones, rechazos, errores y anulaciones del proveedor', () => {
  assert.equal(mapProviderStatus('Pendiente'), 'pending')
  assert.equal(mapProviderStatus('Correcto'), 'accepted')
  assert.equal(mapProviderStatus('Aceptado con errores'), 'accepted_with_errors')
  assert.equal(mapProviderStatus('Incorrecto'), 'rejected')
  assert.equal(mapProviderStatus('Duplicado'), 'rejected')
  assert.equal(mapProviderStatus('Error servidor Hacienda'), 'error')
  assert.equal(mapProviderStatus('Anulada'), 'cancelled')
})

test('cifra credenciales con AES-GCM y verifica la firma HMAC del webhook', async () => {
  const masterKey = 'master-key-with-at-least-thirty-two-characters'
  const encrypted = await encryptSecret('vf_test_private', masterKey)
  assert.match(encrypted, /^v1:/)
  assert.ok(!encrypted.includes('vf_test_private'))
  assert.equal(await decryptSecret(encrypted, masterKey), 'vf_test_private')

  const rawBody = '[{"uuid":"abc","estado":"Correcto"}]'
  const secret = 'webhook-shared-secret'
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  const actual = await webhookSignature(rawBody, secret)
  assert.equal(actual, expected)
  assert.equal(constantTimeEqual(actual, expected.toUpperCase()), true)
  assert.equal(constantTimeEqual(actual, `${expected.slice(0, -1)}0`), false)
})

test('la migracion aplica aislamiento multi-tenant, historial e inmutabilidad fiscal', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260803220000_add_verifacti_integration.sql', import.meta.url), 'utf8')
  for (const table of ['fiscal_integration_settings', 'fiscal_invoices', 'fiscal_invoice_events', 'fiscal_webhook_deliveries']) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'))
  }
  assert.match(sql, /api_key_ciphertext text/i)
  assert.match(sql, /management_api_key_ciphertext text/i)
  assert.match(sql, /status in \('pending', 'accepted', 'accepted_with_errors', 'rejected', 'cancelled', 'error'\)/i)
  assert.match(sql, /unique \(tenant_id, ticket_id\)/i)
  assert.match(sql, /unique index fiscal_webhook_deliveries_valid_id_idx[\s\S]*\(tenant_id, webhook_id\)[\s\S]*where signature_valid = true/i)
  assert.match(sql, /queue_fiscal_invoice_after_sale[\s\S]*after insert on public\.sales/i)
  assert.match(sql, /protect_fiscal_ticket_update[\s\S]*before update or delete on public\.tickets/i)
  assert.match(sql, /protect_fiscal_ticket_lines[\s\S]*before insert or update or delete on public\.ticket_lines/i)
  assert.match(sql, /revoke all on public\.fiscal_integration_settings from anon, authenticated/i)
  assert.match(sql, /user_is_tenant_admin\(tenant_id\)[\s\S]*user_has_venue_access\(tenant_id, venue_id\)/i)
})

test('el webhook valida firma e idempotencia y el backend nunca devuelve las API keys', async () => {
  const [api, webhook, config, integrationPage] = await Promise.all([
    readFile(new URL('../supabase/functions/verifacti-api/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/functions/verifacti-webhook/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/integrations/pages/IntegrationsPage.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(webhook, /X-Webhook-Signature/)
  assert.match(webhook, /X-Webhook-Id/)
  assert.match(webhook, /webhookSignature\(rawBody, secret\)/)
  assert.match(webhook, /deliveryError\?\.code === '23505'/)
  assert.match(webhook, /mapProviderStatus\(item\.estado\)/)
  assert.match(config, /\[functions\.verifacti-webhook\][\s\S]*verify_jwt = false/i)
  assert.match(api, /hasApiKey:/)
  assert.match(api, /hasManagementApiKey:/)
  assert.match(api, /const nextStatus = 'pending' as const/)
  assert.doesNotMatch(api.match(/function publicSettings[\s\S]*?\n\}/)?.[0] ?? '', /apiKeyCiphertext|managementApiKeyCiphertext/)
  assert.match(integrationPage, /type="password"/)
  assert.doesNotMatch(integrationPage, /api_key_ciphertext|management_api_key_ciphertext/)
})

test('el flujo automático obtiene la fiscalización antes de imprimir sin bloquear el cierre de la comanda', async () => {
  const [posService, quickSale, restaurant, documentBuilder, schema, salesPage] = await Promise.all([
    readFile(new URL('../src/services/posService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/quick-sale/hooks/useQuickSalePayment.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/restaurant/hooks/useRestaurantController.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/local-printing/services/documentLineBuilders.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/local-printing/schemas/printSchemas.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/sales/pages/SalesReportsPage.tsx', import.meta.url), 'utf8'),
  ])
  assert.match(posService, /await autoIssueFiscalTicket\(event\.tenantId, event\.payload\.ticket\.id\)/)
  assert.match(quickSale, /await options\.syncPendingEvents\(\)[\s\S]*loadFiscalReceiptData[\s\S]*printPayload = \{ \.\.\.payload, fiscal \}/)
  assert.equal((restaurant.match(/fiscalizeTicketForPrint\((?:options\.)?context, result\.ticketId\)/g) ?? []).length, 3)
  assert.match(restaurant, /const printTask = \(async \(\) => \{[\s\S]*fiscalizeTicketForPrint[\s\S]*options\.printSale/)
  assert.match(documentBuilder, /sale\.fiscal\.verificationUrl/)
  assert.doesNotMatch(schema, /qrBase64/)
  assert.match(salesPage, /Consultar estado/)
  assert.match(salesPage, /Ver QR/)
  assert.match(salesPage, /Anular/)
  assert.match(salesPage, /Historial de comunicaciones/)
  assert.match(salesPage, /factura emitida es inmutable/i)
})

test('el borrado remoto solicita la anulacion fiscal antes de poner el ticket en void', async () => {
  const [api, cashActions, fiscalService, migration, posService] = await Promise.all([
    readFile(new URL('../supabase/functions/verifacti-api/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/cash-registers/hooks/useCashTicketActions.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/fiscal/service.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260803230000_void_ticket_with_fiscal_cancellation.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/posService.ts', import.meta.url), 'utf8'),
  ])
  assert.match(fiscalService, /action: 'void-ticket', tenantId, ticketId/)
  assert.match(cashActions, /await voidTicketWithFiscalCancellation\(context\.tenantId, ticket\.payload\.ticket\.id\)/)
  assert.match(cashActions, /Necesitas conexión para anular un ticket/)
  assert.match(api, /if \(action === 'void-ticket'\)/)
  assert.match(api, /await queueInvoiceCancellation[\s\S]*admin\.rpc\('finalize_ticket_void'/)
  assert.match(api, /fiscalCancellationQueued: cancellation\?\.status === 'pending'/)
  assert.match(migration, /FISCAL_CANCELLATION_REQUIRED/)
  assert.match(migration, /v_invoice\.pending_operation <> 'cancel'/)
  assert.match(migration, /update public\.tickets[\s\S]*set status = 'void'/)
  assert.match(migration, /grant execute on function public\.finalize_ticket_void\(uuid, uuid, uuid\) to service_role/i)
  assert.match(posService, /event\.kind === 'sale_voided'[\s\S]*await voidTicketWithFiscalCancellation\(event\.tenantId, event\.payload\.ticketId\)/)
  assert.doesNotMatch(posService.match(/if \(event\.kind === 'sale_voided'\)[\s\S]*?\n  \}/)?.[0] ?? '', /from\('sales'\)[\s\S]*\.delete\(\)/)
})

test('el borrado no exige clave de cifrado cuando la integracion fiscal no interviene', async () => {
  const api = await readFile(new URL('../supabase/functions/verifacti-api/index.ts', import.meta.url), 'utf8')
  const requiredEnvironment = api.match(/function requiredEnvironment\(\) \{[\s\S]*?\n\}/)?.[0] ?? ''
  const issueInvoice = api.match(/async function issueInvoice\([\s\S]*?\n\}/)?.[0] ?? ''

  assert.doesNotMatch(requiredEnvironment, /!encryptionKey/)
  assert.match(api, /function requireEncryptionKey\(encryptionKey: string \| undefined\)/)
  assert.match(issueInvoice, /if \(!settings\?\.enabled\) return \{ skipped: true, reason: 'integration_disabled' \}[\s\S]*requireEncryptionKey\(encryptionKey\)/)
  assert.match(api, /if \(action === 'void-ticket'\)[\s\S]*if \(invoice\)[\s\S]*await queueInvoiceCancellation/)
})
