export function MissingConfigScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--background)] p-4 text-[var(--foreground)]">
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

export function LoadingScreen() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--background)] p-4 text-[var(--foreground)]">
      <section className="w-full max-w-md rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
        <h1 className="text-2xl font-bold">Cargando TPV</h1>
        <p className="mt-2 text-[var(--muted)]">Conectando con Supabase y preparando caja.</p>
      </section>
    </main>
  )
}
