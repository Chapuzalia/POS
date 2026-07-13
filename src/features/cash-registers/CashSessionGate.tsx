import { useState } from 'react'
import type { CashRegister, CashSession, TenantContext } from '../../types'
import { formatMoney, parseMoneyToCents } from '../../lib/format'

type Props = {
  context: TenantContext
  isBusy: boolean
  isOnline: boolean
  registers: CashRegister[]
  sessions: CashSession[]
  onJoin: (session: CashSession) => void
  onLogout: () => void
  onOpen: (registerId: string, openingFloatCents: number) => Promise<void>
  onRefresh: () => void
}

export function CashSessionGate({ context, isBusy, isOnline, onJoin, onLogout, onOpen, onRefresh, registers, sessions }: Props) {
  const openRegisterIds = new Set(sessions.map((session) => session.cashRegisterId))
  const available = registers.filter((register) => register.isActive && !openRegisterIds.has(register.id))
  const [registerId, setRegisterId] = useState(context.defaultCashRegisterId ?? available[0]?.id ?? '')
  const [openingFloat, setOpeningFloat] = useState('0.00')
  const canOpen = context.canOpenCashSession === true && context.deviceMode !== 'satellite'
  return (
    <main className="min-h-screen bg-[var(--background)] p-4 text-[var(--foreground)]">
      <section className="mx-auto mt-[8vh] w-full max-w-2xl space-y-5 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-6 shadow-[var(--shadow)]">
        <div><h1 className="text-2xl font-black">{sessions.length ? 'Cajas abiertas' : 'No hay ninguna caja abierta'}</h1><p className="mt-2 text-[var(--muted)]">{sessions.length ? 'Selecciona la caja con la que vas a trabajar.' : canOpen ? 'Abre un punto de caja para comenzar.' : 'Abre una caja desde un dispositivo autorizado para comenzar a trabajar.'}</p></div>
        {sessions.length ? <div className="grid gap-3">{sessions.map((session) => <button className="min-h-16 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface-secondary)] p-4 text-left hover:border-[var(--accent)]" disabled={isBusy || !isOnline} key={session.id} onClick={() => onJoin(session)} type="button"><strong className="block">{session.cashRegisterName}</strong><span className="text-sm text-[var(--muted)]">Abierta {new Date(session.openedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })} - Fondo {formatMoney(session.openingFloatCents)}</span></button>)}</div> : null}
        {canOpen ? <form className="space-y-3 border-t border-[var(--separator)] pt-5" onSubmit={(event) => { event.preventDefault(); void onOpen(registerId, parseMoneyToCents(openingFloat)) }}><h2 className="font-black">Abrir nueva caja</h2><select className="min-h-12 w-full rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3" disabled={!available.length || isBusy} onChange={(event) => setRegisterId(event.target.value)} value={registerId}>{available.map((register) => <option key={register.id} value={register.id}>{register.name}</option>)}</select><input className="min-h-12 w-full rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3" inputMode="decimal" onChange={(event) => setOpeningFloat(event.target.value)} value={openingFloat} /><button className="min-h-12 w-full rounded-[var(--radius)] bg-[var(--accent)] font-bold text-[var(--accent-foreground)] disabled:opacity-45" disabled={!isOnline || isBusy || !registerId || !available.length} type="submit">{available.length ? 'Abrir caja' : 'Todos los puntos de caja ya estan abiertos'}</button></form> : null}
        <div className="grid grid-cols-2 gap-3"><button className="min-h-11 rounded-[var(--radius)] border border-[var(--separator)]" disabled={isBusy || !isOnline} onClick={onRefresh} type="button">Comprobar de nuevo</button><button className="min-h-11 rounded-[var(--radius)] border border-[var(--separator)]" onClick={onLogout} type="button">Cerrar sesion</button></div>
      </section>
    </main>
  )
}
