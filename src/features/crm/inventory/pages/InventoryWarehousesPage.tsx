import { TextArea as UiTextArea } from '../../../../components/ui/TextArea'
import { Input as UiInput } from '../../../../components/ui/Input'
import { Button as UiButton } from '../../../../components/ui/Button'
import { Plus, Warehouse, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { TenantContext } from '../../../../types'
import { CrmModal } from '../../shared/components/CrmModal'
import { EmptyList } from '../../shared/components/EmptyList'
import { Field } from '../../shared/components/Field'
import type { RunAction } from '../../shared/types'
import { createInventoryWarehouse, loadInventoryWarehouses } from '../services/inventoryService'
import type { InventoryWarehouse } from '../types'

type Props = {
  disabled: boolean
  runAction: RunAction
  selectedVenueId: string
  tenantContext: TenantContext
}

export function InventoryWarehousesCrm({ disabled, runAction, selectedVenueId, tenantContext }: Props) {
  const [warehouses, setWarehouses] = useState<InventoryWarehouse[]>([])
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(async () => {
    if (!selectedVenueId) {
      setWarehouses([])
      return
    }
    setWarehouses(await loadInventoryWarehouses(tenantContext, selectedVenueId))
  }, [selectedVenueId, tenantContext])

  useEffect(() => {
    setCreating(false)
    void runAction(refresh)
  }, [refresh, runAction])

  return (
    <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
      <div className="flex items-center justify-between gap-4 border-b border-[var(--crm-border-subtle)] bg-[var(--crm-surface)] p-3 max-[760px]:flex-col max-[760px]:items-stretch !flex !flex-col !items-stretch !justify-between !gap-4 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!flex-row md:!items-center md:!px-[22px]">
        <div className="min-w-0 [&_h2]:m-0 [&_h2]:text-[17px] [&_h2]:font-bold [&_h2]:tracking-[-0.02em] [&_h2]:text-[var(--crm-text)] [&_p]:mt-1 [&_p]:mb-0 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)]">
          <h2>Almacenes</h2>
          <p>{warehouses.length} ubicaciones configuradas para el local actual</p>
        </div>
        <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-blue)] px-3.5 text-[13px] font-semibold leading-none text-white shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-blue-hover)] hover:shadow-[0_8px_20px_rgba(20,120,237,0.22)] !inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" disabled={disabled || !selectedVenueId} onClick={() => setCreating(true)} type="button">
          <Plus className="!size-4" /> Nuevo almacén
        </UiButton>
      </div>

      <div className="!overflow-x-auto">
        <div className="!min-w-[680px]">
          <div className="!grid !grid-cols-[minmax(220px,1fr)_minmax(260px,1.3fr)_120px] !gap-4 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !px-[22px] !py-3 !text-[11px] !font-semibold !uppercase !tracking-wide !text-[var(--crm-text-muted)]">
            <span>Almacén</span><span>Descripción</span><span>Estado</span>
          </div>
          {warehouses.map((warehouse) => (
            <div className="!grid !min-h-16 !grid-cols-[minmax(220px,1fr)_minmax(260px,1.3fr)_120px] !items-center !gap-4 !border-b !border-[var(--crm-border-subtle)] !px-[22px] !py-3 !text-[13px]" key={warehouse.id}>
              <div className="!flex !min-w-0 !items-center !gap-3">
                <span className="!grid !size-9 !shrink-0 !place-items-center !rounded-[10px] !bg-[var(--crm-blue-soft)] !text-[var(--crm-blue)]"><Warehouse className="!size-4" /></span>
                <strong className="!truncate">{warehouse.name}</strong>
              </div>
              <span className="!text-[var(--crm-text-secondary)]">{warehouse.description || 'Sin descripción'}</span>
              <span className={warehouse.active ? 'inline-flex min-h-6 w-fit items-center whitespace-nowrap rounded-full px-[9px] text-[11px] font-semibold bg-[var(--crm-green-soft)] text-[var(--crm-green)] !w-fit' : 'inline-flex min-h-6 w-fit items-center whitespace-nowrap rounded-full px-[9px] text-[11px] font-semibold bg-[var(--crm-red-soft)] text-[var(--crm-red)] !w-fit'}>{warehouse.active ? 'Activo' : 'Inactivo'}</span>
            </div>
          ))}
        </div>
      </div>
      {!warehouses.length ? <div className="!p-[18px] md:!p-[22px]"><EmptyList message="No hay almacenes. Crea el primero para empezar a registrar existencias." /></div> : null}

      {creating ? (
        <WarehouseEditor
          disabled={disabled}
          onClose={() => setCreating(false)}
          onSaved={async () => { await refresh(); setCreating(false) }}
          runAction={runAction}
          selectedVenueId={selectedVenueId}
          tenantContext={tenantContext}
        />
      ) : null}
    </section>
  )
}

function WarehouseEditor({ disabled, onClose, onSaved, runAction, selectedVenueId, tenantContext }: {
  disabled: boolean
  onClose: () => void
  onSaved: () => Promise<void>
  runAction: RunAction
  selectedVenueId: string
  tenantContext: TenantContext
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)

  const save = async () => {
    if (!name.trim()) {
      setValidationError('Indica el nombre del almacén.')
      return
    }
    await runAction(async () => {
      await createInventoryWarehouse(tenantContext, selectedVenueId, { name, description })
      await onSaved()
    })
  }

  return (
    <CrmModal label="Nuevo almacén" onClose={onClose}>
      <div className="flex items-center justify-between gap-3 border-b border-[var(--crm-border-subtle)] bg-transparent p-3 text-[var(--crm-text)] [&>div]:grid [&>div]:min-w-0 [&>div]:gap-1 [&_span]:text-[15px] [&_span]:font-bold [&_small]:truncate [&_small]:text-xs [&_small]:font-medium [&_small]:text-[var(--crm-text-muted)] !flex !items-center !justify-between !gap-3 !border-b !border-[var(--crm-border-subtle)] !px-[18px] !py-5 md:!px-[22px]">
        <div><span>Nuevo almacén</span><small>Ubicación física del stock de este local</small></div>
        <UiButton aria-label="Cerrar" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-[var(--crm-text-muted)] shadow-none transition-colors duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-10 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !p-0 !text-[var(--crm-text-muted)]" onClick={onClose} type="button"><X className="!size-4" /></UiButton>
      </div>
      <form className="!grid !gap-4 !px-[22px] !py-5" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <Field label="Nombre"><UiInput autoFocus className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px]" maxLength={80} onChange={(event) => { setName(event.target.value); setValidationError(null) }} placeholder="Barra principal" value={name} /></Field>
        <Field label="Descripción"><UiTextArea className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px] !min-h-24 !py-3" maxLength={240} onChange={(event) => setDescription(event.target.value)} placeholder="Ubicación o uso del almacén" value={description} /></Field>
        {validationError ? <p className="!text-sm !font-semibold !text-[var(--crm-red)]">{validationError}</p> : null}
        <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-blue)] px-3.5 text-[13px] font-semibold leading-none text-white shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-blue-hover)] hover:shadow-[0_8px_20px_rgba(20,120,237,0.22)] !min-h-10 !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !font-semibold !text-white" disabled={disabled} type="submit">Crear almacén</UiButton>
      </form>
    </CrmModal>
  )
}
