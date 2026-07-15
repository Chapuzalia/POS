import type { Viewport } from './viewport'

export type VisualRect = { x: number; y: number; width: number; height: number }
export type LabelSide = 'right' | 'left' | 'top' | 'bottom' | 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'
export type TableContentMode = 'full' | 'compact' | 'external'
export type ExternalLabelInput = { id: string; table: VisualRect; label: { width: number; height: number } }
export type ExternalLabelPlacement = {
  id: string
  side: LabelSide
  rect: VisualRect
  connector: { from: { x: number; y: number }; to: { x: number; y: number } }
  forced: boolean
}

const SIDES: LabelSide[] = ['right', 'left', 'top', 'bottom', 'top-right', 'top-left', 'bottom-right', 'bottom-left']
const SHIFTS = [0, -24, 24, -48, 48]

function right(rect: VisualRect) { return rect.x + rect.width }
function bottom(rect: VisualRect) { return rect.y + rect.height }
function centerX(rect: VisualRect) { return rect.x + rect.width / 2 }
function centerY(rect: VisualRect) { return rect.y + rect.height / 2 }

export function tableVisualRect(
  table: { positionX: number; positionY: number; width: number; height: number },
  canvas: { width: number; height: number },
  viewport: Viewport,
): VisualRect {
  return {
    x: viewport.panX + table.positionX / 100 * canvas.width * viewport.zoom,
    y: viewport.panY + table.positionY / 100 * canvas.height * viewport.zoom,
    width: table.width / 100 * canvas.width * viewport.zoom,
    height: table.height / 100 * canvas.height * viewport.zoom,
  }
}

export function externalLabelSize(name: string) {
  return { width: Math.max(96, Math.min(168, 34 + name.length * 7.2)), height: 48 }
}

export function tableContentMode(rect: VisualRect, name: string): TableContentMode {
  const nameWidth = Math.min(82, 12 + name.length * 6.8)
  if (rect.width >= Math.max(88, nameWidth + 12) && rect.height >= 64) return 'full'
  if (rect.width >= Math.max(46, nameWidth) && rect.height >= 34) return 'compact'
  return 'external'
}

export function rectsOverlap(a: VisualRect, b: VisualRect, margin = 0) {
  return a.x < right(b) + margin && right(a) + margin > b.x && a.y < bottom(b) + margin && bottom(a) + margin > b.y
}

function insideCanvas(rect: VisualRect, canvas: { width: number; height: number }, padding: number) {
  return rect.x >= padding && rect.y >= padding && right(rect) <= canvas.width - padding && bottom(rect) <= canvas.height - padding
}

function isVisible(rect: VisualRect, canvas: { width: number; height: number }) {
  return right(rect) > 0 && bottom(rect) > 0 && rect.x < canvas.width && rect.y < canvas.height
}

function candidateRect(table: VisualRect, label: ExternalLabelInput['label'], side: LabelSide, shift: number, gap: number): VisualRect {
  const centeredX = centerX(table) - label.width / 2
  const centeredY = centerY(table) - label.height / 2
  switch (side) {
    case 'right': return { x: right(table) + gap, y: centeredY + shift, ...label }
    case 'left': return { x: table.x - label.width - gap, y: centeredY + shift, ...label }
    case 'top': return { x: centeredX + shift, y: table.y - label.height - gap, ...label }
    case 'bottom': return { x: centeredX + shift, y: bottom(table) + gap, ...label }
    case 'top-right': return { x: right(table) + gap, y: table.y - label.height - gap + shift, ...label }
    case 'top-left': return { x: table.x - label.width - gap, y: table.y - label.height - gap + shift, ...label }
    case 'bottom-right': return { x: right(table) + gap, y: bottom(table) + gap + shift, ...label }
    case 'bottom-left': return { x: table.x - label.width - gap, y: bottom(table) + gap + shift, ...label }
  }
}

