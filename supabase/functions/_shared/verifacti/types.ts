export type FiscalProviderName = 'verifactu' | 'ticketbai'
export type FiscalIntegrationProvider = FiscalProviderName | 'odoo'
export type FiscalEnvironment = 'test' | 'production'
export type FiscalStatus = 'pending' | 'generated' | 'accepted' | 'accepted_with_errors' | 'rejected' | 'cancelled' | 'error'
export type FiscalDocumentKind = 'simplified' | 'full' | 'corrective'

/** Provider-neutral commercial input. All monetary values are integer cents. */
export type CommercialFiscalDocument = {
  externalId: string
  idempotencyKey: string
  fiscalEntityRef: string
  venueRef: string
  operationTimestamp: string
  kind: FiscalDocumentKind
  lines: CommercialFiscalLine[]
  expectedTotalCents: number
  customer?: FiscalCustomer
}

export type CommercialFiscalLine = {
  description: string
  quantity: number
  unitPriceCents: number
  lineTotalCents: number
  discountCents?: number
  taxCode: string
  taxSnapshot: { taxableBaseCents: number; taxCents: number }
}

export type FiscalCustomer = {
  name: string
  vat: string
  street: string
  zip: string
  city: string
  country_code: 'ES'
}

export type NormalizedFiscalStatus = FiscalStatus | 'generated'
export type NormalizedFiscalResult = {
  documentId: string
  fiscalNumber?: string
  fiscalType?: string
  fiscalDate?: string
  status: NormalizedFiscalStatus
  finalTotalCents?: number
  qrPayload?: string | false
  qrUrl?: string | false
  error?: { code?: string; message: string; retryable: boolean }
}

export class FiscalDocumentValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FiscalDocumentValidationError'
  }
}

export class FiscalTotalDiscrepancyError extends Error {
  readonly expectedTotalCents: number
  readonly actualTotalCents: number
  constructor(expectedTotalCents: number, actualTotalCents: number) {
    super(`El total fiscal no coincide: esperado ${expectedTotalCents}, recibido ${actualTotalCents}`)
    this.name = 'FiscalTotalDiscrepancyError'
    this.expectedTotalCents = expectedTotalCents
    this.actualTotalCents = actualTotalCents
  }
}

export type FiscalIssueOptions = { idempotencyKey?: string }
export interface FiscalDocumentProvider {
  issue(document: CommercialFiscalDocument, options?: FiscalIssueOptions): Promise<NormalizedFiscalResult>
  status(documentId: string): Promise<NormalizedFiscalResult>
  rectify(document: CommercialFiscalDocument, options?: FiscalIssueOptions): Promise<NormalizedFiscalResult>
  cancel(documentId: string, options?: FiscalIssueOptions): Promise<NormalizedFiscalResult>
}

export type FiscalInvoiceRow = {
  id: string
  tenant_id: string
  venue_id: string
  ticket_id: string
  sale_id: string | null
  provider: FiscalIntegrationProvider
  environment: FiscalEnvironment
  invoice_type: 'normal' | 'simplified' | 'corrective'
  series: string
  number: string
  issue_date: string
  operation_date: string | null
  document_data: Record<string, unknown>
  status: FiscalStatus
  pending_operation: 'create' | 'cancel' | 'none'
  idempotency_key: string
  external_uuid: string | null
  attempts: number
}

export type FiscalTicketLine = {
  id: string
  product_name: string
  variant_name: string
  quantity: number
  net_total_cents: number
  taxable_base_cents: number | null
  tax_amount_cents: number | null
  tax_rate: number | null
}

export type FiscalTicket = {
  id: string
  tenant_id: string
  venue_id: string
  total_cents: number
  local_created_at: string
  ticket_lines: FiscalTicketLine[]
}

export type FiscalRecipient = {
  nif?: string
  nombre?: string
  cp?: string
  direccion?: string
  id_otro?: {
    codigo_pais?: string
    id_type: '02' | '03' | '04' | '05' | '06' | '07'
    id: string
  }
}

export type VerifactuTaxLine = {
  base_imponible: string
  tipo_impositivo: string
  cuota_repercutida: string
  impuesto: '01'
  calificacion_operacion: 'S1'
  clave_regimen: '01'
}

export type VerifactuCreatePayload = {
  serie: string
  numero: string
  fecha_expedicion: string
  fecha_operacion?: string
  tipo_factura: 'F1' | 'F2' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'F3'
  descripcion: string
  lineas: VerifactuTaxLine[]
  importe_total: string
  nif?: string
  id_otro?: FiscalRecipient['id_otro']
  nombre?: string
  validar_destinatario?: boolean
  tipo_rectificativa?: 'S' | 'I'
  importe_rectificativa?: {
    base_rectificada: string
    cuota_rectificada: string
    cuota_recargo_rectificada?: string
  }
  facturas_rectificadas?: Array<{ serie: string; numero: string; fecha_expedicion: string }>
}

export type TicketBaiCreatePayload = {
  serie: string
  numero: string
  fecha_expedicion: string
  fecha_operacion?: string
  descripcion: string
  simplificada: boolean
  nif?: string
  id_otro?: Omit<NonNullable<FiscalRecipient['id_otro']>, 'id_type'> & {
    id_type: '02' | '03' | '04' | '05' | '06'
  }
  nombre?: string
  validar_destinatario?: boolean
  cp?: string
  direccion?: string
  tipo_operacion: 'servicios' | 'bienes'
  lineas: Array<{
    descripcion: string
    cantidad: string
    importe_unitario: string
    importe_total: string
  }>
  desglose_iva: Array<{
    base_imponible: string
    tipo_impositivo: string
    cuota_impuesto: string
  }>
  importe_total: string
  rectificativa?: {
    codigo: 'R1' | 'R2' | 'R3' | 'R4' | 'R5'
    tipo: 'S' | 'I'
    base_rectificada?: string
    cuota_rectificada?: string
    cuota_recargo?: string
  }
  rectificadas_sustituidas?: Array<{ serie: string; numero: string; fecha_expedicion: string }>
}

export type ProviderStatusResponse = {
  uuid?: string
  nif?: string
  serie?: string
  numero?: string
  fecha_expedicion?: string
  operacion?: string
  estado?: string
  url?: string
  qr?: string
  codigo_error?: string
  mensaje_error?: string
  estado_registro_duplicado?: string
  tbai?: string
  importe_total_cents?: number
  final_total_cents?: number
  document_id?: string
  tipo_factura?: string
  [key: string]: unknown
}

export type ProviderCreateResponse = ProviderStatusResponse & {
  uuid: string
  estado: string
  huella?: string
}

export type ProviderHttpResult<T> = {
  data: T
  httpStatus: number
  attempts: number
}

export interface FiscalProvider {
  readonly name: FiscalProviderName
  health(): Promise<ProviderHttpResult<Record<string, unknown>>>
  create(payload: VerifactuCreatePayload | TicketBaiCreatePayload, idempotencyKey: string): Promise<ProviderHttpResult<ProviderCreateResponse>>
  getStatus(uuid: string): Promise<ProviderHttpResult<ProviderStatusResponse>>
  status(payload: { serie: string; numero: string; fecha_expedicion: string; fecha_operacion?: string }): Promise<ProviderHttpResult<ProviderStatusResponse>>
  cancel(payload: Record<string, unknown>, idempotencyKey: string): Promise<ProviderHttpResult<ProviderCreateResponse>>
  list(payload: Record<string, unknown>): Promise<ProviderHttpResult<unknown>>
}
