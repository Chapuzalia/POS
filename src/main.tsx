import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sileo'
import './index.css'
import 'sileo/styles.css'
import App from './App.tsx'
import { registerServiceWorker } from './pwa/registerServiceWorker.ts'

import * as Sentry from "@sentry/react";
import "./sentry"

registerServiceWorker()

const appleStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
const displayModeStandalone = window.matchMedia('(display-mode: standalone)').matches

if (appleStandalone || displayModeStandalone) {
  document.documentElement.classList.add('pwa-standalone')
}

const sentryFallback = (
  <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
    <h1 className="text-xl font-semibold">
      Ha ocurrido un error inesperado
    </h1>

    <p className="max-w-md text-sm text-gray-500">
      El error ha sido registrado. Recarga el TPV para continuar.
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
    <Sentry.ErrorBoundary fallback={sentryFallback}>
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
    </Sentry.ErrorBoundary>
  </StrictMode>,
)
