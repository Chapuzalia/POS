import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import { Button, Input } from '../../../../components/ui'
import type { TenantContext } from '../../../../types'
import { CrmModal } from '../../shared/components/CrmModal'
import { useCrmModalBusy } from '../../shared/components/CrmModalBusyContext'
import type { RunAction } from '../../shared/types'
import { addInventoryStockQuantity, formatInventoryQuantity, parsePositiveInventoryQuantity } from '../inventoryModel'
import { saveInventoryItemStock } from '../services/inventoryService'
import type { StockRow } from '../stockControlModel'

type Props = {
  row: StockRow
  context: TenantContext
  venueId: string
  disabled: boolean
  runAction: RunAction
  onClose: () => void
  onSaved: () => Promise<void>
}

export function QuickStockReplenishment({ row, context, venueId, disabled, runAction, onClose, onSaved }: Props) {
  const busy = useCrmModalBusy(disabled)
  const decimals = row.unit?.decimalPlaces ?? 6
  const scale = 10 ** decimals
  const suggested = Math.ceil(Number(row.shortage.toFixed(6)) * scale - 0.0000001) / scale
  const [draft, setDraft] = useState('')
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  let quantity: number | null = null
  let validation: string | null = null
  try { quantity = parsePositiveInventoryQuantity(draft, decimals, 'La cantidad recibida') }
  catch (cause) { if (draft.trim()) validation = cause instanceof Error ? cause.message : 'Indica una cantidad válida.' }
  const result = quantity === null ? null : addInventoryStockQuantity(row.quantity, draft, decimals)
  const format = (value: number) => `${formatInventoryQuantity(value, decimals)} ${row.unit?.symbol ?? ''}`

  function change(value: string) {
    setDraft(value)
    setRequestId(crypto.randomUUID())
  }

  async function save() {
    if (disabled || busy || quantity === null || !row.warehouse || !row.unit || !row.controlled) return
    const received = quantity
    const warehouseId = row.warehouse.id
    await runAction(async () => {
      await saveInventoryItemStock(context, venueId, row.item.id, [{ warehouseId, enabled: true, quantity: received }], { mode: 'add', requestId })
      await onSaved()
    })
  }

  return <CrmModal dismissDisabled={busy} label={`Reposición rápida de ${row.item.name}`} onClose={onClose}>
    <form onSubmit={(event) => { event.preventDefault(); void save() }}>
      <header className="flex items-start justify-between gap-3 border-b border-[var(--crm-border-subtle)] p-5">
        <div><h2 className="m-0 text-lg font-bold">Reponer {row.item.name}</h2><p className="mt-1 mb-0 text-sm text-[var(--crm-text-muted)]">{row.warehouse?.name} · Entrada manual de existencias</p></div>
        <Button aria-label="Cerrar" disabled={busy} onClick={onClose} type="button" variant="tertiary"><X className="size-4" /></Button>
      </header>
      <div className="grid gap-4 p-5">
        <dl className="m-0 grid grid-cols-2 gap-3 rounded-[var(--crm-radius-md)] bg-[var(--crm-surface-soft)] p-4 text-sm">
          <div><dt className="text-xs text-[var(--crm-text-muted)]">Disponible ahora</dt><dd className="m-0 mt-1 font-mono font-bold">{format(row.quantity)}</dd></div>
          <div><dt className="text-xs text-[var(--crm-text-muted)]">Objetivo del almacén</dt><dd className="m-0 mt-1 font-mono font-bold">{row.target === null ? 'Sin objetivo' : format(row.target)}</dd></div>
        </dl>
        <label className="grid gap-2 text-sm font-semibold">Cantidad recibida ({row.unit?.symbol})
          <Input autoFocus disabled={disabled || busy} inputMode="decimal" onChange={(event) => change(event.target.value)} onFocus={(event) => event.target.select()} value={draft} />
        </label>
        <div aria-label="Cantidades rápidas de reposición" className="flex flex-wrap gap-2" role="group">
          {[1, 5, 10].map((amount) => <Button disabled={disabled || busy} key={amount} onClick={() => {
            let current = 0
            try { current = parsePositiveInventoryQuantity(draft, decimals, 'La cantidad recibida') } catch { /* Replace an invalid draft with the chosen addition. */ }
            change(String(addInventoryStockQuantity(current, String(amount), decimals)))
          }} size="sm" type="button" variant="tertiary">+{amount} {row.unit?.symbol}</Button>)}
          {suggested > 0 ? <Button disabled={disabled || busy} onClick={() => change(String(suggested))} size="sm" type="button" variant="secondary">Completar objetivo</Button> : null}
        </div>
        <div aria-live="polite" className="rounded-[var(--crm-radius-md)] bg-[var(--crm-blue-soft)] p-4">
          <p className="m-0 text-xs text-[var(--crm-text-muted)]">Existencias tras la entrada</p><strong className="mt-1 block font-mono text-xl">{result === null ? draft.trim() ? 'Cantidad no válida' : 'Pendiente de cantidad' : format(result)}</strong>
        </div>
        {validation ? <p className="m-0 text-sm text-[var(--crm-red)]" role="alert">{validation}</p> : null}
        <p className="m-0 text-xs text-[var(--crm-text-muted)]">La cantidad se suma al saldo al guardar. Si otro terminal consume stock, el resultado puede variar respecto a esta vista previa.</p>
      </div>
      <footer className="flex flex-wrap justify-end gap-2 border-t border-[var(--crm-border-subtle)] p-4">
        <Button disabled={busy} onClick={onClose} type="button" variant="tertiary">Cancelar</Button>
        <Button disabled={disabled || busy || quantity === null || !row.controlled || !row.unit} type="submit"><Plus className="size-4" /> Confirmar reposición</Button>
      </footer>
    </form>
  </CrmModal>
}
