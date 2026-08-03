import type {
  FiscalInvoiceRow,
  FiscalRecipient,
  FiscalStatus,
  FiscalTicket,
  FiscalTicketLine,
  TicketBaiCreatePayload,
  VerifactuCreatePayload,
} from './types.ts'

export function mapFiscalCancellation(invoice: FiscalInvoiceRow): Record<string, unknown> {
  const base = {
    serie: invoice.series,
    numero: invoice.number,
    fecha_expedicion: formatFiscalDate(invoice.issue_date),
  }

  if (invoice.provider === 'ticketbai') {
    return invoice.status === 'rejected'
      ? { ...base, rechazo_previo: true }
      : base
  }

  return {
    ...base,
    rechazo_previo: invoice.status === 'rejected' ? 'S' : 'N',
    sin_registro_previo: invoice.status === 'rejected' ? 'S' : 'N',
  }
}

const RECTIFICATIVE_CODES = new Set(['R1', 'R2', 'R3', 'R4', 'R5'])

function cents(value: number) {
  if (!Number.isInteger(value)) throw new Error('Los importes fiscales deben estar expresados en centimos enteros')
  return (value / 100).toFixed(2)
}

function decimal(value: number) {
  if (!Number.isFinite(value)) throw new Error('Valor decimal fiscal no valido')
  return String(Number(value.toFixed(8)))
}

