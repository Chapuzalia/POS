import { TextArea as UiTextArea } from '../../../../components/ui/TextArea'
import { Input as UiInput } from '../../../../components/ui/Input'
import { Button as UiButton } from '../../../../components/ui/Button'
import { Monitor, Plus, Save, Trash2, Warehouse, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { TenantContext } from '../../../../types'
import { CrmModal } from '../../shared/components/CrmModal'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { EmptyList } from '../../shared/components/EmptyList'
import { Field } from '../../shared/components/Field'
import type { RunAction } from '../../shared/types'
import {
  createInventoryWarehouse,
  deleteInventoryWarehouse,
  loadInventoryWarehouseStockSummaries,
  loadInventoryWarehouses,
  loadInventoryWarehouseRouting,
  saveInventoryDeviceWarehouses,
} from '../services/inventoryService'
import type { InventoryWarehouse, InventoryWarehouseRouting, InventoryWarehouseStockSummary } from '../types'

type Props = {
  disabled: boolean
  runAction: RunAction
  selectedVenueId: string
  tenantContext: TenantContext
}

export function InventoryWarehousesCrm({ disabled, runAction, selectedVenueId, tenantContext }: Props) {
  const [warehouses, setWarehouses] = useState<InventoryWarehouse[]>([])
  const [routing, setRouting] = useState<InventoryWarehouseRouting>({ assignments: [], devices: [] })
  const [stockSummaries, setStockSummaries] = useState<InventoryWarehouseStockSummary[]>([])
  const [creating, setCreating] = useState(false)
  const [deletingWarehouseId, setDeletingWarehouseId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!selectedVenueId) {
      setWarehouses([])
      setRouting({ assignments: [], devices: [] })
      setStockSummaries([])
      return
    }
    const [nextWarehouses, nextRouting, nextStockSummaries] = await Promise.all([
      loadInventoryWarehouses(tenantContext, selectedVenueId),
      loadInventoryWarehouseRouting(tenantContext, selectedVenueId),
      loadInventoryWarehouseStockSummaries(tenantContext, selectedVenueId),
    ])
    setWarehouses(nextWarehouses)
    setRouting(nextRouting)
    setStockSummaries(nextStockSummaries)
  }, [selectedVenueId, tenantContext])

  useEffect(() => {
    setCreating(false)
    setDeletingWarehouseId(null)
    void runAction(refresh)
  }, [refresh, runAction])

  const deletingWarehouse = deletingWarehouseId
    ? warehouses.find((warehouse) => warehouse.id === deletingWarehouseId) ?? null
    : null

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
        <div className="!min-w-[760px]">
          <div className="!grid !grid-cols-[minmax(220px,1fr)_minmax(260px,1.3fr)_120px_52px] !gap-4 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !px-[22px] !py-3 !text-[11px] !font-semibold !uppercase !tracking-wide !text-[var(--crm-text-muted)]">
            <span>Almacén</span><span>Descripción</span><span>Estado</span><span className="!sr-only">Acciones</span>
          </div>
          {warehouses.map((warehouse) => (
            <div className="!grid !min-h-16 !grid-cols-[minmax(220px,1fr)_minmax(260px,1.3fr)_120px_52px] !items-center !gap-4 !border-b !border-[var(--crm-border-subtle)] !px-[22px] !py-3 !text-[13px]" key={warehouse.id}>
              <div className="!flex !min-w-0 !items-center !gap-3">
                <span className="!grid !size-9 !shrink-0 !place-items-center !rounded-[10px] !bg-[var(--crm-blue-soft)] !text-[var(--crm-blue)]"><Warehouse className="!size-4" /></span>
                <strong className="!truncate">{warehouse.name}</strong>
              </div>
              <span className="!text-[var(--crm-text-secondary)]">{warehouse.description || 'Sin descripción'}</span>
              <span className={warehouse.active ? 'inline-flex min-h-6 w-fit items-center whitespace-nowrap rounded-full px-[9px] text-[11px] font-semibold bg-[var(--crm-green-soft)] text-[var(--crm-green)] !w-fit' : 'inline-flex min-h-6 w-fit items-center whitespace-nowrap rounded-full px-[9px] text-[11px] font-semibold bg-[var(--crm-red-soft)] text-[var(--crm-red)] !w-fit'}>{warehouse.active ? 'Activo' : 'Inactivo'}</span>
              <UiButton aria-label={`Eliminar ${warehouse.name}`} className="!inline-flex !size-9 !min-h-9 !min-w-9 !items-center !justify-center !rounded-[9px] !border-0 !bg-[var(--crm-red-soft)] !p-0 !text-[var(--crm-red)] !shadow-none hover:!brightness-95" disabled={disabled} onClick={() => setDeletingWarehouseId(warehouse.id)} title="Eliminar almacén" type="button"><Trash2 className="!size-4" /></UiButton>
            </div>
          ))}
        </div>
      </div>
      {!warehouses.length ? <div className="!p-[18px] md:!p-[22px]"><EmptyList message="No hay almacenes. Crea el primero para empezar a registrar existencias." /></div> : null}

      <DeviceWarehouseRouting
        disabled={disabled}
        onSaved={refresh}
        routing={routing}
        runAction={runAction}
        selectedVenueId={selectedVenueId}
        tenantContext={tenantContext}
        warehouses={warehouses}
      />

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

      {deletingWarehouse ? (
        <WarehouseDeleteModal
          disabled={disabled}
          onClose={() => setDeletingWarehouseId(null)}
          onSaved={async () => { await refresh(); setDeletingWarehouseId(null) }}
          runAction={runAction}
          selectedVenueId={selectedVenueId}
          stockProductCount={stockSummaries.find((summary) => summary.warehouseId === deletingWarehouse.id)?.nonZeroProductCount ?? 0}
          tenantContext={tenantContext}
          warehouse={deletingWarehouse}
          warehouses={warehouses}
        />
      ) : null}
    </section>
  )
}

