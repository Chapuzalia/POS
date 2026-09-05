import type { PrintTemplateContext, PrintTemplateType } from './types.ts'

export const PRINT_TEMPLATE_TYPE_LABELS: Record<PrintTemplateType, string> = {
  simplified_invoice: 'Factura simplificada / ticket',
  invoice: 'Factura completa',
  cash_closure: 'Cierre de caja (X/Z)',
  production: 'Comanda de producción',
  kds: 'KDS',
  test: 'Ticket de prueba',
}

type VariableGroup = { label: string; variables: Array<{ path: string; label: string }> }

const venue: VariableGroup = { label: 'Datos del local', variables: [
  { path: 'venue.name', label: 'Nombre' }, { path: 'venue.legal_name', label: 'Razón social' },
  { path: 'venue.tax_id', label: 'NIF/CIF' }, { path: 'venue.address', label: 'Dirección' },
] }
const ticket: VariableGroup = { label: 'Documento', variables: [
  { path: 'ticket.number', label: 'Número' }, { path: 'ticket.date', label: 'Fecha' },
  { path: 'ticket.time', label: 'Hora' }, { path: 'ticket.datetime', label: 'Fecha y hora' },
] }

export const PRINT_TEMPLATE_VARIABLES: Record<PrintTemplateType, VariableGroup[]> = {
  simplified_invoice: [venue, ticket,
    { label: 'Venta', variables: [
      { path: 'cash_register.name', label: 'Caja' }, { path: 'employee.name', label: 'Empleado' },
      { path: 'items', label: 'Productos (colección)' }, { path: 'totals.rows', label: 'Totales (colección)' },
      { path: 'payment.rows', label: 'Pagos (colección)' },
    ] },
    { label: 'Producto (dentro de items)', variables: [
      { path: 'quantity', label: 'Cantidad' }, { path: 'name', label: 'Nombre' },
      { path: 'total', label: 'Total de línea' }, { path: 'details', label: 'Detalles (colección)' },
    ] },
    { label: 'Totales y fiscalidad', variables: [
      { path: 'totals.subtotal', label: 'Subtotal' }, { path: 'totals.tax', label: 'IVA' },
      { path: 'totals.total', label: 'Total' }, { path: 'fiscal.verification_url', label: 'URL/QR fiscal' },
      { path: 'footer.text', label: 'Pie configurado en TPV' },
    ] },
  ],
  invoice: [venue, ticket,
    { label: 'Cliente', variables: [
      { path: 'customer.name', label: 'Nombre / razón social' }, { path: 'customer.tax_id', label: 'NIF' },
      { path: 'customer.address', label: 'Dirección' }, { path: 'customer.postal_city', label: 'CP y localidad' },
    ] },
    { label: 'Factura', variables: [
      { path: 'items', label: 'Productos (colección)' }, { path: 'totals.rows', label: 'Desglose fiscal (colección)' },
      { path: 'totals.subtotal', label: 'Subtotal' }, { path: 'totals.tax', label: 'IVA' },
      { path: 'totals.total', label: 'Total' }, { path: 'payment.rows', label: 'Pagos (colección)' },
    ] },
  ],
  cash_closure: [venue, ticket,
    { label: 'Caja', variables: [
      { path: 'cash_register.name', label: 'Nombre de caja' }, { path: 'cash_session.number', label: 'Turno' },
      { path: 'cash_session.opened_at', label: 'Apertura' }, { path: 'cash_session.closed_at', label: 'Cierre' },
      { path: 'employee.name', label: 'Empleado' },
    ] },
    { label: 'Colecciones', variables: [
      { path: 'summary.rows', label: 'Resumen' }, { path: 'payment.rows', label: 'Métodos de pago' },
      { path: 'cash.rows', label: 'Efectivo' }, { path: 'operations.rows', label: 'Operativa' },
    ] },
  ],
  production: [venue, ticket,
    { label: 'Comanda', variables: [
      { path: 'table.name', label: 'Mesa' }, { path: 'order.number', label: 'Número de envío' },
      { path: 'destinations', label: 'Destinos (colección)' },
    ] },
    { label: 'Dentro de destinos', variables: [
      { path: 'name', label: 'Nombre del destino' }, { path: 'items', label: 'Productos del destino' },
      { path: 'quantity', label: 'Cantidad del producto' }, { path: 'details', label: 'Detalles del producto' },
    ] },
  ],
  kds: [venue, ticket,
    { label: 'KDS', variables: [
      { path: 'table.name', label: 'Mesa' }, { path: 'order.number', label: 'Comanda' },
      { path: 'destinations', label: 'Destinos (colección)' }, { path: 'items', label: 'Productos (colección)' },
    ] },
  ],
  test: [ticket, { label: 'Impresora', variables: [
    { path: 'printer.ip', label: 'IP' }, { path: 'printer.port', label: 'Puerto' },
    { path: 'printer.name', label: 'Nombre' },
  ] }],
}

