import type { AppVersionStatus } from '../../config/appVersion'

type AppUpdateBannerProps = {
  blocked: boolean
  status: AppVersionStatus
}

export function AppUpdateBanner({ blocked, status }: AppUpdateBannerProps) {
  if (status === 'compatible') return null

  return <aside
    aria-live="assertive"
    className="pointer-events-none fixed inset-x-3 bottom-3 z-[100] flex justify-center"
    role="alert"
  >
    <div className="flex max-w-xl flex-col items-center gap-2 rounded-2xl border border-amber-400 bg-amber-50 px-5 py-3 text-center text-sm font-medium text-amber-950 shadow-lg sm:flex-row sm:gap-3 sm:text-left">
      <span>{blocked
        ? 'Actualización pendiente. Se habilitará con conexión y sin operaciones en curso.'
        : 'Hay una actualización del TPV lista para instalar.'}</span>
      {!blocked ? <button
        className="pointer-events-auto shrink-0 rounded-xl bg-amber-950 px-3 py-2 font-semibold text-amber-50 transition hover:bg-amber-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-950"
        onClick={() => window.location.reload()}
        type="button"
      >
        Actualizar ahora
      </button> : null}
    </div>
  </aside>
}
