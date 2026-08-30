import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [page, list, detail, form, map, timeline] = await Promise.all([
  readFile(new URL('../src/features/reservations/components/ReservationsPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/reservations/components/ReservationList.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/reservations/components/ReservationDetailPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/reservations/components/ReservationFormModal.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/reservations/components/ReservationMapView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/reservations/components/ReservationTimelineView.tsx', import.meta.url), 'utf8'),
])

test('el mapa permite desplazar el lienzo desde el espacio entre mesas', () => {
  assert.match(map, /className="map-transform-layer absolute z-\[2\]"/)
  assert.match(map, /onPointerDown=\{viewportApi\.startBackgroundPointer\}/)
  assert.match(map, /onPointerMove=\{viewportApi\.moveBackgroundPointer\}/)
})

test('reservas ofrece una tercera vista temporal operativa', () => {
  assert.match(page, /aria-label="Vista de horario"/)
  assert.match(page, /controller\.view === ["']timeline["']/)
  assert.match(timeline, /aria-label="Horario de reservas"/)
  assert.match(timeline, /PIXELS_PER_MINUTE/)
  assert.match(timeline, /placeInLanes/)
  assert.match(timeline, /Reservas solapadas/)
  assert.match(timeline, /Hora actual/)
  assert.match(timeline, /sticky left-0/)
  assert.match(timeline, /zonedLocalToUtc/)
  assert.doesNotMatch(timeline, /matchMedia/)
  assert.match(timeline, /scrollWidth <= scroller\.clientWidth/)
  assert.match(timeline, /scrollTo\(\{\s*left:/)
  assert.match(timeline, /Desplazar horario de reservas/)
  assert.match(page, /min-w-0 w-full max-w-full flex-1 flex-col[\s\S]*overflow-x-hidden overflow-y-auto/)
  assert.match(page, /flex min-h-0 min-w-0 w-full max-w-full flex-none gap-3/)
  assert.match(timeline, /max-h-\[min\(68dvh,40rem\)\][\s\S]*flex-none overflow-hidden/)
  assert.match(timeline, /max-h-\[inherit\] w-full max-w-full touch-auto overflow-auto/)
  assert.doesNotMatch(timeline, /h-\[min\(68dvh,40rem\)\] min-h-110/)
})

test('la timeline se adapta al ancho disponible y conserva el scroll interno', () => {
  assert.match(timeline, /new ResizeObserver\(updateAvailableWidth\)/)
  assert.match(timeline, /scroller\.clientWidth - LABEL_WIDTH/)
  assert.match(timeline, /Math\.max\(schedule\.width, availableTrackWidth\)/)
  assert.match(timeline, /timelineWidth \/ \(schedule\.end - schedule\.start\)/)
  assert.match(timeline, /minWidth: LABEL_WIDTH \+ timelineWidth/)
  assert.match(timeline, /width: timelineWidth/)
  assert.match(timeline, /30 \* pixelsPerMinute/)
  assert.match(timeline, /tables\.map\(\(table, tableIndex\)/)
  assert.match(timeline, /tableIndex % 2 === 1/)
})

test('reservas convierte excepciones y zonas en filtros operativos', () => {
  assert.match(page, /type ReservationFilter = ["']all["'] \| ["']upcoming["'] \| ["']arrived["'] \| ["']late["'] \| ["']unassigned["']/)
  assert.match(page, /aria-label="Filtros de reservas"/)
  assert.match(page, /Filtrar por zona/)
  assert.match(page, /type="date"/)
})

test('la lista usa una tabla real, separa el historial y conserva la seleccion', () => {
  assert.match(list, /Historial del día/)
  assert.match(list, /aria-current=\{selected \? 'true'/)
  assert.match(list, /<DataTable aria-label="Reservas"/)
  assert.match(list, /<thead/)
  assert.match(list, /<tbody/)
  assert.match(list, /scope="col">Hora<\/th>/)
  assert.match(list, /scope="col">Cliente<\/th>/)
  assert.match(list, /scope="col">Mesa \/ zona<\/th>/)
  assert.match(list, /scope="col">Estado<\/th>/)
  assert.doesNotMatch(list, /role="listitem"/)
  assert.match(list, /<Button aria-label=\{`Abrir reserva de/)
  assert.doesNotMatch(list, /<tr[^>]*onClick=/)
})

test('la vista general movil usa los breakpoints predefinidos de Tailwind', () => {
  assert.match(page, /md:gap-3 md:p-4/)
  assert.match(page, /md:w-auto/)
  assert.match(page, /md:min-h-105 md:flex-1/)
  assert.match(list, /max-md:grid max-md:grid-cols-/)
  assert.match(list, /max-md:flex-none max-md:overflow-visible/)
  assert.match(list, /max-md:block max-md:space-y-2/)
  assert.match(page, /aria-label="Filtros de reservas"/)
  assert.match(page, /min-h-14 shrink-0/)
  assert.doesNotMatch(page, /(max|min)-\[\d+px\]/)
  assert.doesNotMatch(list, /(max|min)-\[\d+px\]/)
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
  assert.match(form, /placement="center"/)
  assert.match(form, /md:!items-center/)
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
  assert.match(form, /<DatePicker\.Trigger/)
  assert.match(form, /aria-label="Seleccionar fecha y hora"/)
  assert.match(form, /triggerRef=\{dateTimeTriggerRef\}/)
  assert.match(form, /placement="bottom start"/)
  assert.match(form, /offset=\{8\}/)
  assert.doesNotMatch(form, /date-time-backdrop|bg-black\/45|backdrop-blur/)
  assert.match(form, /shadow-\[0_28px_72px_rgba\(15,23,42,0\.42\),0_10px_28px_rgba\(15,23,42,0\.28\)\]/)
  assert.match(form, /h-\[min\(36rem,calc\(100dvh-1rem\)\)\]/)
  assert.match(form, /grid-rows-\[auto_minmax\(0,1fr\)\]/)
  assert.match(form, /sm:h-\[var\(--calendar-pane-height\)\]/)
  assert.match(form, /max-sm:!fixed/)
  assert.match(form, /max-sm:!bottom-2/)
  assert.match(form, /max-sm:!top-auto/)
  assert.match(form, /max-sm:!max-h-\[calc\(100dvh-1rem\)\]/)
  assert.doesNotMatch(form, /<DateField\.Input/)
  assert.match(form, /cursor-pointer/)
  assert.match(form, /activeMobileSection/)
  assert.match(form, /Resumen de reserva/)
  assert.match(form, /h-\[calc\(100dvh-3\.5rem\)\]/)
  assert.match(form, /rounded-t-2xl/)
  assert.match(form, /fixed inset-x-0 bottom-0/)
  assert.match(form, /bg-\[var\(--accent-soft\)\]/)
  assert.doesNotMatch(form, /min-h-\[390px\]|h-\[220px\]/)
  assert.doesNotMatch(form, /(max|min)-\[\d+px\]/)
  assert.match(form, /aria-label="Quitar una persona"/)
  assert.match(form, /aria-label="A.adir una persona"/)
  assert.doesNotMatch(form, /type="number"/)
  assert.match(form, /border border-\[var\(--field-border\)\]/)
})

test('la disponibilidad se recalcula al cambiar el intervalo antes de guardar', () => {
  assert.match(form, /checkAvailability/)
  assert.match(form, /Comprobando disponibilidad/)
  assert.match(form, /\[checkAvailability, reservationId, schedule\]/)
  assert.match(form, /isCheckingAvailability/)
})
