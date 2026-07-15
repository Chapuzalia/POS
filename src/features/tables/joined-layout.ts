export type LayoutRect = {
  id: string
  positionX: number
  positionY: number
  width: number
  height: number
  layoutGroupId?: string | null
}

export type JoinSide = 'left' | 'right' | 'top' | 'bottom'

export type JoinProposal<T extends LayoutRect> = {
  side: JoinSide
  targetId: string
  tables: T[]
}

const JOIN_GAP = 0.12
const JOIN_DISTANCE = 3.5
const COLLISION_TOLERANCE = 0.08

export function getJoinedIds(table: LayoutRect, tables: LayoutRect[]) {
  if (!table.layoutGroupId) return [table.id]
  return tables.filter((candidate) => candidate.layoutGroupId === table.layoutGroupId).map((candidate) => candidate.id)
}

export function compositionHasOpenOrder<T extends LayoutRect & { orderId?: string | null }>(table: T, tables: T[]) {
  return Boolean(table.layoutGroupId)
    && tables.some((candidate) => candidate.layoutGroupId === table.layoutGroupId && Boolean(candidate.orderId))
}

export function boundsOf(tables: LayoutRect[]) {
  return {
    left: Math.min(...tables.map((table) => table.positionX)),
    top: Math.min(...tables.map((table) => table.positionY)),
    right: Math.max(...tables.map((table) => table.positionX + table.width)),
    bottom: Math.max(...tables.map((table) => table.positionY + table.height)),
  }
}

export function translateComposition<T extends LayoutRect>(tables: T[], memberIds: Set<string>, dx: number, dy: number): T[] {
  const members = tables.filter((table) => memberIds.has(table.id))
  const bounds = boundsOf(members)
  const safeDx = Math.max(-bounds.left, Math.min(100 - bounds.right, dx))
  const safeDy = Math.max(-bounds.top, Math.min(100 - bounds.bottom, dy))
  return tables.map((table) => memberIds.has(table.id)
    ? { ...table, positionX: table.positionX + safeDx, positionY: table.positionY + safeDy }
    : table)
}

function overlapLength(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
}

function overlaps(a: LayoutRect, b: LayoutRect) {
  return overlapLength(a.positionX, a.positionX + a.width, b.positionX, b.positionX + b.width) > COLLISION_TOLERANCE
    && overlapLength(a.positionY, a.positionY + a.height, b.positionY, b.positionY + b.height) > COLLISION_TOLERANCE
}

function touches(a: LayoutRect, b: LayoutRect) {
  const overlapX = overlapLength(a.positionX, a.positionX + a.width, b.positionX, b.positionX + b.width)
  const overlapY = overlapLength(a.positionY, a.positionY + a.height, b.positionY, b.positionY + b.height)
  const horizontalGap = Math.abs(Math.max(a.positionX, b.positionX) - Math.min(a.positionX + a.width, b.positionX + b.width))
  const verticalGap = Math.abs(Math.max(a.positionY, b.positionY) - Math.min(a.positionY + a.height, b.positionY + b.height))
  return (horizontalGap <= .3 && overlapY > .2) || (verticalGap <= .3 && overlapX > .2)
}

export function isCompactComposition(tables: LayoutRect[]) {
  if (tables.length < 2) return false
  const reached = new Set([tables[0].id])
  let changed = true
  while (changed) {
    changed = false
    for (const table of tables) {
      if (reached.has(table.id)) continue
      if (tables.some((candidate) => reached.has(candidate.id) && touches(table, candidate))) {
        reached.add(table.id)
        changed = true
      }
    }
  }
  return reached.size === tables.length && !tables.some((table, index) => tables.slice(index + 1).some((other) => overlaps(table, other)))
}

export function compactJoinedCompositions<T extends LayoutRect>(tables: T[]): T[] {
  let result = tables
  const groupIds = [...new Set(tables.map((table) => table.layoutGroupId).filter((groupId): groupId is string => Boolean(groupId)))]
  for (const groupId of groupIds) {
    const members = result.filter((table) => table.layoutGroupId === groupId)
    if (isCompactComposition(members)) continue
    const bounds = boundsOf(members)
    const horizontal = bounds.right - bounds.left >= bounds.bottom - bounds.top
    const ordered = [...members].sort(horizontal
      ? (a, b) => a.positionX - b.positionX || a.positionY - b.positionY
      : (a, b) => a.positionY - b.positionY || a.positionX - b.positionX)
    const first = ordered[0]
    let cursorX = first.positionX + (horizontal ? first.width + JOIN_GAP : 0)
    let cursorY = first.positionY + (horizontal ? 0 : first.height + JOIN_GAP)
    const positions = new Map<string, { positionX: number; positionY: number }>([[first.id, { positionX: first.positionX, positionY: first.positionY }]])
    for (const table of ordered.slice(1)) {
      const positionX = horizontal ? cursorX : first.positionX + (first.width - table.width) / 2
      const positionY = horizontal ? first.positionY + (first.height - table.height) / 2 : cursorY
      positions.set(table.id, { positionX, positionY })
      cursorX = positionX + (horizontal ? table.width + JOIN_GAP : 0)
      cursorY = positionY + (horizontal ? 0 : table.height + JOIN_GAP)
    }
    result = result.map((table) => {
      const position = positions.get(table.id)
      return position ? { ...table, ...position } : table
    })
    result = translateComposition(result, new Set(ordered.map((table) => table.id)), 0, 0)
  }
  return result
}

