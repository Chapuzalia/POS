import { useEffect, useState } from 'react'
import type { TenantContext } from '../types'
import { getRequiredAppRoute } from './app-permissions'
import { getAppRoute, getAppRoutePath, type AppRoute } from './app-routes'

type AppRouterProps = {
  context: TenantContext | null
  children: (route: AppRoute) => React.ReactNode
}

export function AppRouter({ context, children }: AppRouterProps) {
  const [route, setRoute] = useState<AppRoute>(() => getAppRoute())

  useEffect(() => {
    const handlePopState = () => setRoute(getAppRoute())
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    if (!context) return
    const requiredRoute = getRequiredAppRoute(context)
    if (route !== requiredRoute) {
      window.history.replaceState(null, '', getAppRoutePath(requiredRoute))
      setRoute(requiredRoute)
    }
  }, [context, route])

  return children(route)
}
