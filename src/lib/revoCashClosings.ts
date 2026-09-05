export type RevoClosingDay = {
  date: string
  cashCents: number
  cardCents: number
  cashTipCents: number
  cardTipCents: number
  rowCount: number
}

export type RevoClosingImport = {
  days: RevoClosingDay[]
  rowCount: number
  totalCents: number
  tipCents: number
}

export type ImportedCashClosing = RevoClosingDay & {
  id: string
  tenantId: string
  venueId: string
  source: 'revo'
  fileName: string
  importedAt: string
}

export const REVO_CLOSING_MAX_BYTES = 10 * 1024 * 1024
const maxCents = 2147483647
const dateFormatter = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeZone: 'UTC' })
export const formatRevoDate = (date: string) => dateFormatter.format(new Date(`${date}T12:00:00Z`))

// Strict semicolon CSV: quoted fields, escaped quotes, BOM and CRLF are supported.
function csvRows(text: string) {
  const rows: { cells: string[]; line: number }[] = []
  let cells: string[] = []
  let cell = ''
  let quoted = false
  let endedQuote = false
  let line = 1
  let rowLine = 1
  const finishCell = () => { cells.push(cell.trim()); cell = ''; endedQuote = false }
  const finishRow = () => {
    finishCell()
    if (cells.some(Boolean)) rows.push({ cells, line: rowLine })
    if (rows.length > 100001) throw new Error('El CSV supera las 100.000 filas de datos.')
    cells = []
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index += 1 }
        else { quoted = false; endedQuote = true }
      } else {
        cell += char
        if (char === '\n') line += 1
      }
    } else if (char === ';') finishCell()
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      finishRow(); line += 1; rowLine = line
    } else if (char === '"' && !cell.trim() && !endedQuote) { cell = ''; quoted = true }
    else if (char === '"' || (endedQuote && char.trim())) {
      throw new Error(`Línea ${line}: comillas CSV no válidas.`)
    } else cell += char
  }
  if (quoted) throw new Error(`Línea ${rowLine}: campo con comillas sin cerrar.`)
  finishRow()
  return rows
}

function euroCents(value: string, line: number, column: string) {
  // REVO uses a decimal comma. Also accept unambiguous decimal points.
  if (!/^-?(?:\d+|\d{1,3}(?:\.\d{3})+),\d{1,2}$/.test(value)
    && !/^-?\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new Error(`Línea ${line}: importe no válido en ${column}: «${value}».`)
  }
  const normalized = value.includes(',') ? value.replace(/\./g, '').replace(',', '.') : value
  const [integer, decimals = ''] = normalized.replace('-', '').split('.')
  const cents = (Number(integer) * 100 + Number(decimals.padEnd(2, '0'))) * (value.startsWith('-') ? -1 : 1)
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > maxCents) {
    throw new Error(`Línea ${line}: importe fuera de rango en ${column}.`)
  }
  return cents
}

export function parseRevoClosingsCsv(csv: string): RevoClosingImport {
  if (csv.length > REVO_CLOSING_MAX_BYTES) throw new Error('El CSV supera los 10 MB.')
  const rows = csvRows(csv.replace(/^\uFEFF/, ''))
  const header = rows.shift()?.cells ?? []
  const required = ['date', 'total', 'tipTotal', 'paymentMethodRelation.name']
  for (const column of required) {
    if (header.filter((value) => value === column).length !== 1) {
      throw new Error(`El CSV fiscal de REVO debe contener una única columna «${column}».`)
    }
  }
  if (!rows.length) throw new Error('El CSV no contiene cierres para importar.')
  const days = new Map<string, RevoClosingDay>()
  for (const { cells, line } of rows) {
    // The trailing empty column from REVO is optional, but data must not be lost.
    const fieldCount = header.at(-1) === '' ? header.length - 1 : header.length
    if (cells.length < fieldCount || cells.slice(fieldCount).some(Boolean)) {
      throw new Error(`Línea ${line}: el número de columnas no coincide con la cabecera.`)
    }
    const get = (column: string) => cells[header.indexOf(column)] ?? ''
    const date = get('date')
    const timestamp = Date.parse(`${date}T12:00:00Z`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < '1900-01-01' || date > '9999-12-31'
      || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
      throw new Error(`Línea ${line}: fecha no válida «${date}»; se espera AAAA-MM-DD.`)
    }
    const method = get('paymentMethodRelation.name').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    const cash = ['efectiu', 'efectivo', 'cash'].includes(method)
    if (!cash && !['targeta', 'tarjeta', 'card', 'credit card', 'tarjeta de credito', 'tarjeta de debito'].includes(method)) {
      throw new Error(`Línea ${line}: forma de pago no reconocida «${get('paymentMethodRelation.name')}». Se admiten efectivo y tarjeta.`)
    }
    const day = days.get(date) ?? { date, cashCents: 0, cardCents: 0, cashTipCents: 0, cardTipCents: 0, rowCount: 0 }
    day[cash ? 'cashCents' : 'cardCents'] += euroCents(get('total'), line, 'total')
    day[cash ? 'cashTipCents' : 'cardTipCents'] += euroCents(get('tipTotal'), line, 'tipTotal')
    day.rowCount += 1
    if ([day.cashCents, day.cardCents, day.cashTipCents, day.cardTipCents].some((amount) => Math.abs(amount) > maxCents)) {
      throw new Error(`Línea ${line}: el importe acumulado del día ${date} supera el límite permitido.`)
    }
    days.set(date, day)
  }
  if (days.size > 10000) throw new Error('El CSV supera los 10.000 días por importación.')
  const sortedDays = [...days.values()].sort((a, b) => a.date.localeCompare(b.date))
  return {
    days: sortedDays,
    rowCount: rows.length,
    totalCents: sortedDays.reduce((sum, day) => sum + day.cashCents + day.cardCents, 0),
    tipCents: sortedDays.reduce((sum, day) => sum + day.cashTipCents + day.cardTipCents, 0),
  }
}
