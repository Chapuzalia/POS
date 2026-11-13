import { Button } from '../../components/ui/Button'
import { billingDate, billingMoney } from './service'
import { downloadSepaEvidence } from './sepa'
import type { SepaEvidence, SepaRecord } from '../../../supabase/functions/_shared/billing/sepa'

export function BillingSepaRecords({ records, initial }: { records: SepaRecord[]; initial: SepaEvidence[] }) {
  const authorizations = [...initial, ...records.flatMap(record => record.evidence ? [record.evidence] : [])]
  if (!records.length && !initial.length) return null
  return <details className="!rounded-xl !bg-[var(--crm-surface)] !p-4 !text-sm">
    <summary className="!min-h-11 !cursor-pointer !py-2 !font-semibold">Mandatos y avisos SEPA</summary>
    <div className="!grid !gap-3">
      {authorizations.map(evidence => <div key={evidence.reference} className="!border-b !border-[var(--crm-border)] !pb-3">
        <p className="!m-0 !break-all">{billingDate(evidence.acceptedAt)} · {evidence.reference}</p>
        <p className="!mb-2 !mt-1">Titular: {evidence.accountHolder} · Cuenta terminada en {evidence.ibanLast4}</p>
        <Button onClick={() => downloadSepaEvidence(evidence)}>Descargar autorización</Button>
      </div>)}
      {records.flatMap(record => record.notice ? [<p key={record.id} className="!m-0 !break-words">
        Adeudo previsto el {record.notice.dueDate} · {billingMoney(record.notice.amountCents)} · {record.notice.status === 'sent' ? `Aviso enviado el ${billingDate(record.notice.sentAt ?? record.createdAt)}` : record.notice.status === 'late' ? 'Aviso fuera de plazo: requiere revisión por Alteil' : 'Aviso pendiente: requiere revisión por Alteil'} · {record.notice.recipient}
      </p>] : [])}
      <p className="!m-0 !text-xs !text-[var(--crm-text-muted)]">La aceptación del mandato y el envío de un aviso no confirman el cobro. Para obtener una copia bancaria completa o resolver incidencias: info@alteilsolutions.com.</p>
    </div>
  </details>
}
