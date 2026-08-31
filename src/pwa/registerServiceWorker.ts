export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return

  window.addEventListener(
    'load',
    () => {
      void navigator.serviceWorker
        .register('/sw.js', {
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