function WarehouseDeleteModal({
  disabled,
  onClose,
  onSaved,
  runAction,
  selectedVenueId,
  stockProductCount,
  tenantContext,
  warehouse,
  warehouses,
}: {
  disabled: boolean
  onClose: () => void
  onSaved: () => Promise<void>
  runAction: RunAction
  selectedVenueId: string
  stockProductCount: number
  tenantContext: TenantContext
  warehouse: InventoryWarehouse
  warehouses: InventoryWarehouse[]
}) {
  const [targetWarehouseId, setTargetWarehouseId] = useState('')
  const needsTransfer = stockProductCount > 0
  const targetWarehouses = warehouses.filter((candidate) => (
    candidate.id !== warehouse.id && candidate.active
  ))

  async function remove() {
    if (needsTransfer && !targetWarehouseId) return
    await runAction(async () => {
      await deleteInventoryWarehouse(
        tenantContext,
        selectedVenueId,
        warehouse.id,
        needsTransfer ? targetWarehouseId : null,
      )
      await onSaved()
    })
  }

  return (
    <CrmModal label={`Eliminar ${warehouse.name}`} onClose={onClose}>
      <div className="!flex !items-start !justify-between !gap-4 !border-b !border-[var(--crm-border-subtle)] !px-[18px] !py-5 md:!px-[22px]">
        <div className="!min-w-0">
          <h2 className="!m-0 !truncate !text-lg !font-bold">Eliminar {warehouse.name}</h2>
          <p className="!mt-1 !mb-0 !text-xs !font-medium !text-[var(--crm-text-muted)]">Esta operación también eliminará sus asignaciones a los TPV.</p>
        </div>
        <UiButton aria-label="Cerrar" className="!inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !p-0 !text-[var(--crm-text-muted)]" disabled={disabled} onClick={onClose} type="button"><X className="!size-4" /></UiButton>
      </div>

      <div className="!grid !gap-4 !px-[18px] !py-5 md:!px-[22px]">
        {needsTransfer ? (
          <>
            <div className="!rounded-xl !bg-[var(--crm-yellow-soft)] !p-4 !text-sm !font-semibold !text-[var(--crm-yellow)]">
              Este almacén contiene {stockProductCount} {stockProductCount === 1 ? 'producto con stock' : 'productos con stock'}. Selecciona dónde transferir sus cantidades antes de eliminarlo.
            </div>
            <label className="!grid !gap-1.5">
              <span className="!text-xs !font-semibold !text-[var(--crm-text-secondary)]">Almacén de destino</span>
              <CrmSelect
                ariaLabel={`Almacén de destino para ${warehouse.name}`}
                disabled={disabled || !targetWarehouses.length}
                onChange={setTargetWarehouseId}
                options={targetWarehouses.map((candidate) => ({ label: candidate.name, value: candidate.id }))}
                placeholder="Selecciona un almacén"
                value={targetWarehouseId}
              />
            </label>
            {!targetWarehouses.length ? <p className="!m-0 !rounded-xl !bg-[var(--crm-red-soft)] !p-3 !text-sm !font-semibold !text-[var(--crm-red)]">Necesitas crear o activar otro almacén antes de poder eliminar este.</p> : null}
          </>
        ) : (
          <p className="!m-0 !text-sm !font-medium !text-[var(--crm-text-secondary)]">El almacén no contiene cantidades de stock. Se puede eliminar directamente.</p>
        )}
      </div>

      <div className="!flex !justify-end !gap-2 !border-t !border-[var(--crm-border-subtle)] !px-[18px] !py-4 md:!px-[22px]">
        <UiButton className="!inline-flex !min-h-10 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-input-bg)] !px-4 !text-[13px] !font-semibold !text-[var(--crm-text-secondary)]" disabled={disabled} onClick={onClose} type="button">Cancelar</UiButton>
        <UiButton className="!inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-red-soft)] !px-4 !text-[13px] !font-semibold !text-[var(--crm-red)]" disabled={disabled || (needsTransfer && !targetWarehouseId)} onClick={() => { void remove() }} type="button"><Trash2 className="!size-4" /> Eliminar almacén</UiButton>
      </div>
    </CrmModal>
  )
}

