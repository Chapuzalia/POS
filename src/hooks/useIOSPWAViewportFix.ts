import { useEffect } from 'react'

const KEYBOARD_HEIGHT_THRESHOLD = 120
const RETRY_DELAY_MS = 180

type AppleNavigator = Navigator & {
  standalone?: boolean
}

function isIOSOrIPadOS(navigatorValue: Navigator) {
  return /iPad|iPhone|iPod/i.test(navigatorValue.userAgent)
    || (navigatorValue.platform === 'MacIntel' && navigatorValue.maxTouchPoints > 1)
}

function isStandalonePWA(navigatorValue: AppleNavigator) {
  return navigatorValue.standalone === true
    || window.matchMedia('(display-mode: standalone)').matches
}

function isKeyboardOpen(viewport: VisualViewport) {
  return window.innerHeight - viewport.height > KEYBOARD_HEIGHT_THRESHOLD
}

function isEditableElement(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return target.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
}

/**
 * Workaround for a WebKit bug in installed iOS/iPadOS PWAs: after the software
 * keyboard closes, the visual viewport can look restored while WebKit keeps an
 * obsolete vertical offset for hit testing.
 */
export function useIOSPWAViewportFix() {
  useEffect(() => {
    const appleNavigator = navigator as AppleNavigator
    const viewport = window.visualViewport

    if (!viewport || !isIOSOrIPadOS(navigator) || !isStandalonePWA(appleNavigator)) return undefined

    const root = document.documentElement
    const animationFrames = new Set<number>()
    const timeouts = new Set<number>()
    let keyboardWasOpen = isKeyboardOpen(viewport)
    let disposed = false

    root.classList.add('ios-pwa-viewport-fix')

    const logViewport = (reason: string) => {
      if (!import.meta.env.DEV) return
      console.debug('[iOS PWA viewport fix]', reason, {
        innerHeight: window.innerHeight,
        visualViewportHeight: viewport.height,
        visualViewportOffsetTop: viewport.offsetTop,
        visualViewportPageTop: viewport.pageTop,
        windowScrollY: window.scrollY,
        documentElementScrollTop: document.documentElement.scrollTop,
        bodyScrollTop: document.body.scrollTop,
        activeElement: document.activeElement,
        displayModeStandalone: window.matchMedia('(display-mode: standalone)').matches,
      })
    }

    const updateAppHeight = () => {
      root.style.setProperty('--app-height', `${viewport.height}px`)
    }

    const repairViewport = (reason: string) => {
      if (disposed) return
      updateAppHeight()
      window.scrollTo(0, 0)
      document.documentElement.scrollTop = 0
      document.body.scrollTop = 0
      logViewport(reason)
    }

    const requestFrame = (callback: FrameRequestCallback) => {
      const id = window.requestAnimationFrame((timestamp) => {
        animationFrames.delete(id)
        callback(timestamp)
      })
      animationFrames.add(id)
      return id
    }

    const requestTimeout = (callback: () => void, delay: number) => {
      const id = window.setTimeout(() => {
        timeouts.delete(id)
        callback()
      }, delay)
      timeouts.add(id)
      return id
    }

    const scheduleRepair = (reason: string) => {
      // Two frames let WebKit finish reconciling its layout and visual viewports.
      requestFrame(() => requestFrame(() => repairViewport(`${reason}:animation-frame`)))
      // Older WebKit builds publish the final viewport metrics after the frame.
      requestTimeout(() => repairViewport(`${reason}:delayed-retry`), RETRY_DELAY_MS)
    }

    const handleViewportChange = () => {
      const keyboardIsOpen = isKeyboardOpen(viewport)
      updateAppHeight()
      if (keyboardWasOpen && !keyboardIsOpen) scheduleRepair('keyboard-closed')
      keyboardWasOpen = keyboardIsOpen
    }

    const handleFocusOut = (event: FocusEvent) => {
      if (isEditableElement(event.target)) scheduleRepair('editable-focusout')
    }

    const handlePageShow = () => scheduleRepair('pageshow')
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') scheduleRepair('visibility-visible')
    }

    updateAppHeight()
    viewport.addEventListener('resize', handleViewportChange)
    viewport.addEventListener('scroll', handleViewportChange)
    document.addEventListener('focusout', handleFocusOut)
    window.addEventListener('pageshow', handlePageShow)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      disposed = true
      viewport.removeEventListener('resize', handleViewportChange)
      viewport.removeEventListener('scroll', handleViewportChange)
      document.removeEventListener('focusout', handleFocusOut)
      window.removeEventListener('pageshow', handlePageShow)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      animationFrames.forEach((id) => window.cancelAnimationFrame(id))
      timeouts.forEach((id) => window.clearTimeout(id))
      animationFrames.clear()
      timeouts.clear()
      root.classList.remove('ios-pwa-viewport-fix')
      root.style.removeProperty('--app-height')
    }
  }, [])
}
