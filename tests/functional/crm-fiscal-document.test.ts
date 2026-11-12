import { describe, expect, it, vi } from 'vitest'
import QRCode from 'qrcode'
import { buildRefundDocument, buildTicketDocument } from '../../src/features/crm/integrations/services/fiscalInvoiceDocument'
import { context, refund, ticket, venue } from '../fixtures/crmFiscalDocument'
import { buildCrmVenueContext } from '../../src/features/crm/venues/services/venueSelection'

describe('CRM fiscal document', () => {
  it('uses the selected venue when the CRM login has no venue data, preserving tenant and permissions', async () => {
    const login = { ...context, venueId: '', venueName: '', venueLegalName: '', venueTaxId: '', venueAddress: '' }
    const selected = buildCrmVenueContext(login, venue)
    expect(selected).toMatchObject({ tenantId: login.tenantId, userId: login.userId, role: login.role, venueId: venue.id, venueName: venue.name, venueLegalName: venue.legalName, venueTaxId: venue.taxId, venueAddress: venue.address })
    const html = await buildTicketDocument(ticket, selected)
    expect(html).toContain('LOCAL DEMO, S.L.')
    expect(html).toContain('NIF B00000000')
    expect(html).toContain('Carrer Major, 12')
    expect(buildCrmVenueContext(login, undefined)).toBe(login)
    const switched = buildCrmVenueContext(context, { ...venue, id: 'other', name: 'OTHER', legalName: '', taxId: '', address: '' })
    expect(switched).toMatchObject({ venueId: 'other', venueName: 'OTHER', venueLegalName: '', venueTaxId: '', venueAddress: '' })
  })

  it('preserves the historical issuer even if the current venue details changed or the login has none', async () => {
    const issuer = { name: 'Emisor histórico', nif: 'B11111111', address: 'Dirección histórica' }
    const original = { ...ticket, fiscal: ticket.fiscal ? { ...ticket.fiscal, issuer } : null }
    const login = { ...context, venueName: '', venueLegalName: '', venueTaxId: '', venueAddress: '' }
    for (const current of [context, login]) {
      const html = await buildTicketDocument(original, current)
      expect(html).toContain('<strong>Emisor histórico</strong>')
      expect(html).toContain('NIF B11111111')
      expect(html).toContain('Dirección histórica')
      expect(html).toContain('Documento expedido por Emisor histórico')
      expect(html).not.toContain('NIF B00000000')
    }
    const correction = await buildRefundDocument(original, { ...refund, issuer: { ...issuer, name: 'Emisor rectificativa' } }, context)
    expect(correction).toContain('Documento expedido por Emisor rectificativa')
  })

  it('renders the stored amounts, fiscal number, timezone, QR and tickit identity', async () => {
    const html = await buildTicketDocument(ticket, context)
    expect(html).toContain('<h1>Factura simplificada</h1>')
    expect(html).toContain('MES-C1-I2D715E9-2026-S/158')
    expect(html).toContain('20:42')
    expect(html).toContain('13,20')
    expect(html).toContain('Base imponible (10 %)')
    expect(html).toContain('12,00')
    expect(html).toContain('1,20')
    expect(html).toContain('data:image/png;base64,')
    expect(html).toContain('alt="tickit"')
  })

  it('uses the saved customer data for a complete invoice and escapes HTML', async () => {
    const html = await buildTicketDocument({ ...ticket, invoice: {
      customerId: 'customer', series: 'F', number: '158', issuedAt: ticket.createdAt,
      customer: { legalName: '<script>alert(1)</script>', taxId: 'B12345678', address: 'A & B', postalCode: '08700', city: 'Igualada', province: 'Barcelona', country: 'ES', email: null, phone: null },
    } }, { ...context, venueName: '<img onerror="alert(1)">' })
    expect(html).toContain('<h1>Factura</h1>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('A &amp; B')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img onerror=')
  })

  it('does not invent tax amounts when snapshots are missing or do not reconcile', async () => {
    const missing = { ...ticket, lines: ticket.lines.map((line) => ({ ...line, fiscalSnapshot: null })) }
    expect(await buildTicketDocument(missing, context)).not.toContain('Base imponible')
    const discounted = await buildTicketDocument({ ...ticket, discountAmountCents: 120, totalCents: 1200 }, context)
    expect(discounted).not.toContain('Base imponible')
    expect(discounted).toContain('Descuento incluido')
    expect(discounted).toContain('12,00')
  })

  it('keeps negative rectification totals, positive unit prices and the original document reference', async () => {
    const html = await buildRefundDocument(ticket, refund, context)
    expect(html).toContain('<h1>Factura rectificativa</h1>')
    expect(html).toContain('R-2026/2')
    expect(html).toContain('Rectifica MES-C1-I2D715E9-2026-S/158')
    expect(html).toContain('<td>-2</td>')
    expect(html).toContain('2,50')
    expect(html).toContain('-5,00')
    expect(html).not.toContain('Código QR de verificación fiscal')
  })

  it('omits fiscal claims and QR for a ticket without fiscal issuance', async () => {
    const html = await buildTicketDocument({ ...ticket, fiscal: null }, context)
    expect(html).toContain('<h1>Ticket</h1>')
    expect(html).not.toContain('Código QR de verificación fiscal')
    expect(html).not.toContain('VERI*FACTU')
  })

  it('propagates QR failures so the preview can show a recoverable error', async () => {
    vi.spyOn(QRCode, 'toDataURL').mockRejectedValueOnce(new Error('QR unavailable'))
    await expect(buildTicketDocument(ticket, context)).rejects.toThrow('QR unavailable')
  })
})
