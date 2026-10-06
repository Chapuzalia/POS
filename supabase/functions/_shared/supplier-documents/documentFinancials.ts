import { z } from 'zod'
import type { OcrDocument, SupplierDocumentExtraction } from './core.ts'

const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const documentFinancialSummarySchema = z.object({
  version: z.literal(1),
  subtotalCents: cents.nullable(),
  taxCents: cents.nullable(),
  totalCents: cents.nullable(),
  charges: z.array(z.object({ label: z.string().max(80), amountCents: cents }).strict()).max(20),
  taxes: z.array(z.object({ baseCents: cents, rate: z.number().min(0).max(100), amountCents: cents }).strict()).max(20),
  issues: z.array(z.string().max(100)).max(20),
}).strict()
export type DocumentFinancialSummary = z.infer<typeof documentFinancialSummarySchema>

const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/[^A-Z0-9%]+/g, ' ').trim()
const totalLabel = /^(TOTAL|TOTAL A PAGAR|TOTAL EUROS|IMPORT FACTURA|IMPORTE FACTURA|TOTAL FACTURA)$/
const baseLabel = /^(TOTAL BASES|TOTAL BASE|TOTAL VENDA PRODUCTES)$/
const taxLabel = /^(TOTAL IVA|TOTAL IMPOSTOS|TOTAL IMPUESTOS)$/
const chargeLabel = /^(DISTR|LOG|I S P V|IMP PLASTIC|IMP PLASTICO)$/

// Amounts are parsed to integer cents. Never infer a decimal separator from a
// table of products or accept a date/reference as an amount.
function moneyCents(text: string): number | null {
  const value = text.trim().replace(/\s*(?:EUR(?:OS)?|€|\*)\s*$/i, '').trim()
  if (!/^\d+(?:[. ]\d{3})*(?:,\d{1,2})?$/.test(value) && !/^\d+(?:\.\d{1,2})?$/.test(value)) return null
  const separator = value.includes(',') ? ',' : /\.\d{1,2}$/.test(value) ? '.' : null
  const [whole, fraction = ''] = separator ? value.split(separator) : [value]
  const result = Number(whole.replace(/[. ]/g, '')) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(result) ? result : null
}

function taxRate(text: string): number | null {
  const match = text.trim().match(/^(?:I\.?V\.?A\.?\s*)?(\d{1,2}(?:[,.]\d{1,2})?)\s*%?$/i)
  return match ? Number(match[1].replace(',', '.')) : null
}

export function extractDocumentFinancialSummary(ocr: OcrDocument): DocumentFinancialSummary | null {
  const totals = new Set<number>(), bases = new Set<number>(), taxTotals = new Set<number>()
  const charges = new Map<string, Set<number>>()
  const taxes = new Map<string, DocumentFinancialSummary['taxes'][number]>()
  const issues = new Set<string>()
  const pair = (label: string, amount: string) => {
    const key = normalize(label), value = moneyCents(amount)
    if (value === null) return
    if (totalLabel.test(key)) totals.add(value)
    else if (baseLabel.test(key)) bases.add(value)
    else if (taxLabel.test(key)) taxTotals.add(value)
    else if (chargeLabel.test(key)) {
      const values = charges.get(key) ?? new Set<number>()
      values.add(value)
      charges.set(key, values)
    }
  }
  const addTax = (base: string, rateText: string, amount: string) => {
    const baseCents = moneyCents(base), rate = taxRate(rateText), amountCents = moneyCents(amount)
    if (baseCents === null || rate === null || amountCents === null || rate > 100) return
    if (!baseCents && !amountCents) return
    if (Math.abs(Math.round(baseCents * rate / 100) - amountCents) > 1) issues.add('TAX_SUMMARY_MATH_MISMATCH')
    taxes.set(`${baseCents}:${rate}:${amountCents}`, { baseCents, rate, amountCents })
  }
  // Read each textual label/value once, independent of repeated page/full text.
  for (const text of new Set([ocr.text, ...ocr.pages.map((page) => page.text)])) {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
    lines.forEach((line, index) => {
      const inline = line.match(/^(.+?)\s*:?\s+(\d[\d., ]*(?:\s*(?:EUROS?|€|\*))?)$/i)
      if (inline) pair(inline[1], inline[2])
      if (lines[index + 1]) pair(line, lines[index + 1])
      const tax = line.match(/^IVA\s+(\d+(?:[,.]\d+)?)\s*%\s+DE\s+(\d+(?:[,.]\d+)?)\s+(\d+(?:[,.]\d+)?)$/i)
      if (tax) addTax(tax[2], tax[1], tax[3])
    })
  }
  for (const page of ocr.pages) for (const table of page.tables) {
    const rows = Array.from({ length: table.rowCount }, () => Array<string>(table.columnCount).fill(''))
    for (const cell of table.cells) if (rows[cell.rowIndex]?.[cell.columnIndex] !== undefined) rows[cell.rowIndex][cell.columnIndex] = cell.text
    // Product charges already belong to lines; do not count them a second time.
    if (rows.some((row) => row.some((cell) => /DESCRIP/.test(normalize(cell)))
      && row.some((cell) => /^(QUANT|QUAN|CANTIDAD|QUANTITAT|UDS PESO|UDX PESO)/.test(normalize(cell))))) continue
    rows.forEach((row, index) => {
      row.forEach((cell, column) => {
        const inline = cell.match(/^(.+?)\s*:?\s+(\d[\d., ]*(?:\s*(?:EUROS?|€|\*))?)$/i)
        if (inline) pair(inline[1], inline[2])
        if (row[column + 1]) pair(cell, row[column + 1])
        if (rows[index + 1]) pair(cell, rows[index + 1][column])
      })
      const headers = row.map(normalize)
      const base = headers.findIndex((header) => /^(BASE IMPOS|BASE IMPON|IMPORTE BASE)/.test(header))
      const rate = headers.findIndex((header) => /^(% IVA|I V A %|IVA %|% IMPOST|% IMPUEST)/.test(header))
      const amount = headers.findIndex((header) => /^(IMPORT IVA|IMPORTE IVA|IMPORT IMPORTS|IMPORT IMPORTE)$/.test(header))
      if (base < 0 || rate < 0 || amount < 0) return
      for (const data of rows.slice(index + 1)) {
        addTax(data[base], data[rate], data[amount])
        headers.forEach((header, column) => {
          if (/^(IMPORTE RECARGO|IMPORT REC|TOTAL RECARGO)$/.test(header) && (moneyCents(data[column]) ?? 0) > 0)
            issues.add('UNSUPPORTED_TAX_SURCHARGE')
        })
      }
    })
  }
  const taxRows = [...taxes.values()]
  if (taxRows.length) {
    bases.add(taxRows.reduce((sum, tax) => sum + tax.baseCents, 0))
    taxTotals.add(taxRows.reduce((sum, tax) => sum + tax.amountCents, 0))
  }
  const single = (values: Set<number>, issue: string) => {
    if (values.size > 1) issues.add(issue)
    return values.size === 1 ? [...values][0] : null
  }
  const summary: DocumentFinancialSummary = {
    version: 1,
    subtotalCents: single(bases, 'AMBIGUOUS_DOCUMENT_SUBTOTAL'),
    taxCents: single(taxTotals, 'AMBIGUOUS_DOCUMENT_TAX'),
    totalCents: single(totals, 'AMBIGUOUS_DOCUMENT_TOTAL'),
    charges: [...charges].flatMap(([label, values]) => {
      const amountCents = single(values, 'AMBIGUOUS_DOCUMENT_CHARGE')
      return amountCents === null || amountCents === 0 ? [] : [{ label, amountCents }]
    }),
    taxes: taxRows,
    issues: [...issues],
  }
  return totals.size || bases.size || taxTotals.size || charges.size ? documentFinancialSummarySchema.parse(summary) : null
}

