export type AppRoute = 'pos' | 'crm' | 'superadmin'

export function getAppRoute(pathname = window.location.pathname): AppRoute {
  const path = pathname.replace(/\/+$/, '')
  if (path === '/superadmin') return 'superadmin'
  return path === '/crm' ? 'crm' : 'pos'
}

export function getAppRoutePath(route: AppRoute): string {
  if (route === 'superadmin') return '/superadmin'
  return route === 'crm' ? '/crm' : '/'
}