function connectorBetween(table: VisualRect, label: VisualRect) {
  const horizontalGap = label.x >= right(table) || right(label) <= table.x
  const verticalGap = label.y >= bottom(table) || bottom(label) <= table.y
  const from = {
    x: label.x >= right(table) ? right(table) : right(label) <= table.x ? table.x : Math.max(table.x, Math.min(right(table), centerX(label))),
    y: label.y >= bottom(table) ? bottom(table) : bottom(label) <= table.y ? table.y : Math.max(table.y, Math.min(bottom(table), centerY(label))),
  }
  const to = {
    x: label.x >= right(table) ? label.x : right(label) <= table.x ? right(label) : Math.max(label.x, Math.min(right(label), centerX(table))),
    y: label.y >= bottom(table) ? label.y : bottom(label) <= table.y ? bottom(label) : Math.max(label.y, Math.min(bottom(label), centerY(table))),
  }
  if (!horizontalGap) from.x = to.x
  if (!verticalGap) from.y = to.y
  return { from, to }
}

function orientation(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) {
  return (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y)
}

function segmentsCross(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }) {
  return orientation(a, b, c) * orientation(a, b, d) < 0 && orientation(c, d, a) * orientation(c, d, b) < 0
}

export function segmentCrossesRect(from: { x: number; y: number }, to: { x: number; y: number }, rect: VisualRect, margin = 0) {
  const expanded = { x: rect.x - margin, y: rect.y - margin, width: rect.width + margin * 2, height: rect.height + margin * 2 }
  if ((from.x >= expanded.x && from.x <= right(expanded) && from.y >= expanded.y && from.y <= bottom(expanded))
    || (to.x >= expanded.x && to.x <= right(expanded) && to.y >= expanded.y && to.y <= bottom(expanded))) return true
  const topLeft = { x: expanded.x, y: expanded.y }, topRight = { x: right(expanded), y: expanded.y }
  const bottomRight = { x: right(expanded), y: bottom(expanded) }, bottomLeft = { x: expanded.x, y: bottom(expanded) }
  return segmentsCross(from, to, topLeft, topRight) || segmentsCross(from, to, topRight, bottomRight)
    || segmentsCross(from, to, bottomRight, bottomLeft) || segmentsCross(from, to, bottomLeft, topLeft)
}

export function placeExternalLabels(
  inputs: ExternalLabelInput[],
  allTables: Array<{ id: string; rect: VisualRect }>,
  canvas: { width: number; height: number },
  reserved: VisualRect[] = [],
  previousSides: ReadonlyMap<string, LabelSide> = new Map(),
  lockPreviousSides = false,
): ExternalLabelPlacement[] {
  const placed: ExternalLabelPlacement[] = []
  const margin = 8, gap = 12
  for (const input of inputs) {
    if (!isVisible(input.table, canvas)) continue
    const previous = previousSides.get(input.id)
    const availableSides = lockPreviousSides && previous ? [previous] : SIDES
    let best: { side: LabelSide; rect: VisualRect; score: number; forced: boolean } | null = null
    for (const side of availableSides) {
      for (const shift of SHIFTS) {
        const rect = candidateRect(input.table, input.label, side, shift, gap)
        const connector = connectorBetween(input.table, rect)
        const tableCollisions = allTables.filter((table) => table.id !== input.id && rectsOverlap(rect, table.rect, margin)).length
        const labelCollisions = placed.filter((label) => rectsOverlap(rect, label.rect, margin)).length
        const reservedCollisions = reserved.filter((item) => rectsOverlap(rect, item, margin)).length
        const connectorCrossings = allTables.filter((table) => table.id !== input.id && segmentCrossesRect(connector.from, connector.to, table.rect, 2)).length
        const outside = insideCanvas(rect, canvas, 8) ? 0 : 1
        const collisionPenalty = tableCollisions * 120_000 + labelCollisions * 140_000 + reservedCollisions * 160_000 + connectorCrossings * 60_000 + outside * 200_000
        const changePenalty = previous && previous !== side ? 36 : previous === side ? -24 : 0
        const distance = Math.hypot(centerX(rect) - centerX(input.table), centerY(rect) - centerY(input.table))
        const score = collisionPenalty + distance + SIDES.indexOf(side) * 40 + Math.abs(shift) * .2 + changePenalty
        if (!best || score < best.score) best = { side, rect, score, forced: collisionPenalty > 0 }
      }
    }
    if (best) placed.push({ id: input.id, side: best.side, rect: best.rect, connector: connectorBetween(input.table, best.rect), forced: best.forced })
  }
  return placed
}
