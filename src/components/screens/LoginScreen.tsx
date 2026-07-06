import { LogIn, WifiOff, Wifi } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { LoginInput, TenantContext } from '../../types'
import { Button, Chip } from '../ui'

type LoginScreenProps = {
  cachedContext: TenantContext | null
  error: string | null
  isBusy: boolean
  isOnline: boolean
  onLogin: (input: LoginInput) => Promise<void>
  onOfflineEnter: () => void
}

export function LoginScreen({
  cachedContext,
  error,
  isBusy,
  isOnline,
  onLogin,
  onOfflineEnter,
}: LoginScreenProps) {
  const [tenantSlug, setTenantSlug] = useState(cachedContext?.tenantSlug ?? '')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [deviceName, setDeviceName] = useState(cachedContext?.deviceName ?? 'Barra 1')

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void onLogin({
      tenantSlug: tenantSlug.trim().toLowerCase(),
      email: email.trim(),
      password,
      deviceName: deviceName.trim() || 'Barra 1',
    })
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--background)] p-4 text-[var(--foreground)]">
      <section className="w-full max-w-md rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-bold uppercase tracking-normal text-[var(--accent)]">TPV multi-tenant</p>
            <h1 className="mt-2 text-3xl font-bold text-[var(--foreground)]">Acceso de caja</h1>
          </div>
          <Chip icon={isOnline ? Wifi : WifiOff} tone={isOnline ? 'success' : 'danger'}>
            {isOnline ? 'Online' : 'Offline'}
          </Chip>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <label className="block">
            <span className="text-sm font-semibold text-[var(--muted)]">Negocio</span>
            <input
              className="mt-1 h-12 w-full rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3 text-[var(--field-foreground)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
              onChange={(event) => setTenantSlug(event.target.value)}
              placeholder="slug-del-local"
              required
              value={tenantSlug}
            />
          </label>
          <label className="block">
            <span className="text-sm font-semibold text-[var(--muted)]">Email</span>
            <input
              className="mt-1 h-12 w-full rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3 text-[var(--field-foreground)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="usuario@negocio.com"
              required
              type="email"
              value={email}
            />
          </label>
          <label className="block">
            <span className="text-sm font-semibold text-[var(--muted)]">Contrasena</span>
            <input
              className="mt-1 h-12 w-full rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3 text-[var(--field-foreground)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          <label className="block">
            <span className="text-sm font-semibold text-[var(--muted)]">Dispositivo</span>
            <input
              className="mt-1 h-12 w-full rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3 text-[var(--field-foreground)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
              onChange={(event) => setDeviceName(event.target.value)}
              required
              value={deviceName}
            />
          </label>

          {error ? (
            <div className="rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-soft)] p-3 text-sm font-semibold text-[var(--danger)]">
              {error}
            </div>
          ) : null}

          <Button disabled={!isOnline || isBusy} fullWidth size="lg" type="submit" variant="primary">
            <LogIn className="h-5 w-5" />
            Entrar
          </Button>
        </form>

        {cachedContext ? (
          <Button className="mt-3" disabled={isBusy} fullWidth onClick={onOfflineEnter} type="button" variant="secondary">
            <WifiOff className="h-5 w-5" />
            Entrar offline en {cachedContext.tenantName}
          </Button>
        ) : null}
      </section>
    </main>
  )
}