const mockSale = {
  venue: { name: 'Restaurante Ejemplo', legal_name: 'Ejemplo Hostelería SL', tax_id: 'B12345678', address: 'Calle Mayor 12' },
  document: { title: '', label: '', number_label: 'Ticket', date_label: 'Fecha' },
  ticket: { number: 'F-2026-0124', date: '02/09/2026', time: '14:32', datetime: '02/09/2026 14:32' },
  cash_register: { name: 'Caja principal' }, employee: { name: 'María' },
  customer: {},
  items: [
    { quantity: '2', name: 'Ensalada de la casa', total: '18,00 €', details: [{ text: '  + Sin cebolla' }] },
    { quantity: '1', name: 'Croquetas', total: '9,50 €', details: [] },
  ],
  totals: { subtotal: '25,00 €', tax: '2,50 €', total: '27,50 €', rows: [{ label: 'Base imponible', value: '25,00 €' }, { label: 'IVA 10 %', value: '2,50 €' }, { label: 'TOTAL', value: '27,50 €' }] },
  payment: { rows: [{ label: 'Tarjeta', value: '27,50 €' }] }, fiscal: {}, footer: { text: 'Gracias por su visita' },
}

export function getMockPrintTemplateContext(type: PrintTemplateType): PrintTemplateContext {
  if (type === 'invoice') return { ...structuredClone(mockSale), document: { ...mockSale.document, title: 'FACTURA', number_label: 'Factura' }, customer: { name: 'Cliente Ejemplo SL', tax_id: 'B87654321', address: 'Avenida Central 4', postal_city: '28001 Madrid', province: 'Madrid' } }
  if (type === 'simplified_invoice') return structuredClone(mockSale)
  if (type === 'cash_closure') return {
    venue: mockSale.venue, document: { title: 'INFORME Z', id: 'close-124', generated_at: '02/09/2026 23:15' },
    ticket: mockSale.ticket, cash_register: { name: 'Caja principal' }, cash_session: { number: 'Turno tarde', opened_at: '02/09/2026 15:00', closed_at: '02/09/2026 23:15', show_times: true }, employee: { name: 'María' },
    summary: { rows: [{ label: 'Operaciones', value: '42' }, { label: 'Ventas netas', value: '1.248,30 €' }] }, payment: { rows: [{ label: 'Efectivo', value: '520,00 €' }, { label: 'Tarjeta', value: '728,30 €' }] }, cash: { rows: [{ label: 'Fondo inicial', value: '100,00 €' }, { label: 'Efectivo esperado', value: '620,00 €' }] }, operations: { rows: [{ label: 'Retirar de caja', value: '520,00 €' }] },
  }
  if (type === 'test') return { printer: { name: 'Epson Cocina', ip: '192.168.1.50', port: 9100 }, ticket: mockSale.ticket }
  return {
    venue: mockSale.venue, ticket: mockSale.ticket, table: { name: '12' }, order: { number: '124' },
    destinations: [
      { name: 'COCINA', items: [{ quantity: 2, name: 'Ensalada', details: [] }, { quantity: 1, name: 'Croquetas', details: [] }] },
      { name: 'PLANCHA', items: [{ quantity: 2, name: 'Entrecot', details: [{ text: '  NOTA: POCO HECHO' }] }] },
    ],
  }
}
