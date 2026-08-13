# Routes

The application uses a small pathname router rather than React Router.

- `/` → POS → `src/app/PosPage.tsx`, orchestrated by `src/app/AppShell.tsx`.
- `/crm` → CRM → `src/components/crm/CrmPage.tsx` inside `CrmShell`.
- `/superadmin` → superadmin → `src/components/superadmin/SuperAdminPage.tsx`.

Router config (`src/app/app-routes.ts`):

```ts
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
```
