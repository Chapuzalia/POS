import { LogIn, WifiOff, Wifi } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import type { LoginInput, TenantContext } from '../../types'
import { Button, Chip } from '../ui'

const rememberedEmailKey = 'club-pos:remembered-email'

function getRememberedEmail() {
  try {
    return window.localStorage.getItem(rememberedEmailKey) ?? ''
  } catch {
    return ''
  }
}

function saveRememberedEmail(email: string, shouldRemember: boolean) {
  try {
    if (shouldRemember) {
      window.localStorage.setItem(rememberedEmailKey, email)
    } else {
      window.localStorage.removeItem(rememberedEmailKey)
    }
  } catch {
    // El acceso debe seguir funcionando aunque el navegador bloquee el almacenamiento local.
  }
}

type LoginScreenProps = {
  allowOfflineEnter: boolean
  cachedContext: TenantContext | null
  error: string | null
  isBusy: boolean
  isOnline: boolean
  onLogin: (input: LoginInput) => Promise<void>
  onOfflineEnter: () => void
}

export function LoginScreen({
  allowOfflineEnter,
  cachedContext,
  error,
  isBusy,
  isOnline,
  onLogin,
  onOfflineEnter,
}: LoginScreenProps) {
  const [email, setEmail] = useState(getRememberedEmail)
  const [password, setPassword] = useState('')
  const [rememberAccount, setRememberAccount] = useState(() => Boolean(getRememberedEmail()))

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedEmail = email.trim()
    saveRememberedEmail(normalizedEmail, rememberAccount)
    void onLogin({
      email: normalizedEmail,
      password,
    })
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--background)] p-4 text-[var(--foreground)]">
      <section className="w-full max-w-md rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-bold uppercase tracking-normal text-[var(--accent)]">TPV multi-tenant</p>
            <h1 className="mt-2 text-3xl font-bold text-[var(--foreground)]">Acceso al negocio</h1>
          </div>
          <Chip icon={isOnline ? Wifi : WifiOff} tone={isOnline ? 'success' : 'danger'}>
            {isOnline ? 'Online' : 'Offline'}
          </Chip>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <label className="block">
            <span className="text-sm font-semibold text-[var(--muted)]">Email</span>
            <input
              className="mt-1 h-12 w-full rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3 text-[var(--field-foreground)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
              autoComplete="username"
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
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-semibold text-[var(--foreground)]">
            <input
              checked={rememberAccount}
              className="h-5 w-5 rounded border-[var(--field-border)] accent-[var(--accent)]"
              onChange={(event) => setRememberAccount(event.target.checked)}
              type="checkbox"
            />
            Recordar cuenta
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

        {allowOfflineEnter && cachedContext?.role === 'cashier' ? (
          <Button className="mt-3" disabled={isBusy} fullWidth onClick={onOfflineEnter} type="button" variant="secondary">
            <WifiOff className="h-5 w-5" />
            Entrar offline en {cachedContext.tenantName}
          </Button>
        ) : null}
      </section>
    </main>
  )
}
