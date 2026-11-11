import { APP_VERSION } from '../config/appVersion'
import { Capacitor } from '@capacitor/core'

export function registerServiceWorker() {
  // Native builds bundle their assets; a SW would serve stale code after an APK update.
  if (!import.meta.env.PROD || Capacitor.isNativePlatform() || !('serviceWorker' in navigator)) return

  window.addEventListener(
    'load',
    () => {
      void navigator.serviceWorker
        .register(`/sw.js?v=${encodeURIComponent(APP_VERSION)}`, {
          scope: '/',
          updateViaCache: 'none',
        })
        .catch((error: unknown) => {
          console.error('[PWA] No se pudo registrar el service worker', error)
        })
    },
    { once: true },
  )
}
