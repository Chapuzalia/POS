import test from 'node:test'
import assert from 'node:assert/strict'
import { snapTableAlignment, snapTableCenter } from '../src/features/tables/alignment.ts'
import { placeExternalLabels, rectsOverlap, tableContentMode, tableVisualRect } from '../src/features/tables/external-label-layout.ts'
import { compactJoinedCompositions, compositionHasOpenOrder, findJoinProposal, isCompactComposition, separateFromComposition, translateComposition } from '../src/features/tables/joined-layout.ts'
import { fitBounds, intersectionRatio, mapToScreen, positionFloatingPanel, screenToMap, zoomAtPoint } from '../src/features/tables/viewport.ts'
import { getReadableError } from '../src/utils/errors.ts'

const bounds = { left: 100, top: 50, width: 1000, height: 600 }

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
  assert.equal(message, 'La distribucion no es valida - Mesa 2 - Codigo: 23514')
})
