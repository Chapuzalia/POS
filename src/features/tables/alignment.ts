export type AlignableTable = { id: string; positionX: number; positionY: number; width: number; height: number }

export function snapTableAlignment(moving: AlignableTable, others: AlignableTable[], tolerance: number) {
  let positionX = moving.positionX, positionY = moving.positionY
  const movingX = [moving.positionX + moving.width / 2, moving.positionX, moving.positionX + moving.width]
  const movingY = [moving.positionY + moving.height / 2, moving.positionY, moving.positionY + moving.height]
  let guidelineX: number | null = null, guidelineY: number | null = null
  let bestX = tolerance, bestY = tolerance
  for (const table of others) {
    if (table.id === moving.id) continue
    const targetX = [table.positionX + table.width / 2, table.positionX, table.positionX + table.width]
    const targetY = [table.positionY + table.height / 2, table.positionY, table.positionY + table.height]
    for (let anchor = 0; anchor < 3; anchor += 1) {
      const distanceX = Math.abs(targetX[anchor] - movingX[anchor])
      if (distanceX < bestX) { bestX = distanceX; positionX = moving.positionX + targetX[anchor] - movingX[anchor]; guidelineX = targetX[anchor] }
      const distanceY = Math.abs(targetY[anchor] - movingY[anchor])
      if (distanceY < bestY) { bestY = distanceY; positionY = moving.positionY + targetY[anchor] - movingY[anchor]; guidelineY = targetY[anchor] }
    }
  }
  return { positionX, positionY, guidelineX, guidelineY }
}

export const snapTableCenter = snapTableAlignment
