import { formatMoney } from '../../../../lib/format'
import type { CrmSalesReportTicket, TenantContext } from '../../../../types'

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export function openCustomerInvoiceDocument(ticket: CrmSalesReportTicket, context: TenantContext) {
  if (!ticket.invoice) throw new Error('El ticket no tiene factura de cliente')
  const popup = window.open('', '_blank')
  if (!popup) throw new Error('El navegador ha bloqueado la ventana de impresión')
  const rows = ticket.lines.map((line) => `
    <tr><td>${escapeHtml(line.productName)} ${escapeHtml(line.variantName)}</td><td>${escapeHtml(line.quantity)}</td><td>${escapeHtml(formatMoney(line.unitPriceCents))}</td><td>${escapeHtml(formatMoney(line.lineTotalCents))}</td></tr>`).join('')
  popup.document.open()
  popup.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Factura ${escapeHtml(ticket.invoice.series)}-${escapeHtml(ticket.invoice.number)}</title><style>body{font:14px/1.45 system-ui,sans-serif;color:#111;margin:36px auto;max-width:820px;padding:0 24px}header{border-bottom:2px solid #111;padding-bottom:20px}.muted{color:#666}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{padding:10px;border-bottom:1px solid #ddd;text-align:left}th:last-child,td:last-child{text-align:right}.total{margin:22px 0 0 auto;width:280px;display:flex;justify-content:space-between;border-top:2px solid #111;padding-top:12px}@media print{body{margin:0;max-width:none}.no-print{display:none}}</style></head><body><button class="no-print" onclick="window.print()">Imprimir / guardar como PDF</button><header><h1>Factura ${escapeHtml(ticket.invoice.series)}-${escapeHtml(ticket.invoice.number)}</h1><div>${escapeHtml(context.venueLegalName || context.venueName)}</div><div class="muted">${escapeHtml(ticket.invoice.customer.legalName)} · ${escapeHtml(ticket.invoice.customer.taxId)}</div><div class="muted">${escapeHtml(ticket.invoice.customer.address)}</div></header><p>Fecha: ${escapeHtml(new Date(ticket.invoice.issuedAt ?? ticket.createdAt).toLocaleString('es-ES'))}</p><table><thead><tr><th>Concepto</th><th>Cantidad</th><th>Precio</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table><div class="total"><strong>Total</strong><strong>${escapeHtml(formatMoney(ticket.totalCents))}</strong></div></body></html>`)
  popup.document.close()
}
