export type AlignableTable = { id: string; positionX: number; positionY: number; width: number; height: number }

export function snapTableCenter(moving: AlignableTable, others: AlignableTable[], tolerance: number) {
  let positionX = moving.positionX, positionY = moving.positionY
  const centerX = positionX + moving.width / 2, centerY = positionY + moving.height / 2
  let guidelineX: number | null = null, guidelineY: number | null = null
  let bestX = tolerance, bestY = tolerance
  for (const table of others) {
    if (table.id === moving.id) continue
    const candidateX = table.positionX + table.width / 2, candidateY = table.positionY + table.height / 2
    const distanceX = Math.abs(candidateX - centerX), distanceY = Math.abs(candidateY - centerY)
    if (distanceX < bestX) { bestX = distanceX; positionX = candidateX - moving.width / 2; guidelineX = candidateX }
    if (distanceY < bestY) { bestY = distanceY; positionY = candidateY - moving.height / 2; guidelineY = candidateY }
  }
  return { positionX, positionY, guidelineX, guidelineY }
}
