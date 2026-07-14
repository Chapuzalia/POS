import test from 'node:test'
import assert from 'node:assert/strict'
import { snapTableCenter } from '../src/features/tables/alignment.ts'
import { fitBounds, intersectionRatio, mapToScreen, screenToMap, zoomAtPoint } from '../src/features/tables/viewport.ts'

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

test('la zona de union exige una interseccion sustancial', () => {
  const target = { positionX: 20, positionY: 20, width: 10, height: 10 }
  assert.ok(intersectionRatio({ positionX: 21, positionY: 21, width: 10, height: 10 }, target) > .45)
  assert.ok(intersectionRatio({ positionX: 29, positionY: 29, width: 10, height: 10 }, target) < .45)
})
