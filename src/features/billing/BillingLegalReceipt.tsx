import { Button } from '../../components/ui/Button'
import type { BillingLegalReceipt as Receipt } from '../../../supabase/functions/_shared/billing/legal'
import { billingDate, billingMoney } from './service'

function downloadLegalReceipt(acceptance: Receipt) {
  const { receipt } = acceptance
  const text = [
    'TICKIT POS — JUSTIFICANTE DE ACEPTACIÓN CONTRACTUAL',
    `Aceptación recibida: ${acceptance.accepted_at}`,
    `Operación: ${acceptance.operation_id}`, `Empresa: ${acceptance.tenant_id}`, `Usuario aceptante: ${acceptance.actor_id}`,
    `Cliente: ${receipt.payer.legalName} · NIF ${receipt.payer.taxId}`, `Plan: ${receipt.contract.planName}`,
    `Primera cuota (IVA incluido): ${billingMoney(receipt.offer.amountDueCents)}`,
    `Cuota recurrente: ${billingMoney(receipt.offer.recurringNetCents)} + IVA 21 % = ${billingMoney(receipt.offer.recurringGrossCents)} / ${receipt.offer.interval === 'year' ? 'año' : 'mes'}`,
    'Renovación automática. Primera cuota con tarjeta; siguientes por SEPA.',
    'Términos y Condiciones y oferta: aceptados. DPA: aceptado por separado. Declaración B2B y representación: confirmada.',
    'Privacidad y aviso legal: información facilitada; no se solicita consentimiento.',
    'Este justificante confirma la aceptación, no el cobro. La activación requiere pago confirmado.',
    ...Object.values(receipt.documents).map(doc => `${doc.title} · v${doc.version}\n${new URL(doc.url, window.location.origin).href}\nSHA-256: ${doc.sha256}`),
    '\nOferta y evidencia completa:\n', JSON.stringify(acceptance, null, 2),
  ].join('\n\n')
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url; link.download = `Tickit-contrato-${acceptance.operation_id}.txt`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export function BillingLegalReceipt({ acceptance }: { acceptance: Receipt }) {
  return <div className="!grid !gap-2 !rounded-xl !bg-[var(--crm-surface-soft)] !p-4 !text-sm">
    <div className="!flex !flex-wrap !items-center !justify-between !gap-2"><p role="status" className="!m-0">Contrato aceptado · {billingDate(acceptance.accepted_at)}</p><Button onClick={() => downloadLegalReceipt(acceptance)}>Descargar justificante</Button></div>
    <details className="!text-xs"><summary className="!flex !min-h-11 !cursor-pointer !items-center !text-[var(--crm-text-muted)]">Documentos del contrato ⌄</summary><div className="!grid !gap-1">{Object.values(acceptance.receipt.documents).map(doc => <a key={doc.url} className="!inline-flex !min-h-11 !items-center !text-[var(--crm-blue)] !underline" href={doc.url} download>{doc.title} · v{doc.version}</a>)}</div></details>
  </div>
}
