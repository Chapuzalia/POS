import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '../../components/ui/Button'
import { AppModal } from '../../components/ui/AppModal'
import { requireSupabase } from '../../services/backendService'
import type { TenantContext } from '../../types'
import { personalCacheKey, readPersonalCache, savePersonalCache } from './cache'
import { personalStateSchema } from '../../../apps/api/src/personal-contracts'
import type { PersonalState } from '../../../apps/api/src/personal-contracts'
import { verifyStaffPin, withPersonalStaff } from './permissions'

type Props = {
  context: TenantContext
  isOnline: boolean
  onLogout: () => Promise<void>
  children: (context: TenantContext, onBusyChange: (busy: boolean) => void) => ReactNode
}

export function PersonalDeviceSession({ context, isOnline, onLogout, children }: Props) {
  const cacheKey = personalCacheKey(context)
  const [state, setState] = useState<PersonalState | null>(() => readPersonalCache(localStorage, cacheKey))
  const [selected, setSelected] = useState<{ id: string; pinHash: string; connectionId: string | null } | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [employeeId, setEmployeeId] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [syncError, setSyncError] = useState('')
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const pendingState = useRef<PersonalState | null>(null)
  const setOperationBusy = useCallback((next: boolean) => {
    busyRef.current = next
    setBusy(next)
    if (!next && pendingState.current) {
      const latest = pendingState.current
      pendingState.current = null
      setState(current => JSON.stringify(current) === JSON.stringify(latest) ? current : latest)
    }
  }, [])
  const retry = useRef<(() => void) | null>(null)
  const selectionGeneration = useRef(0)
  useEffect(() => {
    let active = true
    let refreshing = false
    const refresh = async () => {
      if (!isOnline || refreshing) return
      refreshing = true
      try {
        const { data, error: failure } = await requireSupabase().rpc('tickit_personal_device_state', {
          p_tenant_id: context.tenantId, p_venue_id: context.venueId, p_device_id: context.deviceId,
        }).abortSignal(AbortSignal.timeout(10000))
        if (failure) throw failure
        const next = personalStateSchema.parse(data)
        if (!active) return
        // An unavailable backend never overwrites the last successful cache.
        savePersonalCache(localStorage, cacheKey, next)
        if (busyRef.current) pendingState.current = next
        else setState(current => JSON.stringify(current) === JSON.stringify(next) ? current : next)
        setSyncError('')
      } catch {
        if (active) setSyncError('No se pudo actualizar Personal. Se usan los datos guardados en este dispositivo.')
      } finally { refreshing = false }
    }
    retry.current = () => { void refresh() }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 30000)
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('online', refresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      active = false
      retry.current = null
      window.clearInterval(timer)
      window.removeEventListener('online', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [cacheKey, context.deviceId, context.tenantId, context.venueId, isOnline])

  const employee = state?.staff.find(item => item.employee_id === selected?.id && item.status === 'active'
    && item.venue_ids.includes(context.venueId) && state.connectionId === selected.connectionId && item.pin_verifier?.hash === selected.pinHash) ?? null
  const effectiveContext = useMemo(() => state?.enabled ? withPersonalStaff(context, employee) : context, [context, employee, state?.enabled])
  const available = state?.staff.filter(item => item.status === 'active' && item.venue_ids.includes(context.venueId)) ?? []

  async function identify() {
    if (busy || checking || !state?.enabled) return
    const candidate = available.find(item => item.employee_id === employeeId)
    if (!candidate?.pin_verifier) { setError('Configura el PIN del trabajador en Tickit Personal y sincroniza este dispositivo.'); return }
    const attemptKey = `${cacheKey}:attempts:${employeeId}`
    const generation = ++selectionGeneration.current
    setChecking(true)
    setError('')
    try {
      const saved = JSON.parse(localStorage.getItem(attemptKey) ?? '{"count":0,"until":0}') as { count: number; until: number }
      const attempts = Number.isSafeInteger(saved.count) && Number.isFinite(saved.until) && saved.until > Date.now() ? saved : { count: 0, until: Date.now() + 15 * 60000 }
      if (attempts.count >= 5) { setError('Demasiados intentos. Espera 15 minutos.'); return }
      localStorage.setItem(attemptKey, JSON.stringify({ ...attempts, count: attempts.count + 1 }))
      if (!await verifyStaffPin(candidate, pin)) { setError('PIN incorrecto.'); return }
      if (generation !== selectionGeneration.current) return
      localStorage.removeItem(attemptKey)
      setSelected({ id: candidate.employee_id, pinHash: candidate.pin_verifier.hash, connectionId: state.connectionId })
      setChoosing(false)
      setPin('')
    } catch { setError('No se pudo verificar el PIN ni guardar el acceso local. Revisa el almacenamiento del dispositivo.') }
    finally { setChecking(false) }
  }

  if (state && !state.enabled) return children(context, setOperationBusy)
  const mustIdentify = !employee
  return <div className="flex h-full min-h-0 flex-col bg-[var(--background)] text-[var(--foreground)]">
    <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--separator)] bg-[var(--surface)] px-4 py-2">
      <span className="text-sm font-bold">{employee?.full_name ?? 'Tickit Personal'}</span>
      <div className="flex items-center gap-2">
        {syncError || !isOnline ? <span role="status" className="text-xs text-[var(--muted)]">{state ? 'Permisos guardados en local' : 'Pendiente de primera sincronización'}</span> : null}
        {employee ? <Button disabled={busy || checking} onClick={() => { setChoosing(true); setPin(''); setError('') }}>Cambiar trabajador</Button> : null}
      </div>
    </div>
    <div className="min-h-0 flex-1">{state?.enabled ? children(effectiveContext, setOperationBusy) : <p className="p-6" role="status">Cargando trabajadores…</p>}</div>
    {choosing || mustIdentify ? <AppModal label="Seleccionar trabajador" dismissDisabled={mustIdentify || checking} onClose={() => { if (!mustIdentify && !checking) { selectionGeneration.current++; setChoosing(false); setPin('') } }}>
      <form className="grid gap-4 p-5" onSubmit={event => { event.preventDefault(); void identify() }}>
        <h2 className="text-lg font-bold">Seleccionar trabajador</h2>
        <label className="grid gap-1 text-sm">Trabajador<select aria-label="Trabajador" className="min-h-12 rounded border border-[var(--separator)] bg-[var(--surface)] p-3" disabled={checking} value={employeeId} onChange={event => { setEmployeeId(event.target.value); setPin(''); setError('') }} required><option value="">Selecciona un trabajador</option>{available.map(item => <option key={item.employee_id} value={item.employee_id}>{item.full_name}</option>)}</select></label>
        <label className="grid gap-1 text-sm">PIN de Tickit Personal<input className="min-h-12 rounded border border-[var(--separator)] bg-[var(--surface)] p-3" type="password" inputMode="numeric" pattern="[0-9]{6,12}" minLength={6} maxLength={12} autoComplete="off" disabled={checking} value={pin} onChange={event => setPin(event.target.value)} required /></label>
        {error ? <p role="alert" className="text-sm text-[var(--danger)]">{error}</p> : null}
        {syncError ? <p role="status" className="text-sm text-[var(--muted)]">{syncError}</p> : null}
        {state && !available.length ? <p role="status" className="text-sm">No hay trabajadores sincronizados para este local. Revisa la vinculación y las asignaciones en Personal.</p> : null}
        <Button type="submit" disabled={checking || busy || !employeeId}>{checking ? 'Verificando…' : 'Entrar'}</Button>
        <div className="flex flex-wrap gap-2"><Button type="button" disabled={!isOnline} onClick={() => retry.current?.()}>Actualizar trabajadores</Button>{mustIdentify ? <Button type="button" onClick={() => void onLogout()}>Salir del dispositivo</Button> : <Button type="button" disabled={checking} onClick={() => { setChoosing(false); setPin('') }}>Cancelar</Button>}</div>
      </form>
    </AppModal> : null}
  </div>
}
