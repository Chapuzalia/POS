import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compileComponent, createHookHarness, jsxRuntime, nodes } from './helpers/component-harness.mjs'

const read = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
const viewport = compileComponent(read('features/tables/viewport.ts'), {})
const swipe = compileComponent(read('features/tables/area-swipe.ts'), {})

function harness(selection) {
  const hooks = createHookHarness()
  const created = []
  const changes = []
  const react = { ...hooks.react, useState(initial) {
    return hooks.react.useState(initial?.width === 0 ? { width: 900, height: 600 } : initial)
  } }
  const { ReservationMapView } = compileComponent(read('features/reservations/components/ReservationMapView.tsx'), {
    react, 'react/jsx-runtime': jsxRuntime,
    '../../../components/ui/Button': { Button: 'button' },
    'lucide-react': Object.fromEntries(['Armchair', 'CalendarPlus', 'Check', 'CircleCheck', 'ShieldAlert', 'Users', 'X'].map(name => [name, name])),
    '../../tables/area-swipe': swipe, '../../tables/viewport': viewport,
    '../domain/reservationAvailability': { getNextReservationForTable: () => null },
  })
  const props = {
    date: '2026-10-06', reservations: [], onSelectReservation() {},
    onCreate: ids => created.push(ids),
    map: { operationalMap: null, areas: ['a', 'b', 'c'].map(id => ({ id, name: id, canvasWidth: 1200, canvasHeight: 800, mapElements: [] })),
      tables: ['a', 'b', 'c'].map(id => ({ id: `table-${id}`, areaId: id, name: id, isActive: true, capacity: 4, positionX: 80, positionY: 80, width: 15, height: 15 })) },
    selection: selection ? { selectedTableIds: [], selectedCapacity: 0, partySize: 4, disabled: false, conflictTableIds: [], hasActiveConflicts: false, onChange: ids => {
      changes.push(ids)
      props.selection.selectedTableIds = ids
      props.selection.selectedCapacity = ids.length * 4
    } } : undefined,
  }
  const render = () => hooks.render(ReservationMapView, props)
  const canvas = tree => nodes(tree).find(node => node.type === 'section')
  const properties = new Map()
  const element = { setPointerCapture() {}, style: { setProperty: (key, value) => properties.set(key, value) } }
  const event = (x, y = 100) => ({ pointerId: 1, button: 0, clientX: x, clientY: y, target: { closest: () => null }, currentTarget: element })
  return { render, canvas, event, properties, created, changes }
}

test('reservation map swipes between zones, wraps, and cancels incomplete gestures', () => {
  const h = harness()
  let canvas = h.canvas(h.render())
  canvas.props.ref.current = h.event(0).currentTarget
  canvas.props.onPointerDown(h.event(500))
  canvas.props.onPointerUp(h.event(250))
  canvas = h.canvas(h.render())
  assert.equal(canvas.props['aria-label'], 'Mapa de b')
  canvas.props.onPointerDown(h.event(250))
  canvas.props.onPointerMove(h.event(500))
  canvas.props.onPointerCancel(h.event(500))
  assert.equal(h.canvas(h.render()).props['aria-label'], 'Mapa de b')
  assert.equal(h.properties.get('--reservation-swipe-x'), '0px')
  canvas.props.onPointerDown(h.event(250))
  canvas.props.onPointerUp(h.event(500))
  canvas = h.canvas(h.render())
  canvas.props.onPointerDown(h.event(250))
  canvas.props.onPointerUp(h.event(500))
  assert.equal(h.canvas(h.render()).props['aria-label'], 'Mapa de c')
})

test('auto fit keeps distant tables in view and table selection still creates a reservation', () => {
  const h = harness()
  const tree = h.render()
  const canvas = h.canvas(tree)
  const layer = canvas.props.children[0]
  const table = nodes(layer).find(node => node.props['aria-label'] === 'Mesa a, 4 plazas')
  const style = layer.props.style
  assert.ok(style.left + style.width * .8 >= 0)
  assert.ok(style.left + style.width * .95 <= 900)
  assert.ok(style.top + style.height * .95 <= 600)
  table.props.onClick()
  const create = nodes(h.render()).find(node => node.type === 'button' && node.props.children?.includes?.(' Nueva'))
  assert.ok(create)
  create.props.onClick()
  assert.deepEqual(Array.from(h.created[0]), ['table-a'])
})

test('reservation editor map retains table selection across zone navigation', () => {
  const h = harness(true)
  const canvas = h.canvas(h.render())
  nodes(canvas).find(node => node.props['aria-label'] === 'Mesa a, 4 plazas').props.onClick()
  assert.deepEqual(Array.from(h.changes[0]), ['table-a'])
  canvas.props.onPointerDown(h.event(500))
  canvas.props.onPointerUp(h.event(250))
  const next = h.canvas(h.render())
  nodes(next).find(node => node.props['aria-label'] === 'Mesa b, 4 plazas').props.onClick()
  assert.deepEqual(Array.from(h.changes[1]), ['table-a', 'table-b'])
})