export function enrichDocumentFinancials(extraction: SupplierDocumentExtraction, ocr: OcrDocument): SupplierDocumentExtraction {
  const summary = extractDocumentFinancialSummary(ocr)
  if (!summary) return extraction
  const lineCents = extraction.lines.every((line) => line.lineTotal !== null)
    ? extraction.lines.reduce((sum, line) => sum + Math.round((line.lineTotal ?? 0) * 100), 0) : null
  const chargeCents = summary.charges.reduce((sum, charge) => sum + charge.amountCents, 0)
  const rate = summary.taxes.length === 1 ? summary.taxes[0].rate : null
  const canFillTax = !summary.issues.length && rate !== null && lineCents !== null && summary.subtotalCents !== null
    && Math.abs(lineCents + chargeCents - summary.subtotalCents) <= 5
    && extraction.lines.every((line) => line.taxRate === null || line.taxRate === rate)
  return {
    ...extraction,
    document: { ...extraction.document, total: summary.totalCents === null ? extraction.document.total : summary.totalCents / 100,
      financialSummary: summary },
    lines: canFillTax ? extraction.lines.map((line) => ({ ...line, taxRate: line.taxRate ?? rate })) : extraction.lines,
  }
}

export function validateDocumentFinancials(extraction: SupplierDocumentExtraction) {
  const summary = extraction.document.financialSummary
  if (!summary) return null
  const differences: number[] = []
  const lineCents = extraction.lines.every((line) => line.lineTotal !== null)
    ? extraction.lines.reduce((sum, line) => sum + Math.round((line.lineTotal ?? 0) * 100), 0) : null
  const chargeCents = summary.charges.reduce((sum, charge) => sum + charge.amountCents, 0)
  if (lineCents !== null && summary.subtotalCents !== null) differences.push(Math.abs(lineCents + chargeCents - summary.subtotalCents))
  if (summary.subtotalCents !== null && summary.taxCents !== null && summary.totalCents !== null)
    differences.push(Math.abs(summary.subtotalCents + summary.taxCents - summary.totalCents))
  if (lineCents !== null && summary.totalCents !== null) {
    const lineTaxCents = extraction.lines.every((line) => line.taxRate !== null)
      ? Math.round(extraction.lines.reduce((sum, line) => sum + Math.round((line.lineTotal ?? 0) * 100) * (line.taxRate ?? 0) / 100, 0)) : null
    const netDifference = Math.abs(lineCents + chargeCents - summary.totalCents)
    if (summary.taxCents !== null) differences.push(Math.abs(lineCents + chargeCents + summary.taxCents - summary.totalCents))
    else differences.push(lineTaxCents === null ? netDifference
      : Math.min(netDifference, Math.abs(lineCents + chargeCents + lineTaxCents - summary.totalCents)))
  }
  const differenceCents = differences.length ? Math.max(...differences) : null
  const conflictingTax = summary.taxes.length === 1 && extraction.lines.some((line) => line.taxRate !== null && line.taxRate !== summary.taxes[0].rate)
  return { coherent: !summary.issues.length && !conflictingTax && lineCents !== null && differenceCents !== null && differenceCents <= 5,
    documentDifference: differenceCents === null ? null : differenceCents / 100 }
}
