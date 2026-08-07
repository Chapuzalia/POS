import { useEffect, useState, type ReactNode } from 'react'

export function MissingConfigScreen() {
  return (
    <main className="flex h-full overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] items-center justify-center bg-[var(--background)] p-4 text-[var(--foreground)]">
      <section className="w-full max-w-xl rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
        <p className="text-sm font-bold uppercase tracking-normal text-[var(--danger)]">Falta configuracion</p>
        <h1 className="mt-2 text-3xl font-bold">Conecta Supabase</h1>
        <p className="mt-3 text-[var(--muted)]">
          Crea un archivo <code className="rounded bg-[var(--surface-secondary)] px-1.5 py-0.5">.env.local</code> a partir de{' '}
          <code className="rounded bg-[var(--surface-secondary)] px-1.5 py-0.5">.env.example</code> y define:
        </p>
        <div className="mt-4 space-y-2 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-4 font-mono text-sm">
          <p>VITE_SUPABASE_URL</p>
          <p>VITE_SUPABASE_ANON_KEY</p>
        </div>
      </section>
    </main>
  )
}

type LoadingScreenProps = {
  isExiting?: boolean
  onExitComplete?: () => void
}

export function LoadingScreen({ isExiting = false, onExitComplete }: LoadingScreenProps) {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className={`relative isolate flex h-full min-h-0 w-full items-center justify-center overflow-hidden bg-[var(--background)] px-6 py-10 text-[var(--foreground)] ${isExiting ? 'animate-[pos-loading-exit_520ms_cubic-bezier(.4,0,.2,1)_forwards] motion-reduce:animate-none' : ''}`}
      onAnimationEnd={(event) => {
        if (isExiting && event.currentTarget === event.target) onExitComplete?.()
      }}
      role="status"
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <span className="absolute left-1/2 top-1/2 size-[min(78vw,36rem)] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--accent-soft)] opacity-55 blur-3xl animate-[pos-loading-glow_2.8s_ease-in-out_infinite] motion-reduce:animate-none" />
        <span className="absolute -left-24 -top-24 size-72 rounded-full border border-[var(--separator)] opacity-60" />
        <span className="absolute -bottom-36 -right-24 size-96 rounded-full border border-[var(--separator)] opacity-50" />
      </div>

      <div className="relative z-10 flex w-full max-w-lg flex-col items-center text-center">
        <div aria-hidden="true" className="relative grid size-36 place-items-center">
          <span className="absolute inset-0 rounded-full border border-[var(--separator)]" />
          <span className="absolute inset-2 rounded-full border-2 border-transparent border-r-[var(--accent)] border-t-[var(--accent)] animate-[pos-loading-orbit_1.45s_linear_infinite] motion-reduce:animate-none" />
          <span className="absolute inset-5 rounded-full border border-transparent border-b-[var(--muted)] border-l-[var(--muted)] animate-[pos-loading-orbit_2.2s_linear_infinite_reverse] opacity-55 motion-reduce:animate-none" />
          <span className="grid size-20 place-items-center rounded-[1.75rem] bg-[var(--accent)] text-xl font-black tracking-[0.18em] text-[var(--accent-foreground)] shadow-[0_18px_50px_color-mix(in_srgb,var(--accent)_32%,transparent)] animate-[pos-loading-mark_1.8s_ease-in-out_infinite] motion-reduce:animate-none">
            <img src="/icons/apple-touch-icon.png" alt="TickIT"className="h-full w-full rounded-[1.75rem]" />
          </span>
        </div>

        <p className="mt-8 text-xs font-black uppercase tracking-[0.24em] text-[var(--accent)]">Preparando tu espacio</p>
        <h1 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">Cargando TickIT</h1>
        <p className="mt-3 max-w-sm text-sm font-medium text-[var(--muted)] sm:text-base">
          Sincronizando el catálogo y preparando la caja.
        </p>

        <div aria-hidden="true" className="mt-8 h-1 w-full max-w-56 overflow-hidden rounded-full bg-[var(--surface-secondary)]">
          <span className="block h-full w-2/5 rounded-full bg-[var(--accent)] animate-[pos-loading-progress_1.15s_ease-in-out_infinite] motion-reduce:animate-none" />
        </div>
      </div>
    </div>
  )
}

type PosStartupRevealProps = {
  children: ReactNode
}

export function PosStartupReveal({ children }: PosStartupRevealProps) {
  const [isRevealing, setIsRevealing] = useState(false)
  const [showLoadingScreen, setShowLoadingScreen] = useState(true)

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShowLoadingScreen(false)
      return undefined
    }

    const frame = window.requestAnimationFrame(() => setIsRevealing(true))
    const fallback = window.setTimeout(() => setShowLoadingScreen(false), 700)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(fallback)
    }
  }, [])

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <div
        aria-hidden={showLoadingScreen ? true : undefined}
        className={`h-full min-h-0 origin-center ${isRevealing ? 'animate-[pos-shell-zoom-in_560ms_cubic-bezier(.16,1,.3,1)_both] motion-reduce:animate-none' : ''}`}
      >
        {children}
      </div>
      {showLoadingScreen ? (
        <div className="absolute inset-0 z-[100]">
          <LoadingScreen isExiting={isRevealing} onExitComplete={() => setShowLoadingScreen(false)} />
        </div>
      ) : null}
    </div>
  )
}
