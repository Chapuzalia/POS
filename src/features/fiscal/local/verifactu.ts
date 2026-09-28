/** AEAT hash specification 0.1.2 (27 August 2024). Values must match the XML fields. */
export type InvoiceIdentity = {
  issuerNif: string
  seriesAndNumber: string
  issueDate: string // DD-MM-YYYY, as serialized in AEAT XML
}

export type AltaHashInput = InvoiceIdentity & {
  kind: 'alta'
  invoiceType: string
  taxTotal: string
  invoiceTotal: string
  previousHash: string | null
  generatedAt: string // YYYY-MM-DDTHH:mm:ss+HH:mm
}

export type AnulacionHashInput = InvoiceIdentity & {
  kind: 'anulacion'
  previousHash: string | null
  generatedAt: string
}

export type VerifactuHashInput = AltaHashInput | AnulacionHashInput

function trimmed(value: string | null): string {
  return (value ?? '').trim()
}

/** Field names and order are deliberately different for alta and anulación. */
export function aeatHashSource(input: VerifactuHashInput): string {
  const fields: Array<[string, string | null]> = input.kind === 'alta'
    ? [
        ['IDEmisorFactura', input.issuerNif],
        ['NumSerieFactura', input.seriesAndNumber],
        ['FechaExpedicionFactura', input.issueDate],
        ['TipoFactura', input.invoiceType],
        ['CuotaTotal', input.taxTotal],
        ['ImporteTotal', input.invoiceTotal],
        ['Huella', input.previousHash],
        ['FechaHoraHusoGenRegistro', input.generatedAt],
      ]
    : [
        ['IDEmisorFacturaAnulada', input.issuerNif],
        ['NumSerieFacturaAnulada', input.seriesAndNumber],
        ['FechaExpedicionFacturaAnulada', input.issueDate],
        ['Huella', input.previousHash],
        ['FechaHoraHusoGenRegistro', input.generatedAt],
      ]
  return fields.map(([name, value]) => `${name}=${trimmed(value)}`).join('&')
}

export async function aeatHash(input: VerifactuHashInput): Promise<string> {
  const bytes = new TextEncoder().encode(aeatHashSource(input))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** QR specification 0.5.0. The QR contains the URL, never the register hash. */
export function aeatQrUrl(input: InvoiceIdentity & { invoiceTotal: string; environment: 'test' | 'production' }): string {
  const base = input.environment === 'test'
    ? 'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR'
    : 'https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR'
  const params = new URLSearchParams({
    nif: input.issuerNif.trim(),
    numserie: input.seriesAndNumber.trim(),
    fecha: input.issueDate.trim(),
    importe: input.invoiceTotal.trim(),
  })
  return `${base}?${params.toString()}`
}
