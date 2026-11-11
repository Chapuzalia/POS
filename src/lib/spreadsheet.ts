import { strToU8, zipSync } from 'fflate'
import { buildCsv } from './csv'

export type SpreadsheetFormat = 'xls' | 'xlsx' | 'csv'

export const spreadsheetFormatOptions: { format: SpreadsheetFormat; label: string }[] = [
  { format: 'xls', label: 'Exportar en XLS' },
  { format: 'xlsx', label: 'Exportar en XLSX' },
  { format: 'csv', label: 'Exportar en CSV' },
]

// Plain decimals without leading zeros become numeric cells; padded codes ("000123") stay text.
const NUMERIC_TEXT = /^-?(0|[1-9]\d*)(\.\d+)?$/

function isNumericCell(value: unknown): value is number | string {
  return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && NUMERIC_TEXT.test(value))
}

function escapeXml(value: unknown) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex -- XML 1.0 forbids these control characters.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function columnName(index: number) {
  let name = ''
  for (let current = index + 1; current > 0; current = Math.floor((current - 1) / 26)) name = String.fromCharCode(65 + ((current - 1) % 26)) + name
  return name
}

export function buildXlsx(headers: string[], rows: readonly unknown[][]) {
  const sheetRows = [headers, ...rows].map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => {
    const ref = `${columnName(columnIndex)}${rowIndex + 1}`
    if (rowIndex > 0 && isNumericCell(value)) return `<c r="${ref}"><v>${value}</v></c>`
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
  }).join('')}</row>`).join('')
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="Datos" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${main}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${main}"><sheetData>${sheetRows}</sheetData></worksheet>`),
  })
}

// shortcut: legacy XLS as Excel 2003 XML Spreadsheet (Excel may warn about the extension); write BIFF8 if a consumer rejects it.
export function buildXls(headers: string[], rows: readonly unknown[][]) {
  const sheetRows = [headers, ...rows].map((row, rowIndex) => `<Row>${row.map((value) => rowIndex > 0 && isNumericCell(value)
    ? `<Cell><Data ss:Type="Number">${value}</Data></Cell>`
    : `<Cell><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`).join('')}</Row>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Datos"><Table>${sheetRows}</Table></Worksheet></Workbook>`
}

export function downloadSpreadsheet(format: SpreadsheetFormat, headers: string[], rows: readonly unknown[][], baseName: string) {
  const blob = format === 'xlsx'
    ? new Blob([buildXlsx(headers, rows) as Uint8Array<ArrayBuffer>], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    : format === 'xls'
      ? new Blob([buildXls(headers, rows)], { type: 'application/vnd.ms-excel' })
      : new Blob([buildCsv(headers, rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${baseName}.${format}`
  anchor.click()
  URL.revokeObjectURL(url)
}
