import { AlertTriangle, Check, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { closeOnModalBackdrop } from '../../../components/modals/modalBackdrop'
import { totalReservationTableCapacity, zonedLocalToUtc } from '../domain/reservationAvailability'
import type { Reservation, ReservationConflict, ReservationDraft, ReservationTable } from '../types'

type Props = {
  conflicts: ReservationConflict[]
  date: string
  disabled: boolean
  onClose: () => void
  onSave: (draft: ReservationDraft, allowConflict: boolean) => Promise<boolean>
  onTableIdsChange: (tableIds: string[]) => void
  preselectedTableIds: string[]
  reservation: Reservation | null
  tables: ReservationTable[]
  timeZone: string
}

const durationOptions = [60, 90, 120, 150, 180]

function localParts(value: string, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(new Date(value)).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  }
}

export function ReservationFormModal(props: Props) {
  const initial = props.reservation ? localParts(props.reservation.startsAt, props.timeZone) : { date: props.date, time: '20:00' }
  const initialDuration = props.reservation
    ? Math.round((new Date(props.reservation.endsAt).getTime() - new Date(props.reservation.startsAt).getTime()) / 60_000)
    : 120
  const [date, setDate] = useState(initial.date)
  const [time, setTime] = useState(initial.time)
  const [duration, setDuration] = useState(initialDuration)
  const [partySize, setPartySize] = useState(props.reservation?.partySize ?? 2)
  const [customerName, setCustomerName] = useState(props.reservation?.customerName ?? '')
  const [customerPhone, setCustomerPhone] = useState(props.reservation?.customerPhone ?? '')
  const [customerEmail, setCustomerEmail] = useState(props.reservation?.customerEmail ?? '')
  const [notes, setNotes] = useState(props.reservation?.notes ?? '')
  const [tableIds, setTableIds] = useState(props.preselectedTableIds)
  const [validation, setValidation] = useState<string | null>(null)
  const [allowPast, setAllowPast] = useState(false)
  const lockedSchedule = props.reservation?.status === 'seated'
  const selectedCapacity = totalReservationTableCapacity(props.tables, tableIds)
  const conflictTableIds = useMemo(() => new Set(props.conflicts.map((conflict) => conflict.tableId)), [props.conflicts])

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [props])

  async function submit(allowConflict: boolean) {
    if (!date || !time || duration <= 0 || partySize <= 0 || !customerName.trim() || !customerPhone.trim()) {
      setValidation('Completa los campos obligatorios con valores válidos.')
      return
    }
    const startsAt = zonedLocalToUtc(date, time, props.timeZone)
    const endsAt = new Date(new Date(startsAt).getTime() + duration * 60_000).toISOString()
    if (new Date(endsAt) <= new Date(startsAt)) {
      setValidation('La hora final debe ser posterior a la hora inicial.')
      return
    }
    if (new Date(startsAt).getTime() < Date.now() - 30 * 60_000 && !props.reservation && !allowPast) {
      setAllowPast(true)
      setValidation('La reserva está claramente en el pasado. Pulsa Guardar reserva de nuevo para continuar.')
      return
    }
    setValidation(null)
    await props.onSave({
      id: props.reservation?.id,
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      customerEmail: customerEmail.trim() || null,
      partySize,
      startsAt,
      endsAt,
      notes: notes.trim() || null,
      tableIds,
      expectedUpdatedAt: props.reservation?.updatedAt,
    }, allowConflict)
  }

  return (
    <div className="table-modal-backdrop reservation-form-backdrop" onClick={(event) => closeOnModalBackdrop(event, props.onClose, props.disabled)}>
      <section aria-labelledby="reservation-form-title" aria-modal="true" className="reservation-form" role="dialog">
        <header>
          <div>
            <h2 id="reservation-form-title">{props.reservation ? 'Editar reserva' : 'Nueva reserva'}</h2>
            <p>Los horarios se guardan en la zona horaria del local.</p>
          </div>
          <button aria-label="Cerrar formulario" className="reservation-icon-button" onClick={props.onClose} type="button"><X /></button>
        </header>
        <div className="reservation-form-body">
          {lockedSchedule ? <div className="reservation-notice">La reserva ya está sentada. Su horario y sus mesas no pueden modificarse.</div> : null}
          {validation ? <div className="reservation-form-error"><AlertTriangle /> {validation}</div> : null}
          {props.conflicts.length ? <div className="reservation-conflicts">
            <strong>Conflicto con {props.conflicts.length} {props.conflicts.length === 1 ? 'reserva' : 'reservas'}</strong>
            {props.conflicts.map((conflict) => <span key={`${conflict.reservationId}:${conflict.tableId}`}>
              {conflict.tableName} · {conflict.customerName} · {new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(new Date(conflict.startsAt))}
            </span>)}
          </div> : null}
          <div className="reservation-form-grid">
            <label>Fecha *<input disabled={lockedSchedule} onChange={(event) => setDate(event.target.value)} required type="date" value={date} /></label>
            <label>Hora *<input disabled={lockedSchedule} onChange={(event) => setTime(event.target.value)} required type="time" value={time} /></label>
            <label>Duración *
              <select disabled={lockedSchedule} onChange={(event) => setDuration(Number(event.target.value))} value={duration}>
                {durationOptions.map((minutes) => <option key={minutes} value={minutes}>{minutes} min</option>)}
              </select>
            </label>
            <label>Personas *<input min="1" onChange={(event) => setPartySize(Math.max(1, Number(event.target.value)))} required type="number" value={partySize} /></label>
            <label className="wide">Nombre *<input autoFocus required onChange={(event) => setCustomerName(event.target.value)} value={customerName} /></label>
            <label>Teléfono *<input inputMode="tel" required onChange={(event) => setCustomerPhone(event.target.value)} value={customerPhone} /></label>
            <label>Email opcional<input inputMode="email" onChange={(event) => setCustomerEmail(event.target.value)} type="email" value={customerEmail} /></label>
            <label className="wide">Notas opcionales<textarea onChange={(event) => setNotes(event.target.value)} rows={3} value={notes} /></label>
          </div>
          <section className="reservation-table-picker">
            <div>
              <h3>Mesas opcionales</h3>
              <span>{tableIds.length ? `${selectedCapacity} plazas seleccionadas` : 'La reserva puede guardarse sin mesa'}</span>
            </div>
            {tableIds.length && selectedCapacity < partySize ? <div className="reservation-capacity-warning"><AlertTriangle /> La capacidad seleccionada es inferior al número de personas.</div> : null}
            <div className="reservation-table-options">
              {props.tables.map((table) => {
                const selected = tableIds.includes(table.id)
                const conflict = conflictTableIds.has(table.id)
                return <button
                  className={`${selected ? 'selected' : ''}${conflict ? ' conflict' : ''}`}
                  disabled={lockedSchedule || !table.isActive}
                  key={table.id}
                  onClick={() => setTableIds((current) => {
                    const next = current.includes(table.id)
                      ? current.filter((id) => id !== table.id)
                      : [...current, table.id]
                    props.onTableIdsChange(next)
                    return next
                  })}
                  type="button"
                >
                  <span>{selected ? <Check /> : null}<strong>{table.name}</strong></span>
                  <small>{table.areaName} · {table.capacity} plazas</small>
                  <em>{!table.isActive ? 'Desactivada' : conflict ? 'Conflicto' : table.capacity < partySize ? 'Capacidad insuficiente' : 'Disponible'}</em>
                </button>
              })}
            </div>
          </section>
        </div>
        <footer>
          <button className="table-action secondary" onClick={props.onClose} type="button">Cancelar</button>
          {props.conflicts.length ? <button className="table-action primary" disabled={props.disabled} onClick={() => void submit(true)} type="button">Guardar igualmente</button>
            : <button className="table-action primary" disabled={props.disabled} onClick={() => void submit(false)} type="button">Guardar reserva</button>}
        </footer>
      </section>
    </div>
  )
}
