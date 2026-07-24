import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sileo'
import './index.css'
import 'sileo/styles.css'
import App from './App.tsx'

const appleStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
const displayModeStandalone = window.matchMedia('(display-mode: standalone)').matches

if (appleStandalone || displayModeStandalone) {
  document.documentElement.classList.add('pwa-standalone')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
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
  </StrictMode>,
)
