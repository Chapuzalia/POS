import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { snapTableAlignment, snapTableCenter } from '../src/features/tables/alignment.ts'
import { getAreaSwipeEntryOffset, getAreaSwipeTarget, getAreaSwipeVisualFeedback } from '../src/features/tables/area-swipe.ts'
import { externalLabelSize, placeExternalLabels, rectsOverlap, tableContentMode, tableVisualRect } from '../src/features/tables/external-label-layout.ts'
import { compactJoinedCompositions, compositionHasOpenOrder, findJoinProposal, isCompactComposition, separateFromComposition, translateComposition } from '../src/features/tables/joined-layout.ts'
import { fitBounds, fitBoundsToViewport, getMapPlaneSize, intersectionRatio, mapToScreen, orientMapRect, positionFloatingPanel, screenToMap, shouldRotateMapToFit, zoomAtPoint } from '../src/features/tables/viewport.ts'
import { getRestaurantTableVisualStatus } from '../src/features/tables/table-visual-status.ts'
import { getReadableError } from '../src/utils/errors.ts'

const tableMapViewSource = await readFile(new URL('../src/features/tables/components/TableMapView.tsx', import.meta.url), 'utf8')
const mobileChromeSource = await readFile(new URL('../src/features/tables/components/MobileTableMapChrome.tsx', import.meta.url), 'utf8')
const mobileSheetsSource = await readFile(new URL('../src/features/tables/components/MobileTableMapSheets.tsx', import.meta.url), 'utf8')
const mobileLayoutSource = await readFile(new URL('../src/features/tables/useMobileTableMapLayout.ts', import.meta.url), 'utf8')
const tableManagementSource = await readFile(new URL('../src/features/table-management/TableManagementPage.tsx', import.meta.url), 'utf8')
const reservationBadgeSource = await readFile(new URL('../src/features/reservations/components/ReservationTableBadge.tsx', import.meta.url), 'utf8')
const tableServiceSource = await readFile(new URL('../src/features/tables/service.ts', import.meta.url), 'utf8')