function hasMeaningfulContact(source: LayoutRect, target: LayoutRect) {
  const overlapX = overlapLength(source.positionX, source.positionX + source.width, target.positionX, target.positionX + target.width)
  const overlapY = overlapLength(source.positionY, source.positionY + source.height, target.positionY, target.positionY + target.height)
  const gapX = Math.max(0, target.positionX - source.positionX - source.width, source.positionX - target.positionX - target.width)
  const gapY = Math.max(0, target.positionY - source.positionY - source.height, source.positionY - target.positionY - target.height)
  const substantialOverlap = overlapX * overlapY >= Math.min(source.width * source.height, target.width * target.height) * .24
  const closeToVerticalEdge = gapX <= JOIN_DISTANCE && overlapY >= Math.min(source.height, target.height) * .35
  const closeToHorizontalEdge = gapY <= JOIN_DISTANCE && overlapX >= Math.min(source.width, target.width) * .35
  return substantialOverlap || closeToVerticalEdge || closeToHorizontalEdge
}

function snappedPositions(source: LayoutRect, target: LayoutRect, side: JoinSide) {
  if (side === 'left' || side === 'right') {
    const x = side === 'left' ? target.positionX - source.width - JOIN_GAP : target.positionX + target.width + JOIN_GAP
    return [
      { x, y: target.positionY + (target.height - source.height) / 2 },
      { x, y: target.positionY },
      { x, y: target.positionY + target.height - source.height },
    ]
  }
  const y = side === 'top' ? target.positionY - source.height - JOIN_GAP : target.positionY + target.height + JOIN_GAP
  return [
    { x: target.positionX + (target.width - source.width) / 2, y },
    { x: target.positionX, y },
    { x: target.positionX + target.width - source.width, y },
  ]
}

function sidePreference(source: LayoutRect, target: LayoutRect): JoinSide[] {
  const dx = source.positionX + source.width / 2 - (target.positionX + target.width / 2)
  const dy = source.positionY + source.height / 2 - (target.positionY + target.height / 2)
  const horizontal: JoinSide = dx < 0 ? 'left' : 'right'
  const vertical: JoinSide = dy < 0 ? 'top' : 'bottom'
  return Math.abs(dx) >= Math.abs(dy)
    ? [horizontal, vertical, vertical === 'top' ? 'bottom' : 'top', horizontal === 'left' ? 'right' : 'left']
    : [vertical, horizontal, horizontal === 'left' ? 'right' : 'left', vertical === 'top' ? 'bottom' : 'top']
}

export function findJoinProposal<T extends LayoutRect>(tables: T[], draggedId: string, sourceIds: Set<string>): JoinProposal<T> | null {
  const source = tables.find((table) => table.id === draggedId)
  if (!source) return null
  const targets = tables.filter((table) => !sourceIds.has(table.id) && hasMeaningfulContact(source, table))
  const candidates: Array<JoinProposal<T> & { score: number }> = []

  for (const target of targets) {
    const preferredSides = sidePreference(source, target)
    preferredSides.forEach((side, sideIndex) => {
      snappedPositions(source, target, side).forEach((snapped) => {
        const dx = snapped.x - source.positionX
        const dy = snapped.y - source.positionY
        const moved = translateComposition(tables, sourceIds, dx, dy)
        const movedMembers = moved.filter((table) => sourceIds.has(table.id))
        const otherTables = moved.filter((table) => !sourceIds.has(table.id))
        const placedSource = moved.find((table) => table.id === source.id)
        const reachedSnap = placedSource && Math.abs(placedSource.positionX - snapped.x) < .01 && Math.abs(placedSource.positionY - snapped.y) < .01
        const collision = movedMembers.some((member) => otherTables.some((other) => overlaps(member, other)))
        if (!reachedSnap || collision) return
        candidates.push({ side, targetId: target.id, tables: moved, score: Math.hypot(dx, dy) + sideIndex * 1.5 })
      })
    })
  }

  candidates.sort((a, b) => a.score - b.score)
  return candidates[0] ?? null
}

export function separateFromComposition<T extends LayoutRect>(tables: T[], tableId: string, separateAll: boolean): T[] {
  const selected = tables.find((table) => table.id === tableId)
  if (!selected?.layoutGroupId) return tables
  const members = tables.filter((table) => table.layoutGroupId === selected.layoutGroupId)
  const groupCenter = boundsOf(members)
  const centerX = (groupCenter.left + groupCenter.right) / 2
  const centerY = (groupCenter.top + groupCenter.bottom) / 2

  if (separateAll) {
    return tables.map((table) => {
      if (table.layoutGroupId !== selected.layoutGroupId) return table
      const tableCenterX = table.positionX + table.width / 2
      const tableCenterY = table.positionY + table.height / 2
      const length = Math.max(1, Math.hypot(tableCenterX - centerX, tableCenterY - centerY))
      return {
        ...table,
        layoutGroupId: null,
        positionX: Math.max(0, Math.min(100 - table.width, table.positionX + (tableCenterX - centerX) / length * 2.5)),
        positionY: Math.max(0, Math.min(100 - table.height, table.positionY + (tableCenterY - centerY) / length * 2.5)),
      }
    })
  }

  const dx = selected.positionX + selected.width / 2 < centerX ? -3 : 3
  const dy = selected.positionY + selected.height / 2 < centerY ? -3 : 3
  return tables.map((table) => {
    if (table.id === tableId) return { ...table, layoutGroupId: null, positionX: Math.max(0, Math.min(100 - table.width, table.positionX + dx)), positionY: Math.max(0, Math.min(100 - table.height, table.positionY + dy)) }
    if (table.layoutGroupId === selected.layoutGroupId && members.length === 2) return { ...table, layoutGroupId: null }
    return table
  })
}
