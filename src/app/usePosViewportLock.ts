import { useEffect } from 'react'

const gestureEvents = ['gesturestart', 'gesturechange', 'gestureend'] as const

export function usePosViewportLock() {
  useEffect(() => {
    const root = document.documentElement
    const body = document.body
    const preventGesture = (event: Event) => event.preventDefault()
    const preventNativePinch = (event: TouchEvent) => {
      if (event.touches.length > 1) event.preventDefault()
    }

    root.classList.add('pos-viewport-locked')
    body.classList.add('pos-viewport-locked')
    gestureEvents.forEach((eventName) => document.addEventListener(eventName, preventGesture, { passive: false }))
    document.addEventListener('touchmove', preventNativePinch, { passive: false })

    return () => {
      root.classList.remove('pos-viewport-locked')
      body.classList.remove('pos-viewport-locked')
      gestureEvents.forEach((eventName) => document.removeEventListener(eventName, preventGesture))
      document.removeEventListener('touchmove', preventNativePinch)
    }
  }, [])
}