test('el editor permite eliminar definitivamente mesas y zonas sin borrar su historico', () => {
  assert.match(tableManagementSource, /deleteRestaurantTable\(context, selectedTable\.id\)/)
  assert.match(tableManagementSource, /deleteDiningArea\(context, selectedArea\.id\)/)
  assert.match(tableManagementSource, /¿Eliminar definitivamente la mesa/)
  assert.match(tableManagementSource, /¿Eliminar definitivamente la zona/)
  assert.match(tableManagementSource, /areaTables\.length/)
  assert.match(tableServiceSource, /rpc\('delete_restaurant_table'/)
  assert.match(tableServiceSource, /from\('dining_areas'\)\.delete\(\)/)
  assert.match(tableServiceSource, /TABLE_HAS_OPEN_ORDER/)
  assert.match(tableServiceSource, /TABLE_HAS_ACTIVE_RESERVATION/)
})

const bounds = { left: 100, top: 50, width: 1000, height: 600 }

test('el plano conserva su proporcion en viewports panoramicos y moviles', () => {
  assert.deepEqual(getMapPlaneSize(1200, 600, 1200, 800), { width: 900, height: 600 })
  assert.deepEqual(getMapPlaneSize(320, 500, 1200, 800), { width: 320, height: 320 / 1.5 })
})

test('screenToMap y mapToScreen conservan coordenadas al 50, 100 y 200 por ciento con pan', () => {
  for (const zoom of [.5, 1, 2]) {
    const viewport = { zoom, panX: -73, panY: 41 }
    const point = { x: 37.25, y: 68.5 }
    const result = screenToMap(mapToScreen(point, bounds, viewport), bounds, viewport)
    assert.ok(Math.abs(result.x - point.x) < 1e-9)
    assert.ok(Math.abs(result.y - point.y) < 1e-9)
  }
})

test('zoomAtPoint mantiene inmovil el punto bajo el cursor', () => {
  const before = { zoom: 1, panX: -20, panY: 30 }, anchor = { x: 640, y: 340 }
  const mapPoint = screenToMap(anchor, bounds, before)
  const after = zoomAtPoint(before, 1.8, anchor, bounds)
  const projected = mapToScreen(mapPoint, bounds, after)
  assert.ok(Math.abs(projected.x - anchor.x) < 1e-9)
  assert.ok(Math.abs(projected.y - anchor.y) < 1e-9)
})

test('fitBounds centra contenido y respeta los limites de zoom', () => {
  const fitted = fitBounds({ minX: -5, minY: 10, maxX: 95, maxY: 85 }, 1000, 600, 30)
  assert.ok(fitted.zoom >= .5 && fitted.zoom <= 2)
  const tiny = fitBounds({ minX: 49, minY: 49, maxX: 51, maxY: 51 }, 1000, 600, 30)
  assert.equal(tiny.zoom, 2)
})

test('el mapa fijo adopta la orientacion del espacio util', () => {
  const mobileInsets = { top: 124, right: 12, bottom: 12, left: 12 }
  assert.equal(shouldRotateMapToFit(800, 390, 1200, 800, mobileInsets), false)
  assert.equal(shouldRotateMapToFit(390, 800, 1200, 800, mobileInsets), true)
  assert.equal(shouldRotateMapToFit(390, 800, 800, 1200, mobileInsets), false)
})

test('el gesto horizontal cambia de sala en ambos sentidos y de forma circular', () => {
  const areas = ['interior', 'terraza', 'barra']
  assert.equal(getAreaSwipeTarget(areas, 'interior', -90, 8, 390), 'terraza')
  assert.equal(getAreaSwipeTarget(areas, 'terraza', 90, 8, 390), 'interior')
  assert.equal(getAreaSwipeTarget(areas, 'interior', 90, 8, 390), 'barra')
  assert.equal(getAreaSwipeTarget(areas, 'barra', -90, 8, 390), 'interior')
})

test('el gesto ignora movimientos cortos, verticales o mapas con una sola sala', () => {
  assert.equal(getAreaSwipeTarget(['a', 'b'], 'a', 30, 2, 390), null)
  assert.equal(getAreaSwipeTarget(['a', 'b'], 'a', 70, 90, 390), null)
  assert.equal(getAreaSwipeTarget(['a'], 'a', -100, 0, 390), null)
})

test('el gesto da feedback visual limitado y prepara la entrada de la nueva sala', () => {
  assert.deepEqual(getAreaSwipeVisualFeedback(-40, 5, 400), { offsetX: -40, opacity: 1 - (40 / 88) * 0.12 })
  assert.deepEqual(getAreaSwipeVisualFeedback(120, 5, 400), { offsetX: 88, opacity: 0.88 })
  assert.deepEqual(getAreaSwipeVisualFeedback(20, 40, 400), { offsetX: 0, opacity: 1 })
  assert.equal(getAreaSwipeEntryOffset(-80, 400), 48)
  assert.equal(getAreaSwipeEntryOffset(80, 400), -48)
})

test('el encaje fijo mantiene todo el contenido fuera de los controles', () => {
  const insets = { top: 124, right: 12, bottom: 12, left: 12 }
  const viewport = fitBoundsToViewport(
    { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    390,
    800,
    390,
    585,
    insets,
    16,
  )
  const left = viewport.panX
  const top = viewport.panY
  const right = left + 390 * viewport.zoom
  const bottom = top + 585 * viewport.zoom
  assert.ok(left >= insets.left + 16 - 1e-9)
  assert.ok(top >= insets.top + 16 - 1e-9)
  assert.ok(right <= 390 - insets.right - 16 + 1e-9)
  assert.ok(bottom <= 800 - insets.bottom - 16 + 1e-9)
})

test('el menu contextual se abre junto al punto pulsado y se recoloca en los bordes', () => {
  const panel = { width: 230, height: 146 }, canvas = { width: 800, height: 560 }
  assert.deepEqual(positionFloatingPanel({ x: 300, y: 200 }, canvas, panel), { x: 310, y: 210 })
  assert.deepEqual(positionFloatingPanel({ x: 790, y: 550 }, canvas, panel), { x: 550, y: 394 })
  assert.deepEqual(positionFloatingPanel({ x: 2, y: 2 }, canvas, panel), { x: 12, y: 12 })
})

test('snap alinea centros reales de mesas de tamanos distintos en ambos ejes', () => {
  const moving = { id: 'a', positionX: 20.4, positionY: 30.3, width: 10, height: 20 }
  const other = { id: 'b', positionX: 15, positionY: 35, width: 20, height: 10 }
  const snapped = snapTableCenter(moving, [other], .7)
  assert.equal(snapped.positionX + moving.width / 2, other.positionX + other.width / 2)
  assert.equal(snapped.positionY + moving.height / 2, other.positionY + other.height / 2)
  assert.equal(snapped.guidelineX, 25)
  assert.equal(snapped.guidelineY, 40)
})

test('guidelines desaparecen al salir de la tolerancia', () => {
  const moving = { id: 'a', positionX: 30, positionY: 30, width: 10, height: 10 }
  const other = { id: 'b', positionX: 10, positionY: 10, width: 10, height: 10 }
  const snapped = snapTableCenter(moving, [other], .7)
  assert.equal(snapped.guidelineX, null)
  assert.equal(snapped.guidelineY, null)
})

test('snap alinea los bordes izquierdo y derecho de mesas con distinto ancho', () => {
  const target = { id: 'target', positionX: 20, positionY: 60, width: 20, height: 12 }
  const left = snapTableAlignment({ id: 'left', positionX: 20.4, positionY: 10, width: 9, height: 8 }, [target], .7)
  assert.equal(left.positionX, 20)
  assert.equal(left.guidelineX, 20)
  const right = snapTableAlignment({ id: 'right', positionX: 30.4, positionY: 10, width: 10, height: 8 }, [target], .7)
  assert.ok(Math.abs(right.positionX - 30) < 1e-9)
  assert.equal(right.guidelineX, 40)
})

test('snap alinea los bordes superior e inferior de mesas con distinta altura', () => {
  const target = { id: 'target', positionX: 70, positionY: 15, width: 12, height: 20 }
  const top = snapTableAlignment({ id: 'top', positionX: 10, positionY: 15.5, width: 8, height: 9 }, [target], .7)
  assert.equal(top.positionY, 15)
  assert.equal(top.guidelineY, 15)
  const bottom = snapTableAlignment({ id: 'bottom', positionX: 10, positionY: 25.4, width: 8, height: 10 }, [target], .7)
  assert.equal(bottom.positionY, 25)
  assert.equal(bottom.guidelineY, 35)
})

test('la zona de union exige una interseccion sustancial', () => {
  const target = { positionX: 20, positionY: 20, width: 10, height: 10 }
  assert.ok(intersectionRatio({ positionX: 21, positionY: 21, width: 10, height: 10 }, target) > .45)
  assert.ok(intersectionRatio({ positionX: 29, positionY: 29, width: 10, height: 10 }, target) < .45)
})

const table = (id, positionX, positionY, width = 10, height = 10, layoutGroupId = null) => ({ id, positionX, positionY, width, height, layoutGroupId })

test('propone union a izquierda, derecha, arriba y abajo con mesas de distinto tamano', () => {
  const target = table('target', 40, 40, 14, 10)
  const cases = [
    [table('source', 35, 42, 8, 6), 'left'],
    [table('source', 52, 42, 8, 6), 'right'],
    [table('source', 43, 35, 8, 6), 'top'],
    [table('source', 43, 48, 8, 6), 'bottom'],
  ]
  for (const [source, expectedSide] of cases) {
    const proposal = findJoinProposal([source, target], source.id, new Set([source.id]))
    assert.equal(proposal?.side, expectedSide)
    assert.ok(proposal)
    assert.equal(isCompactComposition(proposal.tables), true)
  }
})

test('mover cualquier miembro traslada la composicion completa y conserva offsets', () => {
  const tables = [table('a', 20, 20, 10, 10, 'joined'), table('b', 30.12, 20, 12, 10, 'joined'), table('free', 70, 70)]
  const moved = translateComposition(tables, new Set(['a', 'b']), 9, 7)
  assert.deepEqual(moved.slice(0, 2).map((item) => item.positionY), [27, 27])
  assert.ok(Math.abs(moved[0].positionX - 29) < 1e-9)
  assert.ok(Math.abs(moved[1].positionX - 39.12) < 1e-9)
  assert.ok(Math.abs((moved[1].positionX - moved[0].positionX) - (tables[1].positionX - tables[0].positionX)) < 1e-9)
  assert.deepEqual(moved[2], tables[2])
})

test('una tercera mesa se acopla a una composicion sin colisiones', () => {
  const joined = [table('a', 20, 20, 10, 10, 'joined'), table('b', 30.12, 20, 10, 10, 'joined')]
  const source = table('c', 38, 21, 8, 8)
  const proposal = findJoinProposal([...joined, source], 'c', new Set(['c']))
  assert.ok(proposal)
  assert.equal(proposal.targetId, 'b')
  assert.equal(isCompactComposition(proposal.tables), true)
})

test('la union lateral puede alinear bordes para formar una L', () => {
  const horizontal = table('horizontal', 40, 40, 20, 8)
  const verticalNearTop = table('vertical-top', 58, 40.4, 8, 20)
  const topProposal = findJoinProposal([horizontal, verticalNearTop], verticalNearTop.id, new Set([verticalNearTop.id]))
  assert.equal(topProposal?.side, 'right')
  assert.ok(Math.abs(topProposal.tables.find((item) => item.id === verticalNearTop.id).positionY - horizontal.positionY) < 1e-9)

  const verticalNearBottom = table('vertical-bottom', 58, 28.3, 8, 20)
  const bottomProposal = findJoinProposal([horizontal, verticalNearBottom], verticalNearBottom.id, new Set([verticalNearBottom.id]))
  assert.equal(bottomProposal?.side, 'right')
  assert.ok(Math.abs(
    bottomProposal.tables.find((item) => item.id === verticalNearBottom.id).positionY + verticalNearBottom.height
      - (horizontal.positionY + horizontal.height),
  ) < 1e-9)
})

test('la union superior e inferior tambien puede alinear izquierda y derecha', () => {
  const target = table('target', 40, 40, 20, 10)
  const belowLeft = table('below-left', 40.4, 48, 8, 8)
  const leftProposal = findJoinProposal([target, belowLeft], belowLeft.id, new Set([belowLeft.id]))
  assert.equal(leftProposal?.side, 'bottom')
  assert.ok(Math.abs(leftProposal.tables.find((item) => item.id === belowLeft.id).positionX - target.positionX) < 1e-9)

  const belowRight = table('below-right', 51.7, 48, 8, 8)
  const rightProposal = findJoinProposal([target, belowRight], belowRight.id, new Set([belowRight.id]))
  assert.equal(rightProposal?.side, 'bottom')
  assert.ok(Math.abs(
    rightProposal.tables.find((item) => item.id === belowRight.id).positionX + belowRight.width
      - (target.positionX + target.width),
  ) < 1e-9)
})

test('una interseccion minima accidental no genera propuesta de union', () => {
  const source = table('source', 49.7, 49.7, 10, 10)
  const target = table('target', 40, 40, 10, 10)
  assert.equal(findJoinProposal([source, target], source.id, new Set([source.id])), null)
})

test('repara composiciones antiguas separadas y permite separar una mesa o todas', () => {
  const legacy = [table('a', 10, 10, 10, 10, 'joined'), table('b', 70, 70, 12, 8, 'joined'), table('c', 30, 50, 9, 11, 'joined')]
  const compact = compactJoinedCompositions(legacy)
  assert.equal(isCompactComposition(compact), true)
  const one = separateFromComposition(compact, 'c', false)
  assert.equal(one.find((item) => item.id === 'c').layoutGroupId, null)
  assert.equal(one.filter((item) => item.layoutGroupId === 'joined').length, 2)
  const all = separateFromComposition(compact, 'a', true)
  assert.equal(all.every((item) => item.layoutGroupId === null), true)
})

test('al separar una composicion de dos mesas se elimina el grupo', () => {
  const joined = [table('a', 20, 20, 10, 10, 'joined'), table('b', 30.12, 20, 10, 10, 'joined')]
  const result = separateFromComposition(joined, 'a', false)
  assert.equal(result.every((item) => item.layoutGroupId === null), true)
})

test('una composicion con comanda abierta queda bloqueada hasta cerrar la orden', () => {
  const opened = [
    { ...table('a', 20, 20, 10, 10, 'joined'), orderId: 'order-1' },
    { ...table('b', 30.12, 20, 10, 10, 'joined'), orderId: 'order-1' },
  ]
  assert.equal(compositionHasOpenOrder(opened[0], opened), true)
  const closed = opened.map((item) => ({ ...item, orderId: null }))
  assert.equal(compositionHasOpenOrder(closed[0], closed), false)
  assert.equal(compositionHasOpenOrder({ ...closed[0], layoutGroupId: null }, closed), false)
})

const visualTable = (id, x, y, width = 40, height = 40) => ({ id, rect: { x, y, width, height } })
const labelInput = (id, tableRect, width = 100, height = 48) => ({ id, table: tableRect, label: { width, height } })
const labelCanvas = { width: 800, height: 560 }

test('el contenido pasa de etiqueta externa a compacto y completo segun el espacio visual', () => {
  assert.equal(tableContentMode({ x: 0, y: 0, width: 30, height: 160 }, 'Mesa 1'), 'external')
  assert.equal(tableContentMode({ x: 0, y: 0, width: 62, height: 160 }, 'Mesa 1'), 'compact')
  assert.equal(tableContentMode({ x: 0, y: 0, width: 120, height: 90 }, 'Mesa 1'), 'full')
})

test('las medidas visuales conservan pan y zoom sin escalar las etiquetas', () => {
  const rect = tableVisualRect({ positionX: 25, positionY: 20, width: 10, height: 30 }, { width: 800, height: 500 }, { zoom: 2, panX: -40, panY: 15 })
  assert.deepEqual(rect, { x: 360, y: 215, width: 160, height: 300 })
})

test('coloca la etiqueta a la derecha cuando hay espacio y la conecta al borde', () => {
  const source = visualTable('a', 300, 200)
  const [label] = placeExternalLabels([labelInput('a', source.rect)], [source], labelCanvas)
  assert.equal(label.side, 'right')
  assert.equal(label.connector.from.x, source.rect.x + source.rect.width)
  assert.equal(label.connector.to.x, label.rect.x)
  assert.equal(label.forced, false)
})

test('elige izquierda cuando la derecha esta ocupada', () => {
  const source = visualTable('a', 300, 200)
  const blocker = visualTable('blocker', 344, 175, 130, 90)
  const [label] = placeExternalLabels([labelInput('a', source.rect)], [source, blocker], labelCanvas)
  assert.equal(label.side, 'left')
  assert.equal(rectsOverlap(label.rect, blocker.rect, 8), false)
})

test('elige arriba o abajo si ambos laterales estan ocupados', () => {
  const source = visualTable('a', 300, 220)
  const left = visualTable('left', 160, 185, 100, 110)
  const right = visualTable('right', 380, 185, 100, 110)
  const [label] = placeExternalLabels([labelInput('a', source.rect)], [source, left, right], labelCanvas)
  assert.ok(label.side === 'top' || label.side === 'bottom')
  assert.equal(rectsOverlap(label.rect, left.rect, 8), false)
  assert.equal(rectsOverlap(label.rect, right.rect, 8), false)
})

test('dos etiquetas cercanas reservan espacio y no se solapan', () => {
  const first = visualTable('a', 260, 180, 30, 100)
  const second = visualTable('b', 260, 290, 30, 100)
  const labels = placeExternalLabels([labelInput('a', first.rect), labelInput('b', second.rect)], [first, second], labelCanvas)
  assert.equal(labels.length, 2)
  assert.equal(rectsOverlap(labels[0].rect, labels[1].rect, 8), false)
})

test('en mesas juntadas las etiquetas se distribuyen por los bordes exteriores', () => {
  const left = visualTable('left', 300, 200, 30, 120)
  const right = visualTable('right', 330, 200, 30, 120)
  const labels = placeExternalLabels([labelInput('left', left.rect), labelInput('right', right.rect)], [left, right], labelCanvas)
  assert.equal(labels.find((label) => label.id === 'left').side, 'left')
  assert.equal(labels.find((label) => label.id === 'right').side, 'right')
  assert.equal(labels.every((label) => !rectsOverlap(label.rect, left.rect, 8) && !rectsOverlap(label.rect, right.rect, 8)), true)
})

test('mantiene el lateral previo para evitar saltos mientras siga siendo valido', () => {
  const source = visualTable('a', 300, 200)
  const previous = new Map([['a', 'left']])
  const [label] = placeExternalLabels([labelInput('a', source.rect)], [source], labelCanvas, [], previous)
  assert.equal(label.side, 'left')
  const [duringDrag] = placeExternalLabels([labelInput('a', { ...source.rect, y: 204 })], [source], labelCanvas, [], previous, true)
  assert.equal(duringDrag.side, 'left')
})

test('mantiene etiquetas dentro del canvas y evita la zona reservada de controles', () => {
  const source = visualTable('a', 720, 470, 30, 40)
  const controls = { x: 560, y: 480, width: 232, height: 64 }
  const [label] = placeExternalLabels([labelInput('a', source.rect)], [source], labelCanvas, [controls])
  assert.ok(label.rect.x >= 8 && label.rect.y >= 8)
  assert.ok(label.rect.x + label.rect.width <= labelCanvas.width - 8)
  assert.ok(label.rect.y + label.rect.height <= labelCanvas.height - 8)
  assert.equal(rectsOverlap(label.rect, controls, 8), false)
})

test('los errores de Supabase conservan mensaje, detalle y codigo al guardar el mapa', () => {
  const message = getReadableError({ message: 'La distribucion no es valida', details: 'Mesa 2', code: '23514' })
  assert.equal(message, 'La distribucion no es valida - Mesa 2 - Código: 23514')
})

test('las mesas ocupadas usan naranja con pendientes y rojo cuando todo esta servido', () => {
  assert.equal(getRestaurantTableVisualStatus({ status: 'free', pendingUnits: 0 }), 'free')
  assert.equal(getRestaurantTableVisualStatus({ status: 'occupied', pendingUnits: 2 }), 'occupied-pending')
  assert.equal(getRestaurantTableVisualStatus({ status: 'occupied', pendingUnits: 0 }), 'occupied')
  assert.equal(getRestaurantTableVisualStatus({ status: 'reserved', pendingUnits: 0 }), 'reserved')
})
test('cada cambio de tamano recalcula el encaje fijo a partir del contenido real', () => {
  assert.match(tableMapViewSource, /const viewport = useMemo/)
  assert.match(tableMapViewSource, /fitBoundsToViewport\(/)
  assert.match(tableMapViewSource, /contentBounds\(fittedItems\)/)
  assert.match(tableMapViewSource, /const observer = new ResizeObserver\(updateSize\)/)
})

test('el zoom escala la geometria sin rasterizar ni escalar inversamente el texto', () => {
  assert.match(tableMapViewSource, /width: planeSize\.width \* viewport\.zoom/)
  assert.match(tableMapViewSource, /height: planeSize\.height \* viewport\.zoom/)
  assert.doesNotMatch(tableMapViewSource, /scale\(\$\{viewport\.zoom\}\)/)
  assert.doesNotMatch(tableMapViewSource, /scale\(\$\{1 \/ viewport\.zoom\}\)/)
})

test('la próxima reserva flota bajo la mesa sin sustituir su estado operativo', () => {
  assert.match(reservationBadgeSource, /absolute bottom-0 left-1\/2/)
  assert.match(reservationBadgeSource, /-translate-x-1\/2 translate-y-1\/2/)
  assert.match(reservationBadgeSource, /min-w-max/)
  assert.match(reservationBadgeSource, /rounded-full/)
  assert.match(reservationBadgeSource, /bg-\[var\(--accent-soft\)\]/)
  assert.match(reservationBadgeSource, /text-\[var\(--accent\)\]/)
  assert.doesNotMatch(reservationBadgeSource, /--warning|customerName\.split|minutesUntilReservation|isReservationLate/)
  assert.match(tableMapViewSource, /overflow-visible border-2/)
  assert.match(tableMapViewSource, /absolute inset-0[\s\S]*overflow-hidden/)
  assert.match(tableServiceSource, /reservationsByTable\.forEach\(\(items\) => items\.sort/)
  assert.match(tableServiceSource, /nextReservation: tableReservations\[0\] \?\? null/)
})

test('mobile integra el nombre en la mesa, oculta Libre y compacta la reserva', () => {
  assert.match(tableMapViewSource, /const mode = mobileLayout \? "compact" : contentModes\.get\(table\.id\)/)
  assert.match(tableMapViewSource, /!mobileLayout \|\| table\.status !== "free"/)
  assert.match(tableMapViewSource, /!mobileLayout \? externalLabels\.map/)
  assert.match(tableMapViewSource, /compact=\{mobileLayout\}/)
  assert.match(reservationBadgeSource, /compact = false/)
  assert.match(reservationBadgeSource, /right-0 top-0[\s\S]*size-5/)
  assert.match(reservationBadgeSource, /compact \? null : <span>\{time\}<\/span>/)
})

test('el giro de 90 grados conserva el plano y la conversion de puntero', () => {
  const item = { positionX: 12, positionY: 24, width: 16, height: 10 }
  assert.deepEqual(orientMapRect(item, true), { positionX: 66, positionY: 12, width: 10, height: 16 })
  const viewport = { zoom: 1.35, panX: -18, panY: 27 }
  const point = { x: 31, y: 72 }
  const result = screenToMap(mapToScreen(point, bounds, viewport, true), bounds, viewport, true)
  assert.ok(Math.abs(result.x - point.x) < 1e-9)
  assert.ok(Math.abs(result.y - point.y) < 1e-9)
})

test('la orientacion del TPV es automatica y no conserva una preferencia manual', () => {
  assert.match(tableMapViewSource, /shouldRotateMapToFit\(/)
  assert.doesNotMatch(tableMapViewSource, /loadTableMapQuarterTurn|persistTableMapQuarterTurn|toggleMapOrientation/)
})

test('crear zona envia el formulario mediante el boton HeroUI', () => {
  assert.match(tableManagementSource, /type="submit"><Plus size=\{16\} \/> Crear zona<\/UiButton>/)
  assert.match(tableManagementSource, /onSubmit=\{\(event\) => \{ event\.preventDefault\(\); void addArea\(\) \}\}/)
})

test('las etiquetas externas mobile son mas compactas sin cambiar la medida de tablet', () => {
  const desktop = externalLabelSize('Mesa principal')
  const mobile = externalLabelSize('Mesa principal', true)
  assert.equal(desktop.height, 48)
  assert.equal(mobile.height, 40)
  assert.ok(mobile.width < desktop.width)
})

test('mobile usa una composicion propia y tablet conserva el encabezado de escritorio', () => {
  assert.match(tableMapViewSource, /!mobileLayout \? <header/)
  assert.match(tableMapViewSource, /<h1>Mapa de mesas<\/h1>/)
  assert.match(tableMapViewSource, /<MobileTableMapChrome/)
  assert.match(tableMapViewSource, /mobileLayout \? 'gap-0 overflow-hidden p-0'/)
  assert.match(tableMapViewSource, /mobileLayout \? 'min-h-0 rounded-none border-x-0 border-b-0 shadow-none'/)
  assert.match(mobileLayoutSource, /max-width: 767px/)
  assert.match(mobileLayoutSource, /max-width: 950px/)
  assert.match(mobileLayoutSource, /max-height: 500px/)
})

test('mobile presenta sala y edicion sin persistir la proyeccion visual', () => {
  assert.match(mobileChromeSource, /Cambiar sala/)
  assert.match(mobileChromeSource, /min-h-11/)
  assert.match(mobileChromeSource, /Editando mesas/)
  assert.match(mobileChromeSource, /Guardado automático/)
  assert.match(tableMapViewSource, /<MobileGroupActionsSheet/)
  assert.match(mobileSheetsSource, /placement="bottom"/)
  assert.match(mobileSheetsSource, /safe-area-inset-bottom/)
  assert.match(tableMapViewSource, /const orientedTable = orientMapRect\(table, rotatedMap\)/)
  assert.match(tableMapViewSource, /layoutFromMap\(nextMap\)/)
  assert.doesNotMatch(tableMapViewSource, /layoutFromMap\([^)]*orientMapRect/)
})

test('mobile abre las mesas directamente igual que iPad sin hoja de acciones intermedia', () => {
  assert.match(tableMapViewSource, /if \(table\.status === "occupied" && table\.orderId\)\s+onOpenOrder\(table\.orderId\)/)
  assert.match(tableMapViewSource, /else if \(table\.status === "free" && canOpen\) prepareOpenTable\(table\)/)
  assert.doesNotMatch(tableMapViewSource, /if \(mobileLayout\) \{\s+setSelectedTableId\(table\.id\)/)
  assert.doesNotMatch(tableMapViewSource, /MobileTableActionSheet/)
  assert.doesNotMatch(mobileSheetsSource, /MobileTableActionSheet|Abrir comanda|Abrir mesa/)
})

test('el mapa TPV no muestra controles de zoom ni giro y reserva sus botones', () => {
  assert.doesNotMatch(tableMapViewSource, /<MapViewportControls|useMapViewport|onWheel=/)
  assert.match(tableMapViewSource, /MOBILE_MAP_TOP_INSET = 124/)
  assert.match(tableMapViewSource, /width: canvasSize\.width, height: MOBILE_MAP_TOP_INSET/)
  assert.match(tableMapViewSource, /orientMapRect\(table, rotatedMap\)/)
})

test('la sala activa queda marcada en escritorio y en el indicador mobile', () => {
  assert.match(tableMapViewSource, /aria-current=\{area\.id === activeAreaId \? "page" : undefined\}/)
  assert.match(tableMapViewSource, /!border-\[var\(--accent\)\] !bg-\[var\(--accent\)\] !text-\[var\(--accent-foreground\)\]/)
  assert.match(mobileChromeSource, /Sala \{activeAreaIndex \+ 1\} de \{areas\.length\} seleccionada/)
  assert.match(mobileChromeSource, /area\.id === activeArea\?\.id \? "w-5 bg-\[var\(--accent\)\]"/)
})

test('mobile combina el indicador compacto y el desplegable en un unico control', () => {
  assert.match(mobileChromeSource, /<Dropdown\.Trigger[\s\S]*rounded-full[\s\S]*areas\.map\(\(area\)/)
  assert.match(mobileChromeSource, /<Dropdown\.Popover/)
  assert.match(mobileChromeSource, /<Dropdown\.Menu/)
  assert.doesNotMatch(mobileChromeSource, /pointer-events-none absolute left-3 top-16/)
})

test('el espacio entre mesas queda fijo y la capa solo aplica el encaje calculado', () => {
  assert.match(tableMapViewSource, /className="map-transform-layer absolute z-\[2\]"/)
  assert.doesNotMatch(tableMapViewSource, /startBackgroundPointer|moveBackgroundPointer|endBackgroundPointer/)
})

test('el desplazamiento horizontal del fondo navega entre salas sin reactivar el pan', () => {
  assert.match(tableMapViewSource, /onPointerDown=\{startAreaSwipe\}/)
  assert.match(tableMapViewSource, /moveAreaSwipe\(event\)/)
  assert.match(tableMapViewSource, /AREA_SWIPE_VISUAL_STYLE/)
  assert.match(tableMapViewSource, /transform 160ms ease-out/)
  assert.match(tableMapViewSource, /getAreaSwipeTarget\(/)
  assert.match(tableMapViewSource, /onAreaChange\(targetAreaId\)/)
  assert.doesNotMatch(tableMapViewSource, /startBackgroundPointer|moveBackgroundPointer|endBackgroundPointer/)
})
