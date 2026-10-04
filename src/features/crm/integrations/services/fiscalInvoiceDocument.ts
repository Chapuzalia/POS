import { formatMoney } from '../../../../lib/format'
import QRCode from 'qrcode'
import type { CrmSalesReportRefundDocument, CrmSalesReportTicket, TenantContext } from '../../../../types'

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function openPrintableDocument(title: string, venueName: string, issuedAt: string, rows: string, totalCents: number, qrUrl: string | null) {
  const popup = window.open('', '_blank')
  if (!popup) throw new Error('El navegador ha bloqueado la ventana de descarga')
  const qrDataUrlPromise = qrUrl ? QRCode.toDataURL(qrUrl, { errorCorrectionLevel: 'M', margin: 1, width: 180 }) : Promise.resolve(null)
  void qrDataUrlPromise.then((qrDataUrl) => {
    popup.document.open()
    popup.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font:14px/1.45 system-ui,sans-serif;color:#111;margin:36px auto;max-width:820px;padding:0 24px}header{border-bottom:2px solid #111;padding-bottom:20px}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{padding:10px;border-bottom:1px solid #ddd;text-align:left}th:last-child,td:last-child{text-align:right}.total{margin:22px 0 0 auto;width:280px;display:flex;justify-content:space-between;border-top:2px solid #111;padding-top:12px}.qr{text-align:center;margin-top:24px}.qr img{width:180px;height:180px}.qr small{display:block;overflow-wrap:anywhere;margin-top:8px}@media print{body{margin:0;max-width:none}.no-print{display:none}}</style></head><body><button class="no-print" onclick="window.print()">Descargar / guardar como PDF</button><header><h1>${escapeHtml(title)}</h1><div>${escapeHtml(venueName)}</div></header><p>Fecha: ${escapeHtml(new Date(issuedAt).toLocaleString('es-ES'))}</p><table><thead><tr><th>Concepto</th><th>Cantidad</th><th>Precio</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table><div class="total"><strong>Total</strong><strong>${escapeHtml(formatMoney(totalCents))}</strong></div>${qrDataUrl && qrUrl ? `<div class="qr"><strong>Verificación fiscal</strong><img alt="Código QR de verificación fiscal" src="${qrDataUrl}"><small>${escapeHtml(qrUrl)}</small></div>` : ''}</body></html>`)
    popup.document.close()
  }).catch(() => popup.close())
}

export async function openTicketDocument(ticket: CrmSalesReportTicket, context: TenantContext) {
  const rows = ticket.lines.map((line) => `<tr><td>${escapeHtml(line.productName)} ${escapeHtml(line.variantName)}</td><td>${escapeHtml(line.quantity)}</td><td>${escapeHtml(formatMoney(line.unitPriceCents))}</td><td>${escapeHtml(formatMoney(line.lineTotalCents))}</td></tr>`).join('')
  const title = ticket.fiscal ? `Ticket ${ticket.fiscal.series}-${ticket.fiscal.number}` : `Ticket-${String(ticket.ticketNumber).padStart(6, '0')}`
  openPrintableDocument(title, context.venueLegalName || context.venueName, ticket.fiscal?.issuedAt ?? ticket.createdAt, rows, ticket.totalCents, ticket.fiscal?.verificationUrl ?? null)
}

export function openRefundDocument(ticket: CrmSalesReportTicket, document: CrmSalesReportRefundDocument, context: TenantContext) {
  const rows = document.lines.map((line) => `<tr><td>${escapeHtml(line.name)} ${escapeHtml(line.variantName)}</td><td>-${escapeHtml(line.quantity)}</td><td>${escapeHtml(formatMoney(line.quantity ? Math.round(line.amountCents / line.quantity) : 0))}</td><td>${escapeHtml(formatMoney(line.amountCents))}</td></tr>`).join('')
  const title = `Rectificativa ${document.series && document.number ? `${document.series}-${document.number}` : ticket.ticketNumber}`
  openPrintableDocument(title, context.venueLegalName || context.venueName, document.issuedAt, rows, document.totalCents, document.verificationUrl)
}

export function openCustomerInvoiceDocument(ticket: CrmSalesReportTicket, context: TenantContext) {
  const popup = window.open('', '_blank')
  if (!popup) throw new Error('El navegador ha bloqueado la ventana de descarga')
  const rows = ticket.lines.map((line) => `<tr><td>${escapeHtml(line.productName)} ${escapeHtml(line.variantName)}</td><td>${escapeHtml(line.quantity)}</td><td>${escapeHtml(formatMoney(line.unitPriceCents))}</td><td>${escapeHtml(formatMoney(line.lineTotalCents))}</td></tr>`).join('')
  popup.document.open()
  popup.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Factura</title></head><body><h1>${escapeHtml(context.venueLegalName || context.venueName)}</h1><table>${rows}</table><strong>${escapeHtml(formatMoney(ticket.totalCents))}</strong></body></html>`)
  popup.document.close()
}
