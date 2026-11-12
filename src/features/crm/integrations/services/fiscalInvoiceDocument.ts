import { formatMoney } from '../../../../lib/format'
import QRCode from 'qrcode'
import type { CrmSalesReportRefundDocument, CrmSalesReportTicket, TenantContext } from '../../../../types'
import styles from './fiscalInvoiceDocument.css?inline'

function escapeHtml(value: unknown) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;')
}

type DocumentOptions = {
  heading: string
  number: string
  issuedAt: string
  rows: string
  totalCents: number
  qrUrl: string | null
  summary: string
  customer?: CrmSalesReportTicket['invoice']
  rectifies?: CrmSalesReportRefundDocument['rectifies']
  legend?: boolean
  issuer?: NonNullable<CrmSalesReportTicket['fiscal']>['issuer']
}

function summaryRow(label: string, cents: number) {
  return `<div><span>${escapeHtml(label)}</span><span>${escapeHtml(formatMoney(cents))}</span></div>`
}

async function buildDocument(options: DocumentOptions, context: TenantContext) {
  const qr = options.qrUrl ? await QRCode.toDataURL(options.qrUrl, { errorCorrectionLevel: 'M', margin: 2, width: 240 }) : null
  const date = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short', timeZone: context.venueTimeZone }).format(new Date(options.issuedAt))
  const customer = options.customer?.customer
  const qrMarkup = qr ? `<figure class="qr"><img alt="Código QR de verificación fiscal" src="${qr}"><figcaption>Verificación fiscal</figcaption></figure>` : ''
  const issuerName = options.issuer?.name || context.venueLegalName || context.venueName
  const issuerNif = options.issuer?.nif || context.venueTaxId
  const issuerAddress = options.issuer?.address || context.venueAddress
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(options.heading)} ${escapeHtml(options.number)}</title><style>${styles}</style></head><body>
    <main class="document">
      <div class="document-body">
      <table class="document-layout" role="presentation"><thead><tr><td class="layout-cell">
      <header class="document-header">
        <div class="issuer"><div class="issuer-details"><p class="venue">${escapeHtml(context.venueName || issuerName)}</p><strong>${escapeHtml(issuerName)}</strong>${issuerNif ? `<p>NIF ${escapeHtml(issuerNif)}</p>` : ''}${issuerAddress ? `<p>${escapeHtml(issuerAddress)}</p>` : ''}</div>${customer ? '' : qrMarkup}</div>
        <div class="document-heading"><h1>${escapeHtml(options.heading)}</h1><div class="document-meta"><strong>${escapeHtml(options.number)}</strong><time datetime="${escapeHtml(options.issuedAt)}">${escapeHtml(date)}</time></div></div>
      </header>
      </td></tr></thead><tbody><tr><td class="layout-cell">
      ${customer ? `<div class="document-parties"><section class="customer"><h2>Datos del cliente</h2><strong>${escapeHtml(customer.legalName)}</strong><p>NIF ${escapeHtml(customer.taxId)}</p><p>${escapeHtml(customer.address)}</p><p>${escapeHtml([customer.postalCode, customer.city, customer.province, customer.country].filter(Boolean).join(' · '))}</p></section>${qrMarkup}</div>` : ''}
      ${options.rectifies ? `<p class="rectifies">Rectifica ${escapeHtml(options.rectifies.seriesAndNumber)} · ${escapeHtml(options.rectifies.issueDate)} · NIF ${escapeHtml(options.rectifies.issuerNif)}</p>` : ''}
      <table><colgroup><col class="description"><col><col><col></colgroup><thead><tr><th>Descripción</th><th>Cant.</th><th>Precio</th><th>Importe</th></tr></thead><tbody class="product-rows">${options.rows}</tbody>
        <tbody class="document-totals"><tr><td class="summary-cell" colspan="4"><section class="summary" aria-label="Totales">${options.summary}<div class="total"><strong>Total</strong><strong>${escapeHtml(formatMoney(options.totalCents))}</strong></div></section>${options.legend ? '<p class="fiscal-legend">VERI*FACTU · Factura verificable en la sede electrónica de la AEAT</p>' : ''}</td></tr></tbody>
      </table>
      </td></tr></tbody><tfoot class="print-footer-space" aria-hidden="true"><tr><td></td></tr></tfoot></table>
      </div>
      <footer><span>Documento expedido por ${escapeHtml(issuerName)}</span><span class="powered">Generado con <img alt="tickit" src="/logo_black.png"></span></footer>
    </main>
  </body></html>`
}

export function buildTicketDocument(ticket: CrmSalesReportTicket, context: TenantContext) {
  const rows = ticket.lines.map((line) => `<tr><td>${escapeHtml(line.productName)}${line.variantName ? `<small>${escapeHtml(line.variantName)}</small>` : ''}</td><td>${escapeHtml(line.quantity)}</td><td>${escapeHtml(formatMoney(line.unitPriceCents))}</td><td>${escapeHtml(formatMoney(line.lineTotalCents))}</td></tr>`).join('')
  // Only print stored tax amounts when the complete snapshot reconciles with the document.
  const taxes = new Map<number, { base: number; tax: number }>()
  for (const line of ticket.lines) {
    const fiscal = line.fiscalSnapshot
    if (!fiscal) continue
    const group = taxes.get(fiscal.taxRate) ?? { base: 0, tax: 0 }
    group.base += fiscal.taxableBaseCents
    group.tax += fiscal.taxAmountCents
    taxes.set(fiscal.taxRate, group)
  }
  const hasCompleteTaxes = ticket.lines.length > 0 && ticket.lines.every((line) => line.fiscalSnapshot)
    && [...taxes.values()].reduce((sum, group) => sum + group.base + group.tax, 0) === ticket.totalCents
  const taxSummary = hasCompleteTaxes ? [...taxes].sort(([a], [b]) => a - b).map(([rate, group]) => summaryRow(`Base imponible (${rate} %)`, group.base) + summaryRow(`IVA ${rate} %`, group.tax)).join('') : ''
  const discountSummary = ticket.discountAmountCents > 0 ? summaryRow('Descuento incluido', -ticket.discountAmountCents) : ''
  const kind = ticket.fiscal?.documentKind
  return buildDocument({
    heading: kind === 'corrective' ? 'Factura rectificativa' : ticket.invoice || kind === 'complete' || kind === 'normal' ? 'Factura' : ticket.fiscal ? 'Factura simplificada' : 'Ticket',
    number: ticket.fiscal ? `${ticket.fiscal.series}/${ticket.fiscal.number}` : ticket.invoice?.series && ticket.invoice.number ? `${ticket.invoice.series}/${ticket.invoice.number}` : `Ticket-${String(ticket.ticketNumber).padStart(6, '0')}`,
    issuedAt: ticket.fiscal?.issuedAt ?? ticket.invoice?.issuedAt ?? ticket.createdAt,
    rows, totalCents: ticket.totalCents, qrUrl: ticket.fiscal?.verificationUrl ?? null,
    summary: discountSummary + taxSummary, customer: ticket.invoice, legend: ticket.fiscal?.verifactuLegend, issuer: ticket.fiscal?.issuer,
  }, context)
}

export function buildRefundDocument(ticket: CrmSalesReportTicket, document: CrmSalesReportRefundDocument, context: TenantContext) {
  const rows = document.lines.map((line) => `<tr><td>${escapeHtml(line.name)}${line.variantName ? `<small>${escapeHtml(line.variantName)}</small>` : ''}</td><td>${escapeHtml(-Math.abs(line.quantity))}</td><td>${escapeHtml(formatMoney(line.quantity ? Math.round(Math.abs(line.amountCents) / Math.abs(line.quantity)) : 0))}</td><td>${escapeHtml(formatMoney(line.amountCents))}</td></tr>`).join('')
  return buildDocument({
    heading: 'Factura rectificativa', number: document.series && document.number ? `${document.series}/${document.number}` : String(ticket.ticketNumber),
    issuedAt: document.issuedAt, rows, totalCents: document.totalCents, qrUrl: document.verificationUrl,
    summary: summaryRow('Base imponible', document.taxableBaseCents) + summaryRow('IVA', document.taxAmountCents),
    customer: ticket.invoice, rectifies: document.rectifies, issuer: document.issuer,
  }, context)
}
