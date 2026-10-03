import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { CashSession, TenantContext } from '../../../types'
import { AppModal } from '../../../components/ui/AppModal'
import { Button } from '../../../components/ui/Button'
import { getReadableError } from '../../../utils/errors'
import { FiscalIdentityMissingError } from './localIdentity.ts'
import { activateFiscalInstallation, latestFiscalInstallation, loadFiscalInstallation, FiscalActivationConfirmationError } from './installation.ts'
import { FISCAL_SETTINGS_CHANGED, loadFiscalPosSettings } from './settings.ts'
import { localFiscalMode } from './mode.ts'

type Props = { context: TenantContext; cashSession: CashSession | null; children: ReactNode; onLogout: () => Promise<void>; onBusyChange?: (busy: boolean) => void }

/** All checkout entry points remain behind the same local identity gate. */
export function FiscalInstallationGate({ context, cashSession, children, onLogout, onBusyChange }: Props) {
  const [ready, setReady] = useState(false)
  const [missing, setMissing] = useState(false)
  const [preview, setPreview] = useState<{ id: string; number: string } | null>(null)
  const [previewReady, setPreviewReady] = useState(false)
  const [testRecovery, setTestRecovery] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const scopeRef = useRef({ context, cashSession })
  scopeRef.current = { context, cashSession }

  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false) }, [busy, onBusyChange])

  useEffect(() => {
    if (!missing || ready || busy) return
    const refresh = () => { if (document.visibilityState === 'visible') setAttempt(value => value + 1) }
    const changed = (event: Event) => {
      if (event instanceof CustomEvent && event.detail !== context.tenantId) return
      refresh()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener(FISCAL_SETTINGS_CHANGED, changed)
    window.addEventListener('storage', refresh)
    const timer = window.setInterval(refresh, 15000)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener(FISCAL_SETTINGS_CHANGED, changed)
      window.removeEventListener('storage', refresh)
      window.clearInterval(timer)
    }
  }, [missing, ready, busy, context.tenantId])

  useEffect(() => {
    let alive = true
    async function check() {
      const { context, cashSession } = scopeRef.current
      setBusy(true); setError(null); setPreviewReady(false)
      if (!cashSession) { setBusy(false); return }
      if (localFiscalMode() === 'disabled') { if (alive) { setReady(true); setBusy(false) }; return }
      try {
        await loadFiscalInstallation(context, cashSession)
        if (alive) setReady(true)
      } catch (failure) {
        if (!alive) return
        if (failure instanceof FiscalIdentityMissingError) {
          setMissing(true)
          try {
            const [latest, settings] = await Promise.all([
              latestFiscalInstallation(context, cashSession), loadFiscalPosSettings(context.tenantId, false),
            ])
            if (alive) { setPreview(latest); setTestRecovery(settings.aeat_environment === 'test'); setPreviewReady(true) }
          } catch (previewError) { if (alive) setError(getReadableError(previewError)) }
        } else setError(getReadableError(failure))
      } finally { if (alive) setBusy(false) }
    }
    void check()
    return () => { alive = false }
  }, [context.tenantId, context.venueId, context.deviceId, context.userId, cashSession?.id, cashSession?.cashRegisterId, attempt])

  async function activate(recover: boolean) {
    if (!cashSession) return
    setBusy(true); setError(null)
    try {
      await activateFiscalInstallation(context, cashSession, preview?.id ?? null, recover)
      setReady(true)
    } catch (failure) {
      setError(getReadableError(failure))
      if (failure instanceof FiscalActivationConfirmationError) setPreviewReady(false)
    }
    finally { setBusy(false) }
  }

  if (!cashSession || ready) return children
  return <AppModal label="Instalación fiscal de esta PWA" maxWidth={620} dismissDisabled onClose={() => {}}>
    <div className="grid max-h-[calc(100dvh-48px)] gap-4 overflow-y-auto p-6">
      <h2 className="m-0 text-xl font-semibold">{missing ? 'Activar instalación fiscal' : 'Comprobar instalación fiscal'}</h2>
      {missing ? <>
        <p>Esta PWA no tiene identidad fiscal local. Se creará una instalación nueva para esta caja, con otro número fiscal y una cadena nueva.</p>
        {preview ? <p>La instalación anterior <strong>{preview.number}</strong> quedará retirada para nuevas emisiones. Su historial se conservará.</p> : null}
        <p>Antes de continuar, deja de utilizar el dispositivo anterior. Si está offline, no conocerá la retirada y podrá seguir generando ventas locales; esas operaciones nuevas serán rechazadas al sincronizar. Es tu responsabilidad dejar de operar con la instalación anterior. Los registros emitidos antes del reemplazo podrán sincronizarse pendientes.</p>
        <p>Necesitas conexión con Supabase y almacenamiento local correcto para completar la activación.</p>
      </> : <p>La emisión permanecerá bloqueada hasta comprobar la identidad y su ledger. Si existen datos incompletos, requieren recuperación o conciliación.</p>}
      {error ? <p role="alert" className="text-[var(--danger)]">{error}</p> : null}
      {testRecovery && preview ? <p className="text-sm">Solo para pruebas: recuperar la última instalación conserva sus números y cadena confirmada. No utilices dos dispositivos a la vez; los registros que solo estén en el otro dispositivo no se pueden recuperar desde Supabase.</p> : null}
      <div className="flex flex-wrap gap-3">
        {missing ? <Button className="!min-h-11" variant="primary" disabled={busy || !previewReady} onClick={() => void activate(false)}>Crear nueva instalación</Button> : null}
        {missing && testRecovery && preview ? <Button className="!min-h-11 !h-auto !max-w-full !whitespace-normal !py-3" variant="secondary" disabled={busy || !previewReady} onClick={() => void activate(true)}>Recuperar última instalación válida (pruebas)</Button> : null}
        <Button className="!min-h-11" disabled={busy} onClick={() => setAttempt(value => value + 1)}>Reintentar comprobación</Button>
        <Button className="!min-h-11" disabled={busy} onClick={() => void onLogout()}>Cerrar sesión</Button>
      </div>
    </div>
  </AppModal>
}