export function formatFiscalDate(value: string | Date) {
  const date = value instanceof Date ? value : new Date(`${value.slice(0, 10)}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) throw new Error('Fecha fiscal no valida')
  return `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()}`
}

export function stableFiscalIdempotencyKey(tenantId: string, invoiceId: string, operation: 'create' | 'cancel') {
  const key = `${tenantId}:${invoiceId}:${operation}`
  if (!/^[\x20-\x7E]{1,255}$/.test(key)) throw new Error('Idempotency-Key fiscal no valida')
  return key
}

export function groupTaxSnapshots(lines: FiscalTicketLine[]) {
  const groups = new Map<string, { baseCents: number; taxCents: number; rate: number }>()
  for (const line of lines) {
    if (line.tax_rate === null || line.taxable_base_cents === null || line.tax_amount_cents === null) {
      throw new Error(`La linea ${line.id} no tiene un snapshot fiscal completo`)
    }
    if (line.taxable_base_cents + line.tax_amount_cents !== line.net_total_cents) {
      throw new Error(`El snapshot fiscal de la linea ${line.id} no cuadra con su total neto`)
    }
    const key = Number(line.tax_rate).toFixed(2)
    const current = groups.get(key) ?? { baseCents: 0, taxCents: 0, rate: Number(line.tax_rate) }
    current.baseCents += line.taxable_base_cents
    current.taxCents += line.tax_amount_cents
    groups.set(key, current)
  }
  return [...groups.values()].sort((left, right) => left.rate - right.rate)
}

function readRecipient(documentData: Record<string, unknown>) {
  const value = documentData.recipient
  return value && typeof value === 'object' ? value as FiscalRecipient : null
}

function description(invoice: FiscalInvoiceRow, ticket: FiscalTicket, maxLength: number) {
  const configured = typeof invoice.document_data.descripcion === 'string'
    ? invoice.document_data.descripcion.trim()
    : ''
  const lineDescription = ticket.ticket_lines
    .map((line) => [line.product_name, line.variant_name].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(', ')
  return (configured || lineDescription || 'Venta de bienes y servicios').slice(0, maxLength)
}

function operationDate(invoice: FiscalInvoiceRow) {
  return invoice.operation_date && invoice.operation_date !== invoice.issue_date
    ? formatFiscalDate(invoice.operation_date)
    : undefined
}

function rectificativeCode(invoice: FiscalInvoiceRow) {
  const value = String(invoice.document_data.codigo ?? '')
  if (!RECTIFICATIVE_CODES.has(value)) throw new Error('La factura rectificativa necesita un codigo R1, R2, R3, R4 o R5')
  return value as 'R1' | 'R2' | 'R3' | 'R4' | 'R5'
}

export function mapVerifactuInvoice(invoice: FiscalInvoiceRow, ticket: FiscalTicket): VerifactuCreatePayload {
  const taxGroups = groupTaxSnapshots(ticket.ticket_lines)
  if (!taxGroups.length || taxGroups.length > 12) throw new Error('VeriFactu admite entre 1 y 12 grupos de impuestos')
  const recipient = readRecipient(invoice.document_data)
  const tipoFactura = invoice.invoice_type === 'simplified'
    ? 'F2'
    : invoice.invoice_type === 'corrective' ? rectificativeCode(invoice) : 'F1'
  const payload: VerifactuCreatePayload = {
    serie: invoice.series,
    numero: invoice.number,
    fecha_expedicion: formatFiscalDate(invoice.issue_date),
    ...(operationDate(invoice) ? { fecha_operacion: operationDate(invoice) } : {}),
    tipo_factura: tipoFactura,
    descripcion: description(invoice, ticket, 500),
    lineas: taxGroups.map((group) => ({
      base_imponible: cents(group.baseCents),
      tipo_impositivo: decimal(group.rate),
      cuota_repercutida: cents(group.taxCents),
      impuesto: '01',
      calificacion_operacion: 'S1',
      clave_regimen: '01',
    })),
    importe_total: cents(ticket.total_cents),
  }

  if (invoice.invoice_type !== 'simplified') {
    if (!recipient?.nombre || (!recipient.nif && !recipient.id_otro)) {
      throw new Error('La factura no simplificada necesita nombre y NIF o id_otro del destinatario')
    }
    payload.nombre = recipient.nombre
    if (recipient.nif) payload.nif = recipient.nif
    else if (recipient.id_otro) payload.id_otro = recipient.id_otro
  }

  if (invoice.invoice_type === 'corrective') {
    const tipo = invoice.document_data.tipo_rectificativa
    if (tipo !== 'S' && tipo !== 'I') throw new Error('La rectificativa necesita tipo_rectificativa S o I')
    payload.tipo_rectificativa = tipo
    if (tipo === 'S') {
      const importe = invoice.document_data.importe_rectificativa as Record<string, unknown> | undefined
      if (importe?.base_rectificada === undefined || importe.cuota_rectificada === undefined) {
        throw new Error('La rectificativa por sustitucion necesita base_rectificada y cuota_rectificada')
      }
      payload.importe_rectificativa = {
        base_rectificada: String(importe.base_rectificada),
        cuota_rectificada: String(importe.cuota_rectificada),
        ...(importe.cuota_recargo_rectificada === undefined ? {} : { cuota_recargo_rectificada: String(importe.cuota_recargo_rectificada) }),
      }
    }
    if (Array.isArray(invoice.document_data.facturas_rectificadas)) {
      payload.facturas_rectificadas = invoice.document_data.facturas_rectificadas as VerifactuCreatePayload['facturas_rectificadas']
    }
  }

  return payload
}

export function mapTicketBaiInvoice(invoice: FiscalInvoiceRow, ticket: FiscalTicket): TicketBaiCreatePayload {
  const taxGroups = groupTaxSnapshots(ticket.ticket_lines)
  if (!taxGroups.length || taxGroups.length > 12) throw new Error('TicketBAI admite entre 1 y 12 grupos de IVA')
  const recipient = readRecipient(invoice.document_data)
  const payload: TicketBaiCreatePayload = {
    serie: invoice.series,
    numero: invoice.number,
    fecha_expedicion: formatFiscalDate(invoice.issue_date),
    ...(operationDate(invoice) ? { fecha_operacion: operationDate(invoice) } : {}),
    descripcion: description(invoice, ticket, 250),
    simplificada: invoice.invoice_type === 'simplified',
    tipo_operacion: invoice.document_data.tipo_operacion === 'bienes' ? 'bienes' : 'servicios',
    lineas: ticket.ticket_lines.map((line) => {
      if (line.taxable_base_cents === null) throw new Error(`La linea ${line.id} no tiene base imponible`)
      const quantity = Number(line.quantity)
      if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Cantidad no valida en la linea ${line.id}`)
      return {
        descripcion: [line.product_name, line.variant_name].filter(Boolean).join(' ').slice(0, 250),
        cantidad: decimal(quantity),
        importe_unitario: (line.taxable_base_cents / 100 / quantity).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''),
        importe_total: cents(line.net_total_cents),
      }
    }),
    desglose_iva: taxGroups.map((group) => ({
      base_imponible: cents(group.baseCents),
      tipo_impositivo: decimal(group.rate),
      cuota_impuesto: cents(group.taxCents),
    })),
    importe_total: cents(ticket.total_cents),
  }

  if (!payload.simplificada) {
    if (!recipient?.nombre || !recipient.cp || !recipient.direccion || (!recipient.nif && !recipient.id_otro)) {
      throw new Error('La factura TicketBAI no simplificada necesita nombre, direccion, CP y NIF o id_otro')
    }
    payload.nombre = recipient.nombre
    payload.cp = recipient.cp
    payload.direccion = recipient.direccion
    if (recipient.nif) payload.nif = recipient.nif
    else if (recipient.id_otro?.id_type === '07') {
      throw new Error('TicketBAI solo admite id_otro con id_type 02, 03, 04, 05 o 06')
    } else if (recipient.id_otro) {
      payload.id_otro = { ...recipient.id_otro, id_type: recipient.id_otro.id_type }
    }
  }

  if (invoice.invoice_type === 'corrective') {
    const tipo = invoice.document_data.tipo_rectificativa
    if (tipo !== 'S' && tipo !== 'I') throw new Error('La rectificativa necesita tipo S o I')
    const rectificativa = invoice.document_data.rectificativa as Record<string, unknown> | undefined
    payload.rectificativa = {
      codigo: rectificativeCode(invoice),
      tipo,
      ...(rectificativa?.base_rectificada === undefined ? {} : { base_rectificada: String(rectificativa.base_rectificada) }),
      ...(rectificativa?.cuota_rectificada === undefined ? {} : { cuota_rectificada: String(rectificativa.cuota_rectificada) }),
      ...(rectificativa?.cuota_recargo === undefined ? {} : { cuota_recargo: String(rectificativa.cuota_recargo) }),
    }
    if (Array.isArray(invoice.document_data.rectificadas_sustituidas)) {
      payload.rectificadas_sustituidas = invoice.document_data.rectificadas_sustituidas as TicketBaiCreatePayload['rectificadas_sustituidas']
    }
  }

  return payload
}

export function mapProviderStatus(value: string | undefined): FiscalStatus {
  const normalized = String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[\s_-]+/g, '')
  if (normalized === 'correcto' || normalized === 'correcta') return 'accepted'
  if (normalized === 'aceptadoconerrores' || normalized === 'aceptadaconerrores') return 'accepted_with_errors'
  if (normalized === 'anulada' || normalized === 'anulado') return 'cancelled'
  if (normalized === 'pendiente') return 'pending'
  if (normalized.includes('errorservidor')) return 'error'
  if (['incorrecto', 'incorrecta', 'duplicado', 'facturainexistente', 'noregistrado', 'rechazado', 'rechazada'].includes(normalized)) return 'rejected'
  return 'error'
}
