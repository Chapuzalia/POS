import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [page, list, detail, form, map] = await Promise.all([
  readFile(new URL('../src/features/reservations/components/ReservationsPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/reservations/components/ReservationList.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/reservations/components/ReservationDetailPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/reservations/components/ReservationFormModal.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/reservations/components/ReservationMapView.tsx', import.meta.url), 'utf8'),
])

test('el mapa permite desplazar el lienzo desde el espacio entre mesas', () => {
  assert.match(map, /className="map-transform-layer absolute z-\[2\]"/)
  assert.match(map, /onPointerDown=\{viewportApi\.startBackgroundPointer\}/)
  assert.match(map, /onPointerMove=\{viewportApi\.moveBackgroundPointer\}/)
})

test('reservas convierte excepciones y zonas en filtros operativos', () => {
  assert.match(page, /type ReservationFilter = 'all' \| 'upcoming' \| 'arrived' \| 'late' \| 'unassigned'/)
  assert.match(page, /aria-label="Filtros de reservas"/)
  assert.match(page, /Filtrar por zona/)
  assert.match(page, /type="date"/)
})

test('la lista usa una tabla real, separa el historial y conserva la seleccion', () => {
  assert.match(list, /Historial del día/)
  assert.match(list, /aria-current=\{selected \? 'true'/)
  assert.match(list, /<table/)
  assert.match(list, /<thead/)
  assert.match(list, /<tbody/)
  assert.match(list, /scope="col">Hora<\/th>/)
  assert.match(list, /scope="col">Cliente<\/th>/)
  assert.match(list, /scope="col">Mesa \/ zona<\/th>/)
  assert.match(list, /scope="col">Estado<\/th>/)
  assert.doesNotMatch(list, /role="listitem"/)
  assert.doesNotMatch(list, /<UiButton/)
})

test('la vista general movil prioriza controles compactos y filas sin altura sobrante', () => {
  assert.match(page, /max-\[760px\]:rounded-none max-\[760px\]:border-x-0/)
  assert.match(page, /max-\[760px\]:w-full max-\[760px\]:basis-full/)
  assert.match(page, /max-\[760px\]:min-h-0 max-\[760px\]:flex-none/)
  assert.match(list, /max-\[760px\]:grid max-\[760px\]:grid-cols-/)
  assert.match(list, /max-\[760px\]:flex-none max-\[760px\]:overflow-visible/)
  assert.match(list, /max-\[760px\]:space-y-2/)
})

test('el detalle anticipa la asignacion de mesa antes de sentar', () => {
  assert.match(detail, /const needsTable = actions\.seat && reservation\.tableIds\.length === 0/)
  assert.match(detail, /needsTable \? props\.onEdit : props\.onSeat/)
  assert.match(detail, /Asignar mesa/)
})

test('el formulario previene descarte, pasado, capacidad y override accidental', () => {
  assert.match(form, /setDiscardConfirmation\(true\)/)
  assert.match(form, /Reserva en el pasado/)
  assert.match(form, /capacityInsufficient/)
  assert.match(form, /conflictAcknowledged/)
  assert.match(form, /Entiendo que se solapará con otra reserva/)
  assert.match(form, /FieldError/)
})

test('el formulario usa controles tactiles y una fecha-hora unificada', () => {
  assert.match(form, /placement="bottom"/)
  assert.match(form, /min-\[761px\]:!items-center/)
  assert.match(form, /<DatePicker/)
  assert.match(form, /granularity="minute"/)
  assert.match(form, /shouldCloseOnSelect=\{false\}/)
  assert.match(form, /Fecha y hora \*/)
  assert.match(form, /aria-label="Seleccionar hora de la reserva"/)
  assert.match(form, /label="Horas"/)
  assert.match(form, /label="Minutos"/)
  assert.match(form, /function InfiniteTimeColumn/)
  assert.match(form, /cycleHeight/)
  assert.match(form, /ResizeObserver/)
  assert.match(form, /--calendar-pane-height/)
  assert.match(form, /setDateTimeOpen\(true\)/)
  assert.match(form, /cursor-pointer/)
  assert.match(form, /activeMobileSection/)
  assert.match(form, /Resumen de reserva/)
  assert.match(form, /h-\[calc\(100dvh-56px\)\]/)
  assert.match(form, /rounded-t-\[20px\]/)
  assert.match(form, /max-\[760px\]:fixed/)
  assert.match(form, /bg-\[var\(--accent-soft\)\]/)
  assert.doesNotMatch(form, /min-h-\[390px\]|h-\[220px\]/)
  assert.match(form, /aria-label="Quitar una persona"/)
  assert.match(form, /aria-label="A.adir una persona"/)
  assert.doesNotMatch(form, /type="number"/)
  assert.match(form, /border border-\[var\(--field-border\)\]/)
})
