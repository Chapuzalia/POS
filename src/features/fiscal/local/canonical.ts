import { z } from 'zod'
import { aeatHash, aeatQrUrl, type InvoiceIdentity } from './verifactu.ts'

const nif = z.string().regex(/^[A-Z0-9]{9}$/)
const date = z.string().regex(/^\d{2}-\d{2}-\d{4}$/)
const amount = z.string().regex(/^-?\d{1,12}\.\d{2}$/)
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
const identity = z.object({ IDEmisorFactura: nif, NumSerieFactura: z.string().min(1).max(60), FechaExpedicionFactura: date }).strict()
const previous = identity.extend({ Huella: z.string().regex(/^[0-9A-F]{64}$/) }).strict()
const chain = z.union([z.object({ PrimerRegistro: z.literal('S') }).strict(), z.object({ RegistroAnterior: previous }).strict()])
const system = z.object({
  NombreRazon: z.string().min(1).max(120), NIF: nif,
  NombreSistemaInformatico: z.string().min(1).max(30), IdSistemaInformatico: z.string().length(2),
  Version: z.string().min(1).max(50), NumeroInstalacion: z.string().min(1).max(100),
  TipoUsoPosibleSoloVerifactu: z.literal('S'), TipoUsoPosibleMultiOT: z.enum(['S', 'N']), IndicadorMultiplesOT: z.enum(['S', 'N']),
}).strict()
const detail = z.object({ Impuesto: z.literal('01'), ClaveRegimen: z.literal('01'), CalificacionOperacion: z.literal('S1'), TipoImpositivo: z.string().regex(/^\d{1,3}\.\d{2}$/), BaseImponibleOimporteNoSujeto: amount, CuotaRepercutida: amount }).strict()
const alta = z.object({
  IDVersion: z.literal('1.0'), IDFactura: identity, NombreRazonEmisor: z.string().min(1).max(120),
  TipoFactura: z.enum(['F1', 'F2', 'R1', 'R5']), DescripcionOperacion: z.string().min(1).max(500),
  TipoRectificativa: z.literal('I').optional(),
  FacturasRectificadas: z.object({ IDFacturaRectificada: z.array(identity).min(1).max(1) }).strict().optional(),
  Destinatarios: z.object({ IDDestinatario: z.array(z.object({ NombreRazon: z.string().min(1).max(120), NIF: nif }).strict()).length(1) }).strict().optional(),
  Desglose: z.object({ DetalleDesglose: z.array(detail).min(1).max(12) }).strict(),
  CuotaTotal: amount, ImporteTotal: amount, Encadenamiento: chain, SistemaInformatico: system,
  FechaHoraHusoGenRegistro: timestamp, TipoHuella: z.literal('01'), Huella: z.string().regex(/^[0-9A-F]{64}$/),
}).strict().superRefine((value, ctx) => {
  if (value.TipoFactura === 'F1' && !value.Destinatarios) ctx.addIssue({ code: 'custom', message: 'F1 requiere destinatario.', path: ['Destinatarios'] })
  if ((value.TipoFactura === 'R1' || value.TipoFactura === 'R5') && (value.TipoRectificativa !== 'I' || !value.FacturasRectificadas)) ctx.addIssue({ code: 'custom', message: 'La rectificativa requiere tipo I y factura rectificada.' })
  if (value.TipoFactura !== 'R1' && value.TipoFactura !== 'R5' && (value.TipoRectificativa || value.FacturasRectificadas)) ctx.addIssue({ code: 'custom', message: 'Solo las rectificativas pueden declarar factura rectificada.' })
  const cents = (text: string) => aeatToCents(text)
  const tax = value.Desglose.DetalleDesglose.reduce((sum, row) => sum + cents(row.CuotaRepercutida), 0)
  const gross = value.Desglose.DetalleDesglose.reduce((sum, row) => sum + cents(row.BaseImponibleOimporteNoSujeto) + cents(row.CuotaRepercutida), 0)
  if (tax !== cents(value.CuotaTotal) || gross !== cents(value.ImporteTotal)) ctx.addIssue({ code: 'custom', message: 'El desglose no cuadra con la cuota y el importe.' })
})
const annulledIdentity = z.object({ IDEmisorFacturaAnulada: nif, NumSerieFacturaAnulada: z.string().min(1).max(60), FechaExpedicionFacturaAnulada: date }).strict()
const annulment = z.object({ IDVersion: z.literal('1.0'), IDFactura: annulledIdentity, Encadenamiento: chain, SistemaInformatico: system, FechaHoraHusoGenRegistro: timestamp, TipoHuella: z.literal('01'), Huella: z.string().regex(/^[0-9A-F]{64}$/) }).strict()

export const canonicalRecordSchema = z.union([z.object({ RegistroAlta: alta }).strict(), z.object({ RegistroAnulacion: annulment }).strict()])
export type CanonicalRecord = z.infer<typeof canonicalRecordSchema>
export type FiscalSystem = z.infer<typeof system>
export type FiscalDetail = z.infer<typeof detail>
export type FiscalPrevious = z.infer<typeof previous>

export function centsToAeat(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error('Importe fiscal fuera de rango.')
  return `${cents < 0 ? '-' : ''}${Math.trunc(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`
}

