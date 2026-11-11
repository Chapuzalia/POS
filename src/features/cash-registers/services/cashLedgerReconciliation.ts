import type { OfflineEvent, SaleRecord } from '../../../types/index.ts'

export function pendingLedgerChanges(events: OfflineEvent[], tenantId: string) {
  const changed = new Set<string>()
  const voided = new Set<string>()
  for (const event of events) {
    if (event.tenantId !== tenantId) continue
    if (event.kind === 'sale_created') changed.add(event.payload.sale.id)
    if (event.kind === 'sale_payment_changed') changed.add(event.payload.saleId)
    if (event.kind === 'sale_voided') voided.add(event.payload.saleId)
  }
  return { changed, voided }
}

/** Remote history owns unchanged rows, including removals. Only local changes
 * made during the read or still awaiting acknowledgement can override it. */
export function reconcileCashLedger(remote: SaleRecord[], baseline: SaleRecord[], current: SaleRecord[],
  pending: ReturnType<typeof pendingLedgerChanges>) {
  const before = new Map(baseline.map(sale => [sale.id, sale]))
  const merged = new Map(remote.map(sale => [sale.id, sale]))
  const currentIds = new Set(current.map(sale => sale.id))
  for (const sale of baseline) if (!currentIds.has(sale.id)) merged.delete(sale.id)
  for (const sale of current) {
    if (pending.changed.has(sale.id) || !before.has(sale.id)
      || JSON.stringify(sale) !== JSON.stringify(before.get(sale.id))) merged.set(sale.id, sale)
  }
  for (const id of pending.voided) merged.delete(id)
  return [...merged.values()]
}
