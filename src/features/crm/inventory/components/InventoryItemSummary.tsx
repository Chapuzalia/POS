import { useEffect, useState } from 'react'
import type { TenantContext } from '../../../../types'
import { getEffectiveInventoryItemCost } from '../inventoryModel'
import { loadInventoryItemVariantCount } from '../services/inventoryService'
import type { InventoryItem, InventoryUnit } from '../types'

type Props = { item: InventoryItem; unit: InventoryUnit | undefined; context: TenantContext; venueId: string }

export function InventoryItemSummary({ item, unit, context, venueId }: Props) {
  const [links, setLinks] = useState<number | null>(null)
  const [linksError, setLinksError] = useState(false)
  const cost = getEffectiveInventoryItemCost(item)
  const costLabel = cost?.source === 'average' ? 'Coste medio' : cost?.source === 'last_purchase' ? 'Última compra' : 'Referencia'

  useEffect(() => {
    let cancelled = false
    void loadInventoryItemVariantCount(context, venueId, item.id)
      .then((value) => { if (!cancelled) setLinks(value) })
      .catch(() => { if (!cancelled) setLinksError(true) })
    return () => { cancelled = true }
  }, [context, item.id, venueId])

  return <div className="grid gap-3 px-5 pt-5">
    {item.description ? <p className="m-0 whitespace-pre-wrap break-words text-sm text-[var(--crm-text-secondary)]">{item.description}</p> : null}
    <dl className="m-0 grid gap-3 rounded-[var(--crm-radius-md)] bg-[var(--crm-surface-soft)] p-4 sm:grid-cols-3">
      <div><dt className="text-xs text-[var(--crm-text-muted)]">Estado del artículo</dt><dd className="m-0 mt-1 text-sm font-semibold">{item.active ? 'Activo' : 'Inactivo'}</dd></div>
      <div><dt className="text-xs text-[var(--crm-text-muted)]">Coste efectivo por {unit?.symbol ?? 'unidad'}</dt><dd className="m-0 mt-1 text-sm font-semibold">{cost ? <>{cost.cost.toLocaleString('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 4 })}<small className="block text-xs font-normal text-[var(--crm-text-muted)]">{costLabel}</small></> : 'Sin coste conocido'}</dd></div>
      <div><dt className="text-xs text-[var(--crm-text-muted)]">Vínculos con el catálogo</dt><dd className="m-0 mt-1 text-sm font-semibold">{linksError ? 'No se pudieron consultar' : links === null ? 'Consultando…' : `${links} ${links === 1 ? 'variante' : 'variantes'}`}</dd></div>
    </dl>
  </div>
}
