import { Input as UiInput } from '../../../components/ui/Input'
import { Button as UiButton } from '../../../components/ui/Button'
import { AppModal } from '../../../components/ui/AppModal'
import { CalendarDays, Clock3, Edit3, Mail, Phone, UserCheck, Users, Utensils, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { getAllowedReservationActions, getReservationStatusLabel, reservationTimingLabel } from '../domain/reservationStatus'
import type { Reservation, ReservationStatus } from '../types'

type Props = {
  canManage: boolean
  disabled: boolean
  onClose: () => void
  onEdit: () => void
  onOpenOrder: (orderId: string) => void
  onSeat: () => void
  onStatus: (status: ReservationStatus, reason?: string) => void
  reservation: Reservation
}

export function ReservationDetailPanel(props: Props) {
  const { reservation } = props
  const actions = getAllowedReservationActions(reservation)
  const [confirmation, setConfirmation] = useState<'cancelled' | 'no_show' | null>(null)
  const [reason, setReason] = useState('')
  const duration = Math.round((new Date(reservation.endsAt).getTime() - new Date(reservation.startsAt).getTime()) / 60_000)
  const date = new Intl.DateTimeFormat('es', { dateStyle: 'full' }).format(new Date(reservation.startsAt))
  const time = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(new Date(reservation.startsAt))
  const timing = reservationTimingLabel(reservation)

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (confirmation) setConfirmation(null)
      else props.onClose()
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [confirmation, props])

  return (
    <>
      <aside aria-label={`Reserva de ${reservation.customerName}`} className="flex w-[min(420px,38vw)] min-w-[350px] flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] shadow-[var(--shadow)] [&_svg]:size-[18px] [&>header]:flex [&>header]:items-start [&>header]:justify-between [&>header]:gap-3 [&>header]:border-b [&>header]:border-[var(--separator)] [&>header]:p-[18px] [&_h2]:mt-[7px] [&_h2]:mb-0 [&_h2]:text-[22px] [&_dl]:m-0 [&_dl]:grid [&_dl]:gap-3 [&_dl>div]:grid [&_dl>div]:grid-cols-[110px_minmax(0,1fr)] [&_dl>div]:gap-3 [&_dt]:flex [&_dt]:items-center [&_dt]:gap-[7px] [&_dt]:font-semibold [&_dt]:text-[var(--muted)] [&_dd]:m-0 [&_dd]:font-extrabold [&_section]:grid [&_section]:gap-2 [&_section]:border-t [&_section]:border-[var(--separator)] [&_section]:pt-4 [&_section_h3]:m-0 [&_section_h3]:text-[13px] [&_section_h3]:uppercase [&_section_p]:m-0 [&_section_p]:leading-6 [&_section_p]:text-[var(--muted)] [&_section_a]:flex [&_section_a]:min-h-[38px] [&_section_a]:items-center [&_section_a]:gap-2 [&_section_a]:font-extrabold [&_section_a]:text-[var(--foreground)] [&_section_a]:no-underline [&>footer]:mt-auto [&>footer]:grid [&>footer]:gap-2.5 [&>footer]:border-t [&>footer]:border-[var(--separator)] [&>footer]:p-4 [&>footer>div]:grid [&>footer>div]:grid-cols-2 [&>footer>div]:gap-2 max-[1000px]:fixed max-[1000px]:z-40 max-[1000px]:inset-[72px_0_0_auto] max-[1000px]:w-[min(440px,100%)] max-[1000px]:min-w-0 max-[1000px]:rounded-[var(--radius)_0_0_0] max-[760px]:inset-[100px_0_0] max-[760px]:w-full max-[760px]:rounded-t-[18px] max-[760px]:rounded-b-none">
        <header>
          <div>
            <span className="inline-flex w-fit items-center rounded-full bg-[var(--accent-soft)] px-[9px] py-1 text-[11px] font-extrabold">{getReservationStatusLabel(reservation.status)}</span>
            <h2>{reservation.customerName}</h2>
          </div>
          <UiButton aria-label="Cerrar detalle" className="grid size-11 shrink-0 place-items-center rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] text-[var(--foreground)] [&_svg]:size-[18px]" onClick={props.onClose} type="button"><X /></UiButton>
        </header>
        <div className="grid content-start gap-[18px] overflow-auto p-[18px]">
          <dl>
            <div><dt><CalendarDays /> Fecha</dt><dd>{date}</dd></div>
            <div><dt><Clock3 /> Hora</dt><dd>{time} · {duration} min</dd></div>
            <div><dt><Users /> Personas</dt><dd>{reservation.partySize}</dd></div>
            <div><dt><Utensils /> Mesas</dt><dd>{reservation.tables.length ? reservation.tables.map((table) => `${table.name} · ${table.areaName}`).join(', ') : 'Sin mesa asignada'}</dd></div>
          </dl>
          {timing && ['confirmed', 'arrived'].includes(reservation.status) ? <div className="w-fit rounded-full bg-[color-mix(in_srgb,var(--warning)_14%,var(--surface))] px-2.5 py-[7px] text-xs font-extrabold text-[var(--warning)]">{timing}</div> : null}
          <section>
            <h3>Contacto</h3>
            <a href={`tel:${reservation.customerPhone}`}><Phone /> {reservation.customerPhone}</a>
            {reservation.customerEmail ? <a href={`mailto:${reservation.customerEmail}`}><Mail /> {reservation.customerEmail}</a> : null}
          </section>
          {reservation.notes ? <section><h3>Notas</h3><p>{reservation.notes}</p></section> : null}
          {reservation.cancellationReason ? <section><h3>Motivo de cancelación</h3><p>{reservation.cancellationReason}</p></section> : null}
          {reservation.arrivedAt || reservation.seatedAt ? <section>
            <h3>Seguimiento</h3>
            {reservation.arrivedAt ? <p>Llegada: {new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(new Date(reservation.arrivedAt))}</p> : null}
            {reservation.seatedAt ? <p>Sentada: {new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(new Date(reservation.seatedAt))}</p> : null}
          </section> : null}
        </div>
        <footer>
          {actions.seat && props.canManage ? <UiButton className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] px-4 font-extrabold no-underline border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)] w-full" disabled={props.disabled} onClick={props.onSeat} type="button"><Utensils /> Sentar</UiButton> : null}
          {actions.openOrder && reservation.orderId ? <UiButton className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] px-4 font-extrabold no-underline border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)] w-full" onClick={() => props.onOpenOrder(reservation.orderId!)} type="button"><Utensils /> Abrir comanda</UiButton> : null}
          <div>
            {actions.arrive && props.canManage ? <UiButton className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] px-4 font-extrabold no-underline bg-[var(--surface)] text-[var(--foreground)]" disabled={props.disabled} onClick={() => props.onStatus('arrived')} type="button"><UserCheck /> Ha llegado</UiButton> : null}
            {actions.edit && props.canManage ? <UiButton className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] px-4 font-extrabold no-underline bg-[var(--surface)] text-[var(--foreground)]" disabled={props.disabled} onClick={props.onEdit} type="button"><Edit3 /> Editar</UiButton> : null}
            <a className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] px-4 font-extrabold no-underline bg-[var(--surface)] text-[var(--foreground)]" href={`tel:${reservation.customerPhone}`}><Phone /> Llamar</a>
            {actions.noShow && props.canManage ? <UiButton className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] px-4 font-extrabold no-underline bg-[var(--surface)] text-[var(--foreground)]" disabled={props.disabled} onClick={() => setConfirmation('no_show')} type="button">No presentado</UiButton> : null}
            {actions.cancel && props.canManage ? <UiButton className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] px-4 font-extrabold no-underline bg-[var(--surface)] text-[var(--foreground)] border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]" disabled={props.disabled} onClick={() => setConfirmation('cancelled')} type="button">Cancelar</UiButton> : null}
          </div>
        </footer>
      </aside>
      {confirmation ? <AppModal containerClassName="!max-w-md !p-4" dismissDisabled={props.disabled} label={confirmation === 'cancelled' ? 'Cancelar reserva' : 'Marcar como no presentada'} onClose={() => setConfirmation(null)}>
        <section className="w-[min(440px,100%)] rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-6 text-[var(--foreground)] shadow-[var(--shadow)]">
          <h2>{confirmation === 'cancelled' ? 'Cancelar reserva' : 'Marcar como no presentada'}</h2>
          <p>La reserva seguirá disponible en el historial.</p>
          {confirmation === 'cancelled' ? <label>Motivo opcional<UiInput autoFocus onChange={(event) => setReason(event.target.value)} value={reason} /></label> : null}
          <div>
            <UiButton className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] px-4 font-extrabold no-underline bg-[var(--surface)] text-[var(--foreground)]" onClick={() => setConfirmation(null)} type="button">Volver</UiButton>
            <UiButton className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] px-4 font-extrabold no-underline border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]" disabled={props.disabled} onClick={() => {
              props.onStatus(confirmation, reason.trim() || undefined)
              setConfirmation(null)
            }} type="button">Confirmar</UiButton>
          </div>
        </section>
      </AppModal> : null}
    </>
  )
}
