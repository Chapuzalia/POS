import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { contentBounds, fitBounds, MAX_ZOOM, MIN_ZOOM, zoomAtPoint, type Point, type Viewport } from './viewport'

const DEFAULT_VIEWPORT: Viewport = { zoom: 1, panX: 0, panY: 0 }

export function useMapViewport(storageKey: string) {
  const [viewport, setViewport] = useState<Viewport>(() => {
    try { const saved = sessionStorage.getItem(storageKey); return saved ? { ...DEFAULT_VIEWPORT, ...JSON.parse(saved) as Viewport } : DEFAULT_VIEWPORT } catch { return DEFAULT_VIEWPORT }
  })
  const panRef = useRef<{ id: number; start: Point; initial: Viewport } | null>(null)
  const pointersRef = useRef(new Map<number, Point>())
  const pinchRef = useRef<{ distance: number; viewport: Viewport } | null>(null)
  const update = useCallback((next: Viewport | ((current: Viewport) => Viewport)) => setViewport((current) => {
    const value = typeof next === 'function' ? next(current) : next
    try { sessionStorage.setItem(storageKey, JSON.stringify(value)) } catch { /* visual preference only */ }
    return value
  }), [storageKey])
  const zoomBy = useCallback((factor: number, element: HTMLElement) => { const bounds = element.getBoundingClientRect(); update((current) => zoomAtPoint(current, current.zoom * factor, { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }, bounds)) }, [update])
  const onWheel = useCallback((event: ReactWheelEvent<HTMLElement>) => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); const bounds = event.currentTarget.getBoundingClientRect(); update((current) => zoomAtPoint(current, current.zoom * Math.exp(-event.deltaY * .002), { x: event.clientX, y: event.clientY }, bounds)) }, [update])
  const startBackgroundPointer = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget && !(event.target as HTMLElement).classList.contains('map-transform-layer')) return
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); event.currentTarget.setPointerCapture(event.pointerId)
    if (pointersRef.current.size === 1) panRef.current = { id: event.pointerId, start: { x: event.clientX, y: event.clientY }, initial: viewport }
    if (pointersRef.current.size === 2) { const [a, b] = [...pointersRef.current.values()]; pinchRef.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), viewport }; panRef.current = null }
  }, [viewport])
  const moveBackgroundPointer = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointersRef.current.size === 2 && pinchRef.current) { const bounds = event.currentTarget.getBoundingClientRect(), [a, b] = [...pointersRef.current.values()]; update(zoomAtPoint(pinchRef.current.viewport, pinchRef.current.viewport.zoom * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinchRef.current.distance), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, bounds)) }
    else if (panRef.current?.id === event.pointerId) update({ ...panRef.current.initial, panX: panRef.current.initial.panX + event.clientX - panRef.current.start.x, panY: panRef.current.initial.panY + event.clientY - panRef.current.start.y })
  }, [update])
  const endBackgroundPointer = useCallback((event: ReactPointerEvent<HTMLElement>) => { pointersRef.current.delete(event.pointerId); if (panRef.current?.id === event.pointerId) panRef.current = null; if (pointersRef.current.size < 2) pinchRef.current = null }, [])
  const fit = useCallback((element: HTMLElement, items: Array<{ positionX: number; positionY: number; width: number; height: number }>) => { const bounds = element.getBoundingClientRect(); update(fitBounds(contentBounds(items), bounds.width, bounds.height)) }, [update])
  return { viewport, setViewport: update, zoomBy, fit, onWheel, startBackgroundPointer, moveBackgroundPointer, endBackgroundPointer, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM }
}
