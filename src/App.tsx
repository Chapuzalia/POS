import { Suspense } from 'react'
import { AppShell } from './app/AppShell'
import { LoadingScreen } from './components/screens/StateScreens'
import { useIOSPWAViewportFix } from './hooks/useIOSPWAViewportFix'

/** Application composition boundary. Domain controllers live below app/. */
export default function App() {
  useIOSPWAViewportFix()

  return <div className="h-[var(--app-height,100dvh)] min-h-0 overflow-hidden">
    <Suspense fallback={<LoadingScreen />}>
      <AppShell />
    </Suspense>
  </div>
}
