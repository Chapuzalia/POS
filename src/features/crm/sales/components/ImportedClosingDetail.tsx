import { Button } from '../../../../components/ui/Button'
import { formatMoney } from '../../../../lib/format'
import { formatRevoDate, type ImportedCashClosing } from '../../../../lib/revoCashClosings.ts'
import { CrmModal } from '../../shared/components/CrmModal'

export function ImportedClosingDetail({ closing, onClose }: { closing: ImportedCashClosing; onClose: () => void }) {
  return <CrmModal label="Detalle del cierre REVO" onClose={onClose}>
    <section className="!grid !gap-4 !p-5">
      <h2 className="!text-lg !font-bold">REVO · {formatRevoDate(closing.date)}</h2>
      <dl className="!grid !grid-cols-2 !gap-3 !text-sm">
        <dt>Efectivo</dt><dd className="!text-right">{formatMoney(closing.cashCents)}</dd>
        <dt>Tarjeta</dt><dd className="!text-right">{formatMoney(closing.cardCents)}</dd>
        <dt className="!font-bold">Total REVO</dt><dd className="!text-right !font-bold">{formatMoney(closing.cashCents + closing.cardCents)}</dd>
        <dt>Propinas en efectivo</dt><dd className="!text-right">{formatMoney(closing.cashTipCents)}</dd>
        <dt>Propinas en tarjeta</dt><dd className="!text-right">{formatMoney(closing.cardTipCents)}</dd>
      </dl>
      <p className="!text-sm !text-[var(--crm-text-muted)]">Resumen de {closing.rowCount} filas de REVO. Las propinas se muestran por separado, sin volver a sumarlas al total. El archivo no incluye arqueos, fondos, horas de cierre ni número de tickets.</p>
      <p className="!break-words !text-xs !text-[var(--crm-text-muted)]">Archivo: {closing.fileName}<br />Importado: {new Date(closing.importedAt).toLocaleString('es-ES')}</p>
      <Button className="!justify-self-end" onClick={onClose} variant="secondary">Cerrar</Button>
    </section>
  </CrmModal>
}