type DeviceWarehouseDraft = Record<string, { enabled: boolean; priority: string }>

function DeviceWarehouseRouting({
  disabled,
  onSaved,
  routing,
  runAction,
  selectedVenueId,
  tenantContext,
  warehouses,
}: {
  disabled: boolean
  onSaved: () => Promise<void>
  routing: InventoryWarehouseRouting
  runAction: RunAction
  selectedVenueId: string
  tenantContext: TenantContext
  warehouses: InventoryWarehouse[]
}) {
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [draft, setDraft] = useState<DeviceWarehouseDraft>({})
  const [validationError, setValidationError] = useState<string | null>(null)

  useEffect(() => {
    setSelectedDeviceId((current) => (
      routing.devices.some((device) => device.id === current)
        ? current
        : routing.devices.find((device) => device.active)?.id ?? routing.devices[0]?.id ?? ''
    ))
  }, [routing.devices])

  useEffect(() => {
    const assignmentsByWarehouse = new Map(routing.assignments
      .filter((assignment) => assignment.deviceId === selectedDeviceId)
      .map((assignment) => [assignment.warehouseId, assignment]))
    setDraft(Object.fromEntries(warehouses.map((warehouse, index) => {
      const assignment = assignmentsByWarehouse.get(warehouse.id)
      return [warehouse.id, {
        enabled: warehouse.active && (assignment?.enabled ?? true),
        priority: String(assignment?.priority ?? index + 1),
      }]
    })))
    setValidationError(null)
  }, [routing.assignments, selectedDeviceId, warehouses])

  const selectedDevice = routing.devices.find((device) => device.id === selectedDeviceId)
  const hasSavedConfiguration = routing.assignments.some((assignment) => assignment.deviceId === selectedDeviceId)

  function updateDraft(warehouseId: string, update: Partial<DeviceWarehouseDraft[string]>) {
    setDraft((current) => ({
      ...current,
      [warehouseId]: { ...current[warehouseId], ...update },
    }))
    setValidationError(null)
  }

  async function save() {
    if (!selectedDeviceId) return
    const assignments = warehouses.map((warehouse) => {
      const warehouseDraft = draft[warehouse.id]
      return {
        enabled: warehouse.active && (warehouseDraft?.enabled ?? false),
        priority: Number(warehouseDraft?.priority),
        warehouseId: warehouse.id,
      }
    })
    if (assignments.some((assignment) => !Number.isInteger(assignment.priority) || assignment.priority < 1 || assignment.priority > 9999)) {
      setValidationError('La prioridad debe ser un número entero entre 1 y 9999.')
      return
    }
    const enabledPriorities = assignments
      .filter((assignment) => assignment.enabled)
      .map((assignment) => assignment.priority)
    if (new Set(enabledPriorities).size !== enabledPriorities.length) {
      setValidationError('Los almacenes activos deben tener prioridades diferentes.')
      return
    }

    await runAction(async () => {
      await saveInventoryDeviceWarehouses(
        tenantContext,
        selectedVenueId,
        selectedDeviceId,
        assignments,
      )
      await onSaved()
    })
  }

  return (
    <div className="!border-t !border-[var(--crm-border-subtle)]">
      <div className="!grid !gap-4 !border-b !border-[var(--crm-border-subtle)] !px-[18px] !py-5 md:!grid-cols-[minmax(0,1fr)_minmax(240px,360px)] md:!items-end md:!px-[22px]">
        <div className="!min-w-0">
          <h3 className="!m-0 !text-[15px] !font-bold">Acceso y prioridad por TPV</h3>
          <p className="!mt-1 !mb-0 !text-xs !font-medium !text-[var(--crm-text-muted)]">El número 1 se consume primero; el almacén general puede dejarse con la prioridad más alta.</p>
        </div>
        <CrmSelect
          ariaLabel="Seleccionar TPV para configurar almacenes"
          disabled={disabled || !routing.devices.length}
          onChange={setSelectedDeviceId}
          options={routing.devices.map((device) => ({
            label: `${device.name}${device.active ? '' : ' · Inactivo'}`,
            value: device.id,
          }))}
          placeholder="Selecciona un TPV"
          value={selectedDeviceId}
        />
      </div>

      {selectedDevice && warehouses.length ? (
        <div className="!grid !gap-3 !px-[18px] !py-5 md:!px-[22px]">
          <div className="!flex !items-center !gap-3 !rounded-xl !bg-[var(--crm-blue-soft)] !p-3 !text-[var(--crm-blue)]">
            <Monitor className="!size-4 !shrink-0" />
            <p className="!m-0 !text-xs !font-semibold">
              {hasSavedConfiguration
                ? `${selectedDevice.name} usa únicamente los almacenes marcados.`
                : `${selectedDevice.name} todavía usa todos los almacenes activos. Guarda para personalizarlo.`}
            </p>
          </div>

          {warehouses.map((warehouse) => {
            const warehouseDraft = draft[warehouse.id] ?? { enabled: false, priority: '' }
            return (
              <div className="!grid !gap-3 !rounded-xl !bg-[var(--crm-surface-soft)] !p-3 sm:!grid-cols-[minmax(0,1fr)_150px] sm:!items-center" key={warehouse.id}>
                <label className="!flex !min-w-0 !cursor-pointer !items-center !gap-3">
                  <input
                    aria-label={`Permitir ${warehouse.name} en ${selectedDevice.name}`}
                    checked={warehouseDraft.enabled}
                    className="!size-4 !shrink-0 !accent-[var(--crm-blue)]"
                    disabled={disabled || !warehouse.active}
                    onChange={(event) => updateDraft(warehouse.id, { enabled: event.target.checked })}
                    type="checkbox"
                  />
                  <span className="!grid !min-w-0 !gap-0.5">
                    <strong className="!truncate !text-[13px] !font-semibold">{warehouse.name}</strong>
                    <small className="!truncate !text-xs !font-medium !text-[var(--crm-text-muted)]">{warehouse.active ? (warehouse.description || 'Almacén activo') : 'Almacén inactivo'}</small>
                  </span>
                </label>
                <label className="!grid !grid-cols-[auto_minmax(0,1fr)] !items-center !gap-2 !text-xs !font-semibold !text-[var(--crm-text-muted)]">
                  <span>Prioridad</span>
                  <UiInput
                    aria-label={`Prioridad de ${warehouse.name} para ${selectedDevice.name}`}
                    className="!h-10 !min-h-10 !font-mono"
                    disabled={disabled || !warehouseDraft.enabled}
                    inputMode="numeric"
                    min="1"
                    onChange={(event) => updateDraft(warehouse.id, { priority: event.target.value })}
                    step="1"
                    type="number"
                    value={warehouseDraft.priority}
                  />
                </label>
              </div>
            )
          })}

          {validationError ? <p className="!m-0 !rounded-xl !bg-[var(--crm-red-soft)] !p-3 !text-sm !font-semibold !text-[var(--crm-red)]" role="alert">{validationError}</p> : null}
          <div className="!flex !justify-end">
            <UiButton className="!inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" disabled={disabled} onClick={() => { void save() }} type="button"><Save className="!size-4" /> Guardar configuración</UiButton>
          </div>
        </div>
      ) : (
        <div className="!p-[18px] md:!p-[22px]"><EmptyList message={routing.devices.length ? 'Crea al menos un almacén para configurar los TPV.' : 'No hay dispositivos TPV configurados para este local.'} /></div>
      )}
    </div>
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
