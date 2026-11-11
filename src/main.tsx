import './lib/browserCrypto.ts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import { Toaster } from 'sileo'
import { AppErrorBoundary } from './components/errors/AppErrorBoundary.tsx'
import './index.css'
import 'sileo/styles.css'
import App from './App.tsx'
import { registerServiceWorker } from './pwa/registerServiceWorker.ts'
import { listenForNativeDeepLinks, restoreDeepLinkRoute } from './app/nativeDeepLinks.ts'

registerServiceWorker()

if (
  import.meta.env.VITE_SENTRY_ENABLED === 'true'
  && Boolean(import.meta.env.VITE_SENTRY_DSN)
) {
  await import('./sentry.ts').catch(() => { /* The POS remains usable if telemetry cannot load. */ })
}

const appleStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
const displayModeStandalone = window.matchMedia('(display-mode: standalone)').matches

// Native shells are full-screen like an installed PWA, so they need the same safe-area chrome.
if (appleStandalone || displayModeStandalone || Capacitor.isNativePlatform()) {
  document.documentElement.classList.add('pwa-standalone')
}

if (Capacitor.isNativePlatform()) {
  restoreDeepLinkRoute()
  void listenForNativeDeepLinks().catch(() => { /* sin enlaces profundos la app sigue funcionando */ })
}

const sentryFallback = (
  <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
    <h1 className="text-xl font-semibold">
      Ha ocurrido un error inesperado
    </h1>

    <p className="max-w-md text-sm text-gray-500">
      Recarga el TPV para continuar. Si el problema persiste, contacta con el responsable.
    </p>

    <button
      type="button"
      className="rounded-lg bg-black px-4 py-2 text-white"
      onClick={() => window.location.reload()}
    >
      Recargar TPV
    </button>
  </div>
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary fallback={sentryFallback}>
      <App />
      <Toaster
        position="top-center"
        options={{
          fill: "#FFFFFF",
          roundness: 16,
          styles: {
            title: "text-black!",
            description: "text-black/75!",
            badge: "bg-white/10!",
            button: "bg-white/10! hover:bg-white/15!",
          },
        }}
      />
    </AppErrorBoundary>
  </StrictMode>,
)