export function aeatToCents(value: string): number {
  const match = /^(-?)(\d{1,12})\.(\d{2})$/.exec(value)
  if (!match) throw new Error('Importe AEAT inválido.')
  const cents = Number(match[2]) * 100 + Number(match[3])
  if (!Number.isSafeInteger(cents)) throw new Error('Importe AEAT fuera de rango.')
  return match[1] ? -cents : cents
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** Deterministic XML fragment for the supported XSD v1.0 subset, without SOAP or cabecera. */
export function canonicalRecordToXml(value: CanonicalRecord): string {
  const parsed = canonicalRecordSchema.parse(value)
  const node = (name: string, content: unknown, root = false): string => {
    if (Array.isArray(content)) return content.map(item => node(name, item)).join('')
    const inner = typeof content === 'object' && content !== null
      ? Object.entries(content).map(([key, item]) => node(key, item)).join('')
      : xmlEscape(String(content))
    const namespace = root ? ' xmlns:sf="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd"' : ''
    return `<sf:${name}${namespace}>${inner}</sf:${name}>`
  }
  const [name, content] = Object.entries(parsed)[0]
  return node(name, content, true)
}

export async function createAltaRecord(input: {
  invoice: InvoiceIdentity; issuerName: string; type: 'F1' | 'F2' | 'R1' | 'R5'; description: string
  recipient?: { name: string; nif: string }; details: FiscalDetail[]; system: FiscalSystem
  rectifiedInvoice?: InvoiceIdentity
  previous: FiscalPrevious | null; generatedAt: string; environment: 'test' | 'production'
}): Promise<{ canonicalRecord: CanonicalRecord; hash: string; qrUrl: string }> {
  const taxCents = input.details.reduce((sum, row) => sum + aeatToCents(row.CuotaRepercutida), 0)
  const grossCents = input.details.reduce((sum, row) => sum + aeatToCents(row.BaseImponibleOimporteNoSujeto) + aeatToCents(row.CuotaRepercutida), 0)
  const taxTotal = centsToAeat(taxCents)
  const invoiceTotal = centsToAeat(grossCents)
  const hash = await aeatHash({ kind: 'alta', ...input.invoice, invoiceType: input.type, taxTotal, invoiceTotal, previousHash: input.previous?.Huella ?? null, generatedAt: input.generatedAt })
  const record = canonicalRecordSchema.parse({ RegistroAlta: {
    IDVersion: '1.0', IDFactura: { IDEmisorFactura: input.invoice.issuerNif, NumSerieFactura: input.invoice.seriesAndNumber, FechaExpedicionFactura: input.invoice.issueDate },
    NombreRazonEmisor: input.issuerName, TipoFactura: input.type, DescripcionOperacion: input.description,
     ...((input.type === 'R1' || input.type === 'R5') ? { TipoRectificativa: 'I' as const, FacturasRectificadas: { IDFacturaRectificada: [{ IDEmisorFactura: (input.rectifiedInvoice ?? (() => { throw new Error('Falta factura rectificada.') })()).issuerNif, NumSerieFactura: (input.rectifiedInvoice ?? (() => { throw new Error('Falta factura rectificada.') })()).seriesAndNumber, FechaExpedicionFactura: (input.rectifiedInvoice ?? (() => { throw new Error('Falta factura rectificada.') })()).issueDate }] } } : {}),
     ...(input.recipient ? { Destinatarios: { IDDestinatario: [{ NombreRazon: input.recipient.name, NIF: input.recipient.nif }] } } : {}),
    Desglose: { DetalleDesglose: input.details }, CuotaTotal: taxTotal, ImporteTotal: invoiceTotal,
    Encadenamiento: input.previous ? { RegistroAnterior: input.previous } : { PrimerRegistro: 'S' },
    SistemaInformatico: input.system, FechaHoraHusoGenRegistro: input.generatedAt, TipoHuella: '01', Huella: hash,
  } })
  return { canonicalRecord: record, hash, qrUrl: aeatQrUrl({ ...input.invoice, invoiceTotal, environment: input.environment }) }
}

export async function createRectificativeRecord(input: {
  invoice: InvoiceIdentity; originalInvoice: InvoiceIdentity; issuerName: string; type: 'R1' | 'R5'; description: string
  recipient?: { name: string; nif: string }; details: FiscalDetail[]; system: FiscalSystem
  previous: FiscalPrevious | null; generatedAt: string; environment: 'test' | 'production'
}): Promise<{ canonicalRecord: CanonicalRecord; hash: string; qrUrl: string }> {
  return createAltaRecord({ ...input, rectifiedInvoice: input.originalInvoice })
}

export async function createAnulacionRecord(input: { invoice: InvoiceIdentity; system: FiscalSystem; previous: FiscalPrevious; generatedAt: string }): Promise<{ canonicalRecord: CanonicalRecord; hash: string }> {
  const hash = await aeatHash({ kind: 'anulacion', ...input.invoice, previousHash: input.previous.Huella, generatedAt: input.generatedAt })
  const record = canonicalRecordSchema.parse({ RegistroAnulacion: {
    IDVersion: '1.0', IDFactura: { IDEmisorFacturaAnulada: input.invoice.issuerNif, NumSerieFacturaAnulada: input.invoice.seriesAndNumber, FechaExpedicionFacturaAnulada: input.invoice.issueDate },
    Encadenamiento: { RegistroAnterior: input.previous }, SistemaInformatico: input.system,
    FechaHoraHusoGenRegistro: input.generatedAt, TipoHuella: '01', Huella: hash,
  } })
  return { canonicalRecord: record, hash }
}
