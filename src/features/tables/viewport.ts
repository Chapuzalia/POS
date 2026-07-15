export type Point = { x: number; y: number }
export type Viewport = { zoom: number; panX: number; panY: number }
export type MapBounds = { minX: number; minY: number; maxX: number; maxY: number }

export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 2

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function screenToMap(point: Point, bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, viewport: Viewport): Point {
  return { x: ((point.x - bounds.left - viewport.panX) / viewport.zoom / bounds.width) * 100, y: ((point.y - bounds.top - viewport.panY) / viewport.zoom / bounds.height) * 100 }
}

export function mapToScreen(point: Point, bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, viewport: Viewport): Point {
  return { x: bounds.left + viewport.panX + (point.x / 100) * bounds.width * viewport.zoom, y: bounds.top + viewport.panY + (point.y / 100) * bounds.height * viewport.zoom }
}

export function zoomAtPoint(viewport: Viewport, nextZoom: number, anchor: Point, bounds: Pick<DOMRect, 'left' | 'top'>): Viewport {
  const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM)
  const localX = anchor.x - bounds.left, localY = anchor.y - bounds.top, ratio = zoom / viewport.zoom
  return { zoom, panX: localX - (localX - viewport.panX) * ratio, panY: localY - (localY - viewport.panY) * ratio }
}

export function fitBounds(content: MapBounds, viewportWidth: number, viewportHeight: number, padding = 32): Viewport {
  const widthRatio = Math.max(0.01, (content.maxX - content.minX) / 100), heightRatio = Math.max(0.01, (content.maxY - content.minY) / 100)
  const zoom = clamp(Math.min((viewportWidth - padding * 2) / (viewportWidth * widthRatio), (viewportHeight - padding * 2) / (viewportHeight * heightRatio)), MIN_ZOOM, MAX_ZOOM)
  const centerX = ((content.minX + content.maxX) / 2 / 100) * viewportWidth * zoom, centerY = ((content.minY + content.maxY) / 2 / 100) * viewportHeight * zoom
  return { zoom, panX: viewportWidth / 2 - centerX, panY: viewportHeight / 2 - centerY }
}

export function contentBounds(items: Array<{ positionX: number; positionY: number; width: number; height: number }>): MapBounds {
  if (!items.length) return { minX: 0, minY: 0, maxX: 100, maxY: 100 }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const item of items) { minX = Math.min(minX, item.positionX); minY = Math.min(minY, item.positionY); maxX = Math.max(maxX, item.positionX + item.width); maxY = Math.max(maxY, item.positionY + item.height) }
  return { minX, minY, maxX, maxY }
}

export function intersectionRatio(a: { positionX: number; positionY: number; width: number; height: number }, b: { positionX: number; positionY: number; width: number; height: number }) {
  const width = Math.max(0, Math.min(a.positionX + a.width, b.positionX + b.width) - Math.max(a.positionX, b.positionX))
  const height = Math.max(0, Math.min(a.positionY + a.height, b.positionY + b.height) - Math.max(a.positionY, b.positionY))
  return (width * height) / Math.max(1, Math.min(a.width * a.height, b.width * b.height))
}

export function positionFloatingPanel(
  pointer: Point,
  bounds: { width: number; height: number },
  panel: { width: number; height: number },
  offset = 10,
  padding = 8,
): Point {
  const preferredX = pointer.x + offset + panel.width <= bounds.width - padding ? pointer.x + offset : pointer.x - panel.width - offset
  const preferredY = pointer.y + offset + panel.height <= bounds.height - padding ? pointer.y + offset : pointer.y - panel.height - offset
  return {
    x: Math.max(padding, Math.min(bounds.width - panel.width - padding, preferredX)),
    y: Math.max(padding, Math.min(bounds.height - panel.height - padding, preferredY)),
  }
}
