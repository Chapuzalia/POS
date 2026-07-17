import { X } from 'lucide-react'
import { useState } from 'react'
import { centsToInput, formatMoney, parseMoneyToCents } from '../../lib/format'
import type { CashClosedPayload, CashSession, CashSummary } from '../../types'
import { nowIso } from '../../utils/dates'
import { Button, Metric } from '../ui'

type CloseCashModalProps = {
  cashSession: CashSession
  isBusy: boolean
  onCancel: () => void
  onConfirm: (payload: CashClosedPayload) => void
  summary: CashSummary
  userId: string
}

export function CloseCashModal({ cashSession, isBusy, onCancel, onConfirm, summary, userId }: CloseCashModalProps) {
  const [countedCash, setCountedCash] = useState(centsToInput(summary.cashCents))
  const [countedCard, setCountedCard] = useState(centsToInput(summary.cardCents))
  const [notes, setNotes] = useState('')
  const countedCashCents = parseMoneyToCents(countedCash)
  const countedCardCents = parseMoneyToCents(countedCard)
  const expectedTotal = summary.cashCents + summary.cardCents
  const countedTotal = countedCashCents + countedCardCents
  const discrepancy = countedTotal - expectedTotal
  const notesRequired = discrepancy !== 0 && !notes.trim()

  function handleConfirm() {
    onConfirm({
      sessionId: cashSession.id,
      tenantId: cashSession.tenantId,
      closedAt: nowIso(),
      closedBy: userId,
      expectedCashCents: summary.cashCents,
      expectedCardCents: summary.cardCents,
      expectedInvitationCents: summary.invitationCents,
      expectedOtherCents: summary.otherCents,
      countedCashCents,
      countedCardCents,
      countedInvitationCents: summary.invitationCents,
      countedOtherCents: summary.otherCents,
      discrepancyCents: discrepancy,
      notes: notes.trim(),
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
      <section className="max-h-[calc(100svh-32px)] w-full max-w-3xl overflow-y-auto rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-5 text-[var(--foreground)] shadow-[var(--shadow)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold">Cierre de caja</h2>
            <p className="text-sm text-[var(--muted)]">Revisa importes esperados y contado real.</p>
          </div>
          <Button disabled={isBusy} onClick={onCancel} size="sm" type="button" variant="tertiary">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <Metric label="Efectivo esperado" value={formatMoney(summary.cashCents)} />
          <Metric label="Tarjeta TPV" value={formatMoney(summary.cardCents)} />
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {[
            ['Efectivo', countedCash, setCountedCash],
            ['Datafono', countedCard, setCountedCard],
          ].map(([label, value, setter]) => (
            <label className="block" key={label as string}>
              <span className="text-sm font-semibold text-[var(--muted)]">{label as string}</span>
              <div className="mt-1 flex h-12 items-center rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)]">
                <span className="px-3 font-mono text-sm font-bold text-[var(--muted)]">EUR</span>
                <input
                  className="h-full min-w-0 flex-1 bg-transparent px-2 font-mono text-[var(--field-foreground)] outline-none"
                  inputMode="decimal"
                  onChange={(event) => (setter as (next: string) => void)(event.target.value)}
                  value={value as string}
                />
              </div>
            </label>
          ))}
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <Metric label="Total esperado" value={formatMoney(expectedTotal)} />
          <Metric
            label="Descuadre"
            tone={discrepancy === 0 ? 'success' : 'danger'}
            value={formatMoney(discrepancy)}
          />
        </div>

        <label className="mt-5 block">
          <span className="text-sm font-semibold text-[var(--muted)]">Notas</span>
          <textarea
            className="mt-1 min-h-24 w-full rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] p-3 text-[var(--field-foreground)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
            onChange={(event) => setNotes(event.target.value)}
            value={notes}
          />
        </label>

        <Button
          className="mt-4"
          disabled={isBusy || notesRequired}
          fullWidth
          onClick={handleConfirm}
          size="lg"
          type="button"
          variant="danger"
        >
          Cerrar caja
        </Button>
      </section>
    </div>
  )
}
