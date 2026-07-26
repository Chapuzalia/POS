import { CalendarDays, Clock3, Edit3, Mail, Phone, UserCheck, Users, Utensils, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { closeOnModalBackdrop } from '../../../components/modals/modalBackdrop'
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
      <aside aria-label={`Reserva de ${reservation.customerName}`} className="reservation-detail">
        <header>
          <div>
            <span className={`reservation-status status-${reservation.status}`}>{getReservationStatusLabel(reservation.status)}</span>
            <h2>{reservation.customerName}</h2>
          </div>
          <button aria-label="Cerrar detalle" className="reservation-icon-button" onClick={props.onClose} type="button"><X /></button>
        </header>
        <div className="reservation-detail-body">
          <dl>
            <div><dt><CalendarDays /> Fecha</dt><dd>{date}</dd></div>
            <div><dt><Clock3 /> Hora</dt><dd>{time} · {duration} min</dd></div>
            <div><dt><Users /> Personas</dt><dd>{reservation.partySize}</dd></div>
            <div><dt><Utensils /> Mesas</dt><dd>{reservation.tables.length ? reservation.tables.map((table) => `${table.name} · ${table.areaName}`).join(', ') : 'Sin mesa asignada'}</dd></div>
          </dl>
          {timing && ['confirmed', 'arrived'].includes(reservation.status) ? <div className="reservation-timing">{timing}</div> : null}
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
          {actions.seat && props.canManage ? <button className="table-action primary reservation-seat" disabled={props.disabled} onClick={props.onSeat} type="button"><Utensils /> Sentar</button> : null}
          {actions.openOrder && reservation.orderId ? <button className="table-action primary reservation-seat" onClick={() => props.onOpenOrder(reservation.orderId!)} type="button"><Utensils /> Abrir comanda</button> : null}
          <div>
            {actions.arrive && props.canManage ? <button className="table-action secondary" disabled={props.disabled} onClick={() => props.onStatus('arrived')} type="button"><UserCheck /> Ha llegado</button> : null}
            {actions.edit && props.canManage ? <button className="table-action secondary" disabled={props.disabled} onClick={props.onEdit} type="button"><Edit3 /> Editar</button> : null}
            <a className="table-action secondary" href={`tel:${reservation.customerPhone}`}><Phone /> Llamar</a>
            {actions.noShow && props.canManage ? <button className="table-action secondary" disabled={props.disabled} onClick={() => setConfirmation('no_show')} type="button">No presentado</button> : null}
            {actions.cancel && props.canManage ? <button className="table-action secondary danger" disabled={props.disabled} onClick={() => setConfirmation('cancelled')} type="button">Cancelar</button> : null}
          </div>
        </footer>
      </aside>
      {confirmation ? <div className="table-modal-backdrop" onClick={(event) => closeOnModalBackdrop(event, () => setConfirmation(null), props.disabled)}>
        <section aria-modal="true" className="table-modal" role="dialog">
          <h2>{confirmation === 'cancelled' ? 'Cancelar reserva' : 'Marcar como no presentada'}</h2>
          <p>La reserva seguirá disponible en el historial.</p>
          {confirmation === 'cancelled' ? <label>Motivo opcional<input autoFocus onChange={(event) => setReason(event.target.value)} value={reason} /></label> : null}
          <div>
            <button className="table-action secondary" onClick={() => setConfirmation(null)} type="button">Volver</button>
            <button className="table-action primary" disabled={props.disabled} onClick={() => {
              props.onStatus(confirmation, reason.trim() || undefined)
              setConfirmation(null)
            }} type="button">Confirmar</button>
          </div>
        </section>
      </div> : null}
    </>
  )
}
