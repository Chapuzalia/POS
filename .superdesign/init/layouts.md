# Shared layouts

## `src/features/crm/layout/CrmShell.tsx`

Desktop/mobile CRM shell: dark sidebar, white top bar, cool-gray content canvas, and a centered scrollable content region. Full source is kept in `src/features/crm/layout/CrmShell.tsx`; its render structure is:

```tsx
return (
  <div className="crm-shell !flex !h-full !min-h-0 !w-screen !overflow-hidden !bg-[var(--crm-canvas)] !text-[var(--crm-text)] !antialiased" data-crm-theme={crmTheme} data-theme={crmTheme}>
    <CrmSidebar {...sidebarProps} />
    <section className="!flex !min-h-0 !min-w-0 !flex-1 !flex-col !overflow-hidden !bg-[var(--crm-canvas)]">
      <header className="!relative !z-30 !flex !min-h-16 !items-center !justify-between !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-topbar-bg)] !px-4 md:!min-h-20 md:!px-7">
        {/* page title, venue selector, online state and account */}
      </header>
      <main className="!mx-auto !min-h-0 !w-full !max-w-[1720px] !flex-1 !overflow-auto !px-4 !pt-[26px] !pb-7 md:!px-7 md:!pt-[42px] md:!pb-9">{children}</main>
    </section>
  </div>
)
```

## Superadmin shell

`src/components/superadmin/SuperAdminPage.tsx` is self-contained and reuses the CRM visual language. It renders a fixed dark sidebar, white top bar, cool-gray canvas, tenant table, and portal-based `SuperAdminModal`. The feature assignment target is inside the edit modal at the `Features del negocio` section.

## `src/app/AppRouter.tsx`

```tsx
import { useEffect, useState } from 'react'
import type { TenantContext } from '../types'
import { getRequiredAppRoute } from './app-permissions'
import { getAppRoute, getAppRoutePath, type AppRoute } from './app-routes'
import { moveSupabaseSessionToRoute } from '../lib/supabase'

type AppRouterProps = { context: TenantContext | null; children: (route: AppRoute) => React.ReactNode }

export function AppRouter({ context, children }: AppRouterProps) {
  const [route, setRoute] = useState<AppRoute>(() => getAppRoute())
  useEffect(() => { const handlePopState = () => setRoute(getAppRoute()); window.addEventListener('popstate', handlePopState); return () => window.removeEventListener('popstate', handlePopState) }, [])
  useEffect(() => { if (!context) return; const requiredRoute = getRequiredAppRoute(context); if (route !== requiredRoute) { moveSupabaseSessionToRoute(requiredRoute); window.location.replace(getAppRoutePath(requiredRoute)) } }, [context, route])
  return children(route)
}
```
