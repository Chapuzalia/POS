import test from 'node:test'
import assert from 'node:assert/strict'
import { createMapElement, normalizeMapElements } from '../src/features/tables/map-elements.ts'

test('crea paredes, columnas y textos con geometria valida', () => {
  for (const kind of ['wall', 'column', 'text']) {
    const element = createMapElement(kind, 0)
    assert.equal(element.kind, kind)
    assert.ok(element.positionX >= 0 && element.positionX + element.width <= 100)
    assert.ok(element.positionY >= 0 && element.positionY + element.height <= 100)
  }
})

test('normaliza geometria fuera del canvas y limita el texto', () => {
  const [element] = normalizeMapElements([{
    id: 'element-1', kind: 'text', positionX: 98, positionY: -20,
    width: 20, height: 7, text: 'x'.repeat(140),
  }])
  assert.equal(element.positionX, 80)
  assert.equal(element.positionY, 0)
  assert.equal(element.text.length, 120)
})

test('descarta elementos desconocidos y limita el numero por zona', () => {
  const candidates = Array.from({ length: 300 }, (_, index) => ({
    id: `wall-${index}`, kind: 'wall', positionX: 0, positionY: 0, width: 10, height: 2, text: '',
  }))
  assert.equal(normalizeMapElements([{ id: 'bad', kind: 'door' }, ...candidates]).length, 250)
})
