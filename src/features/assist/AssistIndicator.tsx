import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import { Popover } from '@heroui/react'
import { CircleAlert, Info, ShieldCheck, TriangleAlert, WifiOff, X } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { supabase } from '../../lib/supabase'
import { getAssistEpisodes, getAssistJournal, saveAssistEpisodes, saveAssistJournal } from '../../lib/offlineStore'
import type { TenantContext } from '../../types'
import { AssistEngine, isAssistEnabled } from './engine'
import type { AssistSituation, AssistSnapshot } from './types'
import { createAssistScheduler } from './scheduler'

type Props = { context: TenantContext; snapshot: AssistSnapshot; isOnline: boolean; busy: boolean }

export function AssistIndicator({ context, snapshot, isOnline, busy }: Props) {
  const [situations, setSituations] = useState<AssistSituation[]>([])
  const [open, setOpen] = useState(false)
  const triggerContainer = useRef<HTMLSpanElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (triggerContainer.current?.contains(event.target) || panel.current?.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside, true)
    return () => document.removeEventListener('pointerdown', closeOutside, true)
  }, [open])
  const [initialEngine] = useState(() => { const value = new AssistEngine(); value.restore(getAssistEpisodes(context), Date.now()); return value })
  const engine = useRef(initialEngine)
  const latest = useRef({ snapshot, isOnline, busy, context })
  latest.current = { snapshot, isOnline, busy, context }
  const [initialJournal] = useState(() => getAssistJournal(context))
  const journal = useRef(initialJournal)
  const sync = useRef<(() => void) | null>(null)
  const onlineSince = useRef(isOnline ? Date.now() : Infinity)
  const wasOnline = useRef(isOnline)
  if (wasOnline.current !== isOnline) { onlineSince.current = isOnline ? Date.now() : Infinity; wasOnline.current = isOnline }

  const append = useCallback((events: AssistSituation[]) => {
    if (!events.length) return
    for (const event of events) {
      const key = `${event.episodeId}:${event.state}:${event.feedback ?? ''}`
      journal.current = journal.current.filter((item) => `${item.episodeId}:${item.state}:${item.feedback ?? ''}` !== key)
      journal.current.push(event)
    }
    // Bounded secondary journal; economic offline queue remains untouched.
    journal.current = journal.current.slice(-128)
    saveAssistJournal(context, journal.current)
  }, [context])

  useEffect(() => {
    let active = true, running = false, lastAttempt = -Infinity
    const abort = new AbortController()
    const flush = async () => {
      const current = latest.current
      if (current.snapshot.contextKey !== `${current.context.tenantId}:${current.context.venueId}`) return
      if (!active || running || !current.isOnline || current.busy || !journal.current.length || !supabase) return
      if (!isAssistEnabled(current.snapshot.configuration, current.context.features)) return
      // A reconnect must first receive the existing restaurant synchronization snapshot.
      const observedAt = Date.parse(current.snapshot.observedAt)
      if (!Number.isFinite(observedAt) || observedAt < onlineSince.current || Date.now() - observedAt > 90_000 || Date.now() - lastAttempt < 60_000) return
      running = true; lastAttempt = Date.now()
      const batch = journal.current.slice(0, 64)
      try {
        const result = await supabase.rpc('record_tickit_assist_events', {
          p_tenant_id: context.tenantId, p_venue_id: context.venueId, p_events: batch,
        }).abortSignal(abort.signal)
        if (!active || result.error) return
        const sent = new Set(batch)
        journal.current = journal.current.filter((event) => !sent.has(event))
        saveAssistJournal(context, journal.current)
      } catch { /* Secondary persistence failure is retryable and silent. */ }
      finally { running = false }
    }
    const evaluate = () => {
      if (!active || latest.current.busy || document.visibilityState !== 'visible') return
      const current = latest.current
      if (current.snapshot.contextKey !== `${current.context.tenantId}:${current.context.venueId}`) return
      if (!isAssistEnabled(current.snapshot.configuration, current.context.features)) return
      if (!Number.isFinite(Date.parse(current.snapshot.observedAt))) return
      try {
        const result = engine.current.evaluate(current.snapshot, Date.now())
        append(result.changed)
        if (result.changed.length) saveAssistEpisodes(context, result.situations)
        startTransition(() => { if (active) setSituations(result.situations) })
        if (current.isOnline && result.notifications.length) setNotice(result.notifications[0].description)
        void flush()
      } catch { /* Keep POS operational even with incomplete data/storage. */ }
    }
    const scheduler = createAssistScheduler(evaluate, window)
    sync.current = scheduler.schedule
    scheduler.schedule()
    return () => {
      active = false; sync.current = null; abort.abort(); scheduler.stop()
    }
    // Context changes remount this component, preventing cross-context engine/journal reuse.
  }, [append, context])

  const lastFingerprint = useRef('')
  useEffect(() => {
    const fingerprint = JSON.stringify([snapshot.configuration, snapshot.orders, isOnline, busy])
    if (fingerprint !== lastFingerprint.current) { lastFingerprint.current = fingerprint; sync.current?.() }
  }, [snapshot, isOnline, busy])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 8000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const feedback = (situation: AssistSituation, value: 'understood' | 'not_a_problem') => {
    if (snapshot.contextKey !== `${context.tenantId}:${context.venueId}`) return
    if (!isAssistEnabled(snapshot.configuration, context.features)) return
    const updated = engine.current.feedback(situation.key, value)
    if (!updated) return
    try { append([{ ...updated }]); sync.current?.() } catch { /* Best effort. */ }
    setSituations((current) => current.map((item) => item.key === situation.key ? { ...updated } : item))
    saveAssistEpisodes(context, situations.map((item) => item.key === situation.key ? { ...updated } : item))
  }
  const requiresAction = situations.some((situation) => situation.severity === 'ACTION')
  const requiresAttention = situations.some((situation) => situation.severity === 'ATTENTION')
  const Icon = requiresAction ? TriangleAlert : requiresAttention ? CircleAlert : situations.length ? Info : !isOnline ? WifiOff : ShieldCheck
  const tone = requiresAction ? 'text-[var(--danger)] bg-[var(--danger-soft)]' : requiresAttention ? 'text-[var(--warning)] bg-amber-500/10' : situations.length ? 'text-[var(--accent)] bg-[var(--surface-secondary)]' : !isOnline ? 'text-[var(--muted)] bg-[var(--surface-secondary)]' : 'text-[var(--success)] bg-[var(--success-soft)]'
  const status = situations.length ? `${situations.length} ${situations.length === 1 ? 'incidencia' : 'incidencias'} · ${requiresAction ? 'Requiere actuar' : requiresAttention ? 'Requiere atención' : 'Información'}` : isOnline ? 'Todo normal' : 'Sin conexión'
  return <>
    <span ref={triggerContainer} className="inline-flex shrink-0">
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Button type="button" className={`relative !size-11 !min-w-11 !shrink-0 !rounded-[12px] !p-0 ${tone}`} aria-label={`Tickit Assist · ${status}`} title={`Tickit Assist · ${status}`}>
        <Icon aria-hidden="true" className="size-5" />
        {situations.length ? <span aria-hidden="true" className="absolute -right-1 -top-1 flex min-h-5 min-w-5 items-center justify-center rounded-full bg-[var(--foreground)] px-1 text-[10px] font-bold text-[var(--surface)]">{situations.length}</span> : null}
      </Button>
      <Popover.Content ref={panel} placement="bottom end" offset={8} isNonModal className="!w-[min(420px,calc(100vw-24px))] !rounded-2xl !border !border-[var(--separator)] !bg-[var(--surface)] !text-[var(--foreground)] !shadow-xl">
        <Popover.Dialog aria-label="Tickit Assist" className="max-h-[min(70dvh,560px)] space-y-3 overflow-y-auto p-4 outline-none">
        <div className="flex items-center justify-between gap-3"><Popover.Heading className="font-bold">Tickit Assist</Popover.Heading><Button type="button" aria-label="Cerrar Tickit Assist" className="!size-11 !min-w-11 !p-0" onClick={() => setOpen(false)}><X aria-hidden="true" className="size-4" /></Button></div>
        <p className={`text-sm font-semibold ${tone.split(' ')[0]}`}>{status}</p>
        <p className="text-xs text-[var(--muted)]">Orientativo. {isOnline ? 'Datos del servicio actual.' : 'Sin conexión: última información disponible; puede estar desactualizada.'}</p>
        {!snapshot.orders.length ? <p className="text-sm">Sin mesas activas conocidas.</p> : null}
        {situations.map((situation) => <article key={situation.key} className="rounded-xl border border-[var(--separator)] p-3">
          <span className="text-xs font-semibold">{situation.severity === 'ACTION' ? 'Requiere actuar' : situation.severity === 'ATTENTION' ? 'Requiere atención' : 'Información'}</span><p className="my-2 text-sm">{situation.description}</p>
          <div className="flex flex-wrap gap-2"><Button type="button" disabled={!!situation.feedback} onClick={() => feedback(situation, 'understood')}>Entendido</Button><Button type="button" disabled={!!situation.feedback} onClick={() => feedback(situation, 'not_a_problem')}>No es un problema</Button></div>
          {situation.feedback ? <p className="mt-2 text-xs text-[var(--muted)]">Respuesta guardada</p> : null}
        </article>)}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
    </span>
    {notice ? <div role="status" className="fixed bottom-4 right-4 z-50 max-w-sm rounded-xl bg-[var(--surface)] p-4 shadow-lg">Tickit Assist · {notice}</div> : null}
  </>
}
