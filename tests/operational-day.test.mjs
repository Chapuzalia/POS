import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  getOperationalDateKey,
  getOperationalMonthStartIso,
  normalizeDayChangeTime,
} from '../src/lib/operationalDay.ts'

const madridAtFour = {
  dayChangeTime: '04:00',
  timeZone: 'Europe/Madrid',
}

test('mantiene días naturales cuando no hay hora de cambio', () => {
  const config = { dayChangeTime: null, timeZone: 'Europe/Madrid' }
  assert.equal(getOperationalDateKey('2026-07-22T21:00:00Z', config), '2026-07-22')
  assert.equal(getOperationalDateKey('2026-07-22T22:30:00Z', config), '2026-07-23')
})

test('agrupa una apertura de 23:00 a 03:00 en el mismo día operativo', () => {
  assert.equal(getOperationalDateKey('2026-07-22T21:00:00Z', madridAtFour), '2026-07-22')
  assert.equal(getOperationalDateKey('2026-07-22T22:00:00Z', madridAtFour), '2026-07-22')
  assert.equal(getOperationalDateKey('2026-07-23T01:00:00Z', madridAtFour), '2026-07-22')
  assert.equal(getOperationalDateKey('2026-07-23T02:00:00Z', madridAtFour), '2026-07-23')
})

test('calcula el inicio mensual en la zona horaria y hora del local', () => {
  assert.equal(
    getOperationalMonthStartIso(madridAtFour, new Date('2026-07-01T01:00:00Z')),
    '2026-06-01T02:00:00.000Z',
  )
  assert.equal(
    getOperationalMonthStartIso(madridAtFour, new Date('2026-07-01T04:00:00Z')),
    '2026-07-01T02:00:00.000Z',
  )
})

test('normaliza el tipo time de Postgres y rechaza horas inválidas', () => {
  assert.equal(normalizeDayChangeTime('04:00:00'), '04:00')
  assert.equal(normalizeDayChangeTime(''), null)
  assert.throws(() => normalizeDayChangeTime('24:00'), /formato HH:mm/)
})

test('la migración añade la configuración nullable y los índices de consulta', async () => {
  const sql = await readFile(new URL('../supabase/46.operational-day-change-time-migration.sql', import.meta.url), 'utf8')
  assert.match(sql, /day_change_time time without time zone/)
  assert.doesNotMatch(sql, /day_change_time time without time zone not null/)
  assert.match(sql, /sales_venue_local_created_idx/)
  assert.match(sql, /tickets_venue_local_created_idx/)
})
