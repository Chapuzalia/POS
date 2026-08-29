const MIN_SWIPE_DISTANCE = 48
const SWIPE_WIDTH_RATIO = 0.12
const HORIZONTAL_DOMINANCE = 1.25
const MAX_VISUAL_OFFSET_RATIO = 0.22
const MAX_VISUAL_FADE = 0.12

export function getAreaSwipeVisualFeedback(
  deltaX: number,
  deltaY: number,
  viewportWidth: number,
) {
  if (viewportWidth <= 0 || Math.abs(deltaX) <= Math.abs(deltaY)) {
    return { offsetX: 0, opacity: 1 }
  }

  const maxOffset = viewportWidth * MAX_VISUAL_OFFSET_RATIO
  const offsetX = Math.max(-maxOffset, Math.min(maxOffset, deltaX))
  const progress = Math.abs(offsetX) / maxOffset
  return { offsetX, opacity: 1 - progress * MAX_VISUAL_FADE }
}

export function getAreaSwipeEntryOffset(deltaX: number, viewportWidth: number) {
  const distance = Math.min(72, Math.max(36, viewportWidth * SWIPE_WIDTH_RATIO))
  return deltaX < 0 ? distance : -distance
}

export function getAreaSwipeTarget(
  areaIds: string[],
  activeAreaId: string | undefined,
  deltaX: number,
  deltaY: number,
  viewportWidth: number,
) {
  if (areaIds.length < 2) return null
  const distance = Math.abs(deltaX)
  const threshold = Math.max(MIN_SWIPE_DISTANCE, viewportWidth * SWIPE_WIDTH_RATIO)
  if (distance < threshold || distance <= Math.abs(deltaY) * HORIZONTAL_DOMINANCE) return null

  const currentIndex = Math.max(0, areaIds.indexOf(activeAreaId ?? ''))
  const direction = deltaX < 0 ? 1 : -1
  return areaIds[(currentIndex + direction + areaIds.length) % areaIds.length]
}
