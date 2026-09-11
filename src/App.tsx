import { Suspense } from 'react'
import { AppShell } from './app/AppShell'
import { LoadingScreen } from './components/screens/StateScreens'
import { useAppVersionStatus } from './hooks/useAppVersionStatus'
import { useIOSPWAViewportFix } from './hooks/useIOSPWAViewportFix'
import { useOnlineStatus } from './hooks/useOnlineStatus'

/** Application composition boundary. Domain controllers live below app/. */
export default function App() {
  useIOSPWAViewportFix()
  const isOnline = useOnlineStatus()
  const versionStatus = useAppVersionStatus(isOnline)

  return <div className="h-[var(--app-height,100dvh)] min-h-0 overflow-hidden">
    <Suspense fallback={<LoadingScreen />}>
      <AppShell networkOnline={isOnline} versionStatus={versionStatus} />
    </Suspense>
  </div>
}
