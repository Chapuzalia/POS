import type { CrmSalesReportRefundDocument, CrmSalesReportTicket, CrmVenue, TenantContext } from '../../src/types'

export const context: TenantContext = {
  tenantId: 'tenant', tenantName: 'Demo', tenantSlug: 'demo', venueId: 'venue', venueName: 'LOCAL DEMO',
  venueLegalName: 'LOCAL DEMO, S.L.', venueTaxId: 'B00000000', venueAddress: 'Carrer Major, 12 · 08700 Igualada',
  venueTimeZone: 'Europe/Madrid', deviceId: 'device', deviceName: 'CRM', userId: 'user', userName: 'Demo', role: 'owner',
}

export const venue: CrmVenue = {
  id: 'venue', name: 'LOCAL DEMO', legalName: 'LOCAL DEMO, S.L.', taxId: 'B00000000', address: 'Carrer Major, 12 · 08700 Igualada',
  timeZone: 'Europe/Madrid', defaultTaxRate: 10, catalogProfile: 'bar_classic', dayChangeTime: null,
  sortOrder: 0, isActive: true, inventoryEnabled: false, tablesEnabled: false, productionEnabled: false, addonActivations: {},
}

export const ticket: CrmSalesReportTicket = {
  id: 'ticket', ticketNumber: 158, createdAt: '2026-10-08T18:42:00Z', lineCount: 3,
  lines: [
    { name: 'Café con leche', quantity: 2, price: 250, base: 455, tax: 45 },
    { name: 'Bocadillo', quantity: 1, price: 700, base: 636, tax: 64 },
    { name: 'Agua', quantity: 1, price: 120, base: 109, tax: 11 },
  ].map((row, index) => ({
    id: `line-${index}`, productName: row.name, quantity: row.quantity, unitPriceCents: row.price,
    lineTotalCents: row.quantity * row.price, variantName: '', modifiers: [], components: [],
    categoryId: null, categoryName: '', saleFormatId: null, saleFormatName: '', catalogTabId: null, catalogTabName: '', productId: null, variantId: null,
    fiscalSnapshot: { taxRate: 10, taxableBaseCents: row.base, taxAmountCents: row.tax, grossTotalCents: row.quantity * row.price },
  })),
  fiscal: {
    provider: 'verifactu', status: 'accepted', documentKind: 'simplified', series: 'MES-C1-I2D715E9-2026-S', number: '158',
    issuedAt: '2026-10-08T18:42:00Z', verificationUrl: 'https://example.com/fiscal?id=158', externalCode: null,
    errorCode: null, errorMessage: null, verifactuLegend: false,
  },
  refundDocuments: [], discountAmountCents: 0, discountId: null, discountName: null, discountType: null,
  discountValue: null, discountValueType: null, discountRoundingIncrementCents: null,
  paymentMethod: 'card', quantity: 4, status: 'paid', subtotalCents: 1320, totalCents: 1320,
}

export const refund: CrmSalesReportRefundDocument = {
  id: 'refund', series: 'R-2026', number: '2', issuedAt: '2026-10-09T10:00:00Z', verificationUrl: null, status: 'accepted',
  method: 'card', totalCents: -500, taxableBaseCents: -455, taxAmountCents: -45,
  rectifies: { issuerNif: 'B00000000', seriesAndNumber: 'MES-C1-I2D715E9-2026-S/158', issueDate: '2026-10-08' },
  lines: [{ name: 'Café con leche', variantName: '', quantity: 2, amountCents: -500 }],
}
