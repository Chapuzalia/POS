import { formatMoney } from '../../../../lib/format'
import type { CrmSalesReportTicket, TenantContext } from '../../../../types'
import { fiscalQrDataUrl } from './verifactiService'

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export function openFiscalInvoiceDocument(ticket: CrmSalesReportTicket, context: TenantContext) {
  if (!ticket.fiscal) throw new Error('El ticket no tiene factura fiscal')
  const popup = window.open('', '_blank')
  if (!popup) throw new Error('El navegador ha bloqueado la ventana de impresion')
  const qr = fiscalQrDataUrl(ticket.fiscal.qrBase64)
  const rows = ticket.lines.map((line) => `
    <tr>
      <td>${escapeHtml(line.productName)} ${escapeHtml(line.variantName)}</td>
      <td>${escapeHtml(line.quantity)}</td>
      <td>${escapeHtml(formatMoney(line.unitPriceCents))}</td>
      <td>${escapeHtml(formatMoney(line.lineTotalCents))}</td>
    </tr>`).join('')
  popup.document.open()
  popup.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Factura ${escapeHtml(ticket.fiscal.series)}-${escapeHtml(ticket.fiscal.number)}</title><style>
    body{font:14px/1.45 system-ui,sans-serif;color:#111;margin:36px auto;max-width:820px;padding:0 24px}header{display:flex;justify-content:space-between;gap:24px;border-bottom:2px solid #111;padding-bottom:20px}.muted{color:#666}.meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:24px 0}.box{background:#f4f6f8;border-radius:8px;padding:12px}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #ddd;text-align:left}th:last-child,td:last-child{text-align:right}.totals{margin:22px 0 0 auto;width:280px;font-size:16px}.total{display:flex;justify-content:space-between;border-top:2px solid #111;padding-top:12px}.qr{display:flex;align-items:center;gap:16px;margin-top:28px;break-inside:avoid}.qr img{width:150px;height:150px;image-rendering:crisp-edges}.uuid{word-break:break-all;font-family:monospace;font-size:11px}@media print{body{margin:0;max-width:none}.no-print{display:none}}
  </style></head><body>
    <button class="no-print" onclick="window.print()">Imprimir / guardar como PDF</button>
    <header><div><h1>Factura ${escapeHtml(ticket.fiscal.series)}-${escapeHtml(ticket.fiscal.number)}</h1><div>${escapeHtml(context.venueLegalName || context.venueName)}</div><div class="muted">${escapeHtml(context.venueTaxId)}</div><div class="muted">${escapeHtml(context.venueAddress)}</div></div><div><strong>${ticket.fiscal.provider === 'ticketbai' ? 'TicketBAI' : 'VeriFactu'}</strong><div class="muted">${escapeHtml(ticket.fiscal.status)}</div></div></header>
    <div class="meta"><div class="box"><strong>Fecha</strong><br>${escapeHtml(new Date(ticket.createdAt).toLocaleString('es-ES'))}</div><div class="box"><strong>UUID</strong><br><span class="uuid">${escapeHtml(ticket.fiscal.externalUuid || 'Pendiente')}</span></div></div>
    <table><thead><tr><th>Concepto</th><th>Cantidad</th><th>Precio</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="totals"><div class="total"><strong>Total</strong><strong>${escapeHtml(formatMoney(ticket.totalCents))}</strong></div></div>
    ${qr ? `<div class="qr"><img alt="QR fiscal" src="${qr}"><div><strong>Verificacion fiscal</strong><p class="muted">Escanea el QR para comprobar la factura.</p><div class="uuid">${escapeHtml(ticket.fiscal.verificationUrl)}</div></div></div>` : ''}
  </body></html>`)
  popup.document.close()
}
