import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRevoClosingsCsv } from '../src/lib/revoCashClosings.ts'
import { buildCashClosingDailyValues, filterCashClosingsByDate } from '../src/features/crm/sales/services/cashClosingReportModel.ts'

const header = 'date;total;tipTotal;paymentMethodRelation.name;'
const parse = (...rows) => parseRevoClosingsCsv([header, ...rows].join('\r\n'))

test('agrupa todas las filas del mismo día, incluidos pagos repetidos de REVO, en céntimos exactos', () => {
  const actual = parse(
    '2026-07-23;309,50;1,20;Targeta;',
    '2026-07-23;288,50;0,10;Efectiu;',
    '2026-07-23;30,00;0,00;Targeta;',
    '2025-04-11;0,10;0,00;Efectiu;',
    '2025-04-11;0,20;0,00;Efectiu;',
  )
  assert.deepEqual(actual, {
    days: [
      { date: '2025-04-11', cashCents: 30, cardCents: 0, cashTipCents: 0, cardTipCents: 0, rowCount: 2 },
      { date: '2026-07-23', cashCents: 28850, cardCents: 33950, cashTipCents: 10, cardTipCents: 120, rowCount: 3 },
    ], rowCount: 5, totalCents: 62830, tipCents: 130,
  })
})

test('admite BOM, CRLF, comillas, espacios, separadores de miles y devoluciones sin sumar propinas al total', () => {
  const result = parseRevoClosingsCsv(`\uFEFF${header}\r\n\r\n"2026-01-01";"1.234,56";"2,00";" TARJETA ";\r\n2026-01-01;-12.50;-0.50;cash\r\n`)
  assert.equal(result.totalCents, 122206)
  assert.equal(result.tipCents, 150)
  assert.equal(result.days[0].rowCount, 2)
})

test('rechaza el archivo completo ante fechas, importes, formas de pago o CSV inválidos e identifica la línea', () => {
  for (const value of ['2026-02-29', '2026-13-01', '2026-7-01', '1899-01-01', '2026-01-01T00:00:00Z']) {
    assert.throws(() => parse(`${value};1,00;0,00;Efectiu;`), /Línea 2: fecha no válida/)
  }
  for (const value of ['', '1e3', 'NaN', '12x', '1,001', '1.000', '1.2.3,00', '21474836,48']) {
    assert.throws(() => parse(`2026-01-01;${value};0,00;Efectiu;`), /Línea 2: importe/)
  }
  assert.throws(() => parse('2026-01-01;1,00;0,00;Bizum;'), /Línea 2: forma de pago no reconocida/)
  assert.throws(() => parse('2026-01-01;1,00;;Efectiu;'), /tipTotal/)
  assert.throws(() => parse('2026-01-01;1,00;0,00;Efectiu;dato extra'), /número de columnas/)
  assert.throws(() => parse('2026-01-01;1,00;0,00;"Efectiu;'), /comillas sin cerrar/)
  assert.throws(() => parse('2026-01-01;1,00;0,00;"Efectiu"x;'), /comillas CSV/)
  assert.throws(() => parse('2026-01-01;21474836,47;0,00;Efectiu;', '2026-01-01;0,01;0,00;Efectiu;'), /acumulado/)
})

test('valida la cabecera fiscal, acepta columnas adicionales y evita importar un CSV de catálogo', () => {
  assert.throws(() => parseRevoClosingsCsv('id;name;price\n1;cafe;2'), /columna «date»/)
  assert.throws(() => parseRevoClosingsCsv(`${header}date\n2026-01-01;1;0;cash;;2026-01-01`), /única columna/)
  assert.throws(() => parseRevoClosingsCsv(header), /no contiene cierres/)
  assert.equal(parseRevoClosingsCsv('total;date;tipTotal;paymentMethodRelation.name;notes\n1,00;2026-01-01;0,00;Efectiu;"a; b"').totalCents, 100)
  assert.equal(parse('2024-02-29;0,00;0,00;Targeta;').days.length, 1)
})

test('combina cierres POS y REVO sin desplazar la fecha fiscal por zona horaria o cambio de día', () => {
  const imported = { ...parse('2026-07-23;10,00;1,00;Efectiu;').days[0], source: 'revo', id: 'revo' }
  const native = { id: 'pos', closedAt: '2026-07-24T01:00:00Z', printSnapshot: { timezone: 'Europe/Madrid', summary: { totalSalesCents: 2500 } } }
  const config = { timeZone: 'Pacific/Honolulu', dayChangeTime: '04:00' }
  assert.deepEqual(buildCashClosingDailyValues([native, imported], config), [{ date: '2026-07-23', closingCount: 2, totalCents: 3500 }])
  assert.equal(filterCashClosingsByDate([native, imported], '2026-07-23', '2026-07-23', config).length, 2)
  assert.equal(filterCashClosingsByDate([imported], '2026-07-24', '', config).length, 0)
})
