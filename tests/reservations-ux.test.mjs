import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [page, list, detail, form, map, timeline, selectionStep, optionalPhoneMigration] = await Promise.all([
  readFile(new URL('../src/features/reservations/components/ReservationsPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/reservations/components/ReservationList.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/reservations/components/ReservationDetailPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/reservations/components/ReservationFormModal.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/reservations/components/ReservationMapView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/reservations/components/ReservationTimelineView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/reservations/components/ReservationSelectionStep.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20260830210000_make_reservation_phone_optional.sql', import.meta.url), 'utf8'),
])

test('el mapa permite desplazar el lienzo desde el espacio entre mesas', () => {
  assert.match(map, /onPointerDown=\{props\.selection \? undefined : viewportApi\.startBackgroundPointer\}/)
  assert.match(map, /onPointerMove=\{props\.selection \? undefined : viewportApi\.moveBackgroundPointer\}/)
})

test('reservas ofrece una tercera vista temporal operativa', () => {
  assert.match(page, /aria-label="Vista de horario"/)
  assert.match(page, /controller\.view === ["']timeline["']/)
  assert.match(timeline, /aria-label="Horario de reservas"/)
  assert.match(timeline, /PIXELS_PER_MINUTE/)
  assert.match(timeline, /placeInLanes/)
  assert.match(timeline, /zonedLocalToUtc/)
  assert.doesNotMatch(timeline, /matchMedia/)
  assert.match(timeline, /scrollWidth <= scroller\.clientWidth/)
  assert.match(timeline, /scrollTo\(\{\s*left:/)
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
  assert.match(page, /type="date"/)
})

test('la lista usa una tabla real, separa el historial y conserva la seleccion', () => {
  assert.match(list, /aria-current=\{selected \? 'true'/)
  assert.match(list, /<DataTable aria-label="Reservas"/)
  assert.match(list, /<thead/)
  assert.match(list, /<tbody/)
  assert.match(list, /scope="col">Hora<\/th>/)
  assert.match(list, /scope="col">Cliente<\/th>/)
  assert.match(list, /scope="col">Mesa \/ zona<\/th>/)
  assert.match(list, /scope="col">Estado<\/th>/)
  assert.doesNotMatch(list, /role="listitem"/)
  assert.match(list, /aria-label=\{`Abrir reserva de/)
  assert.match(list, /onClick=\{\(\) => onSelect\(reservation\)\}/)
  assert.doesNotMatch(list, /<Button[^>]*aria-label=\{`Abrir reserva de/)
})

test('el detalle anticipa la asignacion de mesa antes de sentar', () => {
  assert.match(detail, /const needsTable = actions\.seat && reservation\.tableIds\.length === 0/)
  assert.match(detail, /needsTable \? props\.onEdit : props\.onSeat/)
})

test('el formulario previene descarte, pasado, capacidad y override accidental', () => {
  assert.match(form, /setDiscardConfirmation\(true\)/)
  assert.match(form, /Reserva en el pasado/)
  assert.match(form, /capacityInsufficient/)
  assert.match(form, /conflictAcknowledged/)
  assert.match(form, /FieldError/)
})

test('el formulario usa controles tactiles y una fecha-hora unificada', () => {
  assert.match(form, /<DatePicker/)
  assert.match(form, /granularity="minute"/)
  assert.match(form, /shouldCloseOnSelect=\{false\}/)
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
  assert.doesNotMatch(form, /<DateField\.Input/)
  assert.match(form, /activeMobileSection/)
  assert.match(form, /aria-label="Quitar una persona"/)
  assert.match(form, /aria-label="A.adir una persona"/)
  assert.doesNotMatch(form, /type="number"/)
})

test('la disponibilidad se recalcula al cambiar el intervalo antes de guardar', () => {
  assert.match(form, /checkAvailability/)
  assert.match(form, /\[checkAvailability, reservationId, schedule\]/)
  assert.match(form, /isCheckingAvailability/)
})

test('el alta de reserva se divide en datos y selección visual', () => {
  assert.match(form, /const isCreateFlow = !props\.reservation/)
  assert.match(form, /useState<1 \| 2>\(1\)/)
  assert.match(form, /<ReservationSelectionStep/)
  assert.match(selectionStep, /<ReservationMapView/)
  assert.match(selectionStep, /<ReservationTimelineView/)
})

test('el plano y el timeline permiten elegir mesa y hueco en el segundo paso', () => {
  assert.match(map, /selection\?:/)
  assert.match(map, /props\.selection\.onChange\(next\)/)
  assert.match(map, /const autoFit = Boolean\(props\.selection\)/)
  assert.match(map, /const fittedItems = useMemo\(\(\) => \[\.\.\.tables, \.\.\.mapElements\]/)
  assert.match(map, /new ResizeObserver/)
  assert.match(map, /requestAnimationFrame\(fitSelectionToCanvas\)/)
  assert.match(map, /onWheel=\{props\.selection \? undefined : viewportApi\.onWheel\}/)
  assert.match(map, /\{!props\.selection \? <MapViewportControls/)
  assert.match(map, /\{mapElements\.map\(\(element\) => <div/)
  assert.match(map, /element\.kind === 'wall'/)
  assert.match(map, /element\.kind === 'column'/)
  assert.match(map, /element\.kind === 'text' \? <span>\{element\.text\}<\/span>/)
  assert.match(timeline, /draft\?:/)
  assert.match(selectionStep, /onSlotSelect/)
  assert.match(selectionStep, /allowUnassignedCreate=\{false\}/)
})

test('el segundo paso permite quitar mesas y muestra la capacidad seleccionada', () => {
  assert.match(map, /aria-label=\{`Quitar \$\{table\.name\}`\}/)
  assert.match(map, /props\.selection\.selectedCapacity/)
})

test('el teléfono de la reserva es opcional en interfaz y base de datos', () => {
  assert.doesNotMatch(form, /next\.customerPhone/)
  assert.match(optionalPhoneMigration, /drop constraint if exists reservations_customer_phone_check/)
  assert.doesNotMatch(optionalPhoneMigration, /btrim\(coalesce\(p_customer_phone, ''\)\) = ''/)
  assert.match(optionalPhoneMigration, /customer_phone = btrim\(coalesce\(p_customer_phone, ''\)\)/)
})
