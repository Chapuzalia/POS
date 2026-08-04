import { Input as UiInput } from '../../../../components/ui/Input'
import { Button as UiButton } from '../../../../components/ui/Button'
import { Plus, Ruler, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { TenantContext } from '../../../../types'
import { CrmModal } from '../../shared/components/CrmModal'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { EmptyList } from '../../shared/components/EmptyList'
import { Field } from '../../shared/components/Field'
import type { RunAction } from '../../shared/types'
import {
  inventoryQuantityStep,
  MAX_INVENTORY_DECIMAL_PLACES,
  parsePositiveInventoryQuantity,
} from '../inventoryModel'
import { createInventoryUnit, loadInventoryUnits } from '../services/inventoryService'
import type { InventoryUnit } from '../types'

type Props = {
  disabled: boolean
  runAction: RunAction
  selectedVenueId: string
  tenantContext: TenantContext
}

const SELF_UNIT_VALUE = '__self__'

export function InventorySettingsCrm({ disabled, runAction, selectedVenueId, tenantContext }: Props) {
  const [units, setUnits] = useState<InventoryUnit[]>([])
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(async () => {
    if (!selectedVenueId) {
      setUnits([])
      return
    }
    setUnits(await loadInventoryUnits(tenantContext, selectedVenueId))
  }, [selectedVenueId, tenantContext])

  useEffect(() => {
    setCreating(false)
    void runAction(refresh)
  }, [refresh, runAction])

  return (
    <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
      <div className="flex items-center justify-between gap-4 border-b border-[var(--crm-border-subtle)] bg-[var(--crm-surface)] p-3 max-[760px]:flex-col max-[760px]:items-stretch !flex !flex-col !items-stretch !justify-between !gap-4 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!flex-row md:!items-center md:!px-[22px]">
        <div className="min-w-0 [&_h2]:m-0 [&_h2]:text-[17px] [&_h2]:font-bold [&_h2]:tracking-[-0.02em] [&_h2]:text-[var(--crm-text)] [&_p]:mt-1 [&_p]:mb-0 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)]">
          <h2>Unidades de inventario</h2>
          <p>Define las unidades de stock y su equivalencia para calcular el consumo</p>
        </div>
        <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-blue)] px-3.5 text-[13px] font-semibold leading-none text-white shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-blue-hover)] hover:shadow-[0_8px_20px_rgba(20,120,237,0.22)] !inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" disabled={disabled || !selectedVenueId} onClick={() => setCreating(true)} type="button">
          <Plus className="!size-4" /> Nueva unidad
        </UiButton>
      </div>

      <div className="!overflow-x-auto">
        <div className="!min-w-[660px]">
          <div className="!grid !grid-cols-[minmax(220px,1fr)_130px_190px_160px_120px] !gap-4 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !px-[22px] !py-3 !text-[11px] !font-semibold !uppercase !tracking-wide !text-[var(--crm-text-muted)]">
            <span>Unidad</span><span>Abreviatura</span><span>Equivalencia</span><span>Precisión</span><span>Estado</span>
          </div>
          {units.map((unit) => {
            const contentUnit = units.find((candidate) => candidate.id === unit.contentUnitId)
            const isBaseUnit = unit.contentUnitId === unit.id && unit.contentQuantity === 1
            return (
            <div className="!grid !min-h-16 !grid-cols-[minmax(220px,1fr)_130px_190px_160px_120px] !items-center !gap-4 !border-b !border-[var(--crm-border-subtle)] !px-[22px] !py-3 !text-[13px]" key={unit.id}>
              <div className="!flex !min-w-0 !items-center !gap-3"><span className="!grid !size-9 !shrink-0 !place-items-center !rounded-[10px] !bg-[var(--crm-blue-soft)] !text-[var(--crm-blue)]"><Ruler className="!size-4" /></span><strong>{unit.name}</strong></div>
              <strong className="!font-mono">{unit.symbol}</strong>
              <span className="!font-mono !text-[var(--crm-text-secondary)]">
                {isBaseUnit ? 'Unidad base' : `${unit.contentQuantity} ${contentUnit?.symbol ?? ''}`}
              </span>
              <span className="!text-[var(--crm-text-secondary)]">{unit.decimalPlaces === 0 ? 'Unidades enteras' : `${unit.decimalPlaces} decimales`}</span>
              <span className={unit.active ? 'inline-flex min-h-6 w-fit items-center whitespace-nowrap rounded-full px-[9px] text-[11px] font-semibold bg-[var(--crm-green-soft)] text-[var(--crm-green)] !w-fit' : 'inline-flex min-h-6 w-fit items-center whitespace-nowrap rounded-full px-[9px] text-[11px] font-semibold bg-[var(--crm-red-soft)] text-[var(--crm-red)] !w-fit'}>{unit.active ? 'Activa' : 'Inactiva'}</span>
            </div>
            )
          })}
        </div>
      </div>
      {!units.length ? <div className="!p-[18px] md:!p-[22px]"><EmptyList message="Todavía no hay unidades. Crea, por ejemplo, ml para destilados y botellín para refrescos." /></div> : null}

      {creating ? (
        <InventoryUnitEditor
          disabled={disabled}
          onClose={() => setCreating(false)}
          onSaved={async () => { await refresh(); setCreating(false) }}
          runAction={runAction}
          selectedVenueId={selectedVenueId}
          tenantContext={tenantContext}
          units={units}
        />
      ) : null}
    </section>
  )
}

function InventoryUnitEditor({ disabled, onClose, onSaved, runAction, selectedVenueId, tenantContext, units }: {
  disabled: boolean
  onClose: () => void
  onSaved: () => Promise<void>
  runAction: RunAction
  selectedVenueId: string
  tenantContext: TenantContext
  units: InventoryUnit[]
}) {
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [decimalPlaces, setDecimalPlaces] = useState(0)
  const [contentQuantity, setContentQuantity] = useState('1')
  const [contentUnitId, setContentUnitId] = useState(SELF_UNIT_VALUE)
  const [validationError, setValidationError] = useState<string | null>(null)

  const save = async () => {
    if (!name.trim() || !symbol.trim()) {
      setValidationError('Indica el nombre y la abreviatura de la unidad.')
      return
    }
    const selectedContentUnit = units.find((unit) => unit.id === contentUnitId)
    let parsedContentQuantity: number
    try {
      parsedContentQuantity = parsePositiveInventoryQuantity(
        contentQuantity,
        selectedContentUnit?.decimalPlaces ?? decimalPlaces,
        'La equivalencia',
      )
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'La equivalencia no es válida.')
      return
    }
    await runAction(async () => {
      await createInventoryUnit(tenantContext, selectedVenueId, {
        name,
        symbol,
        decimalPlaces,
        contentQuantity: parsedContentQuantity,
        contentUnitId: contentUnitId === SELF_UNIT_VALUE ? null : contentUnitId,
      })
      await onSaved()
    })
  }

  return (
    <CrmModal label="Nueva unidad de inventario" onClose={onClose}>
      <div className="flex items-center justify-between gap-3 border-b border-[var(--crm-border-subtle)] bg-transparent p-3 text-[var(--crm-text)] [&>div]:grid [&>div]:min-w-0 [&>div]:gap-1 [&_span]:text-[15px] [&_span]:font-bold [&_small]:truncate [&_small]:text-xs [&_small]:font-medium [&_small]:text-[var(--crm-text-muted)] !flex !items-center !justify-between !gap-3 !border-b !border-[var(--crm-border-subtle)] !px-[18px] !py-5 md:!px-[22px]">
        <div><span>Nueva unidad</span><small>Se podrá asignar a cualquier producto del local</small></div>
        <UiButton aria-label="Cerrar" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-[var(--crm-text-muted)] shadow-none transition-colors duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-10 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !p-0 !text-[var(--crm-text-muted)]" onClick={onClose} type="button"><X className="!size-4" /></UiButton>
      </div>
      <form className="!grid !gap-4 !px-[22px] !py-5" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <Field label="Nombre"><UiInput autoFocus className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px]" maxLength={80} onChange={(event) => { setName(event.target.value); setValidationError(null) }} placeholder="Mililitros" value={name} /></Field>
        <Field label="Abreviatura"><UiInput className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px]" maxLength={12} onChange={(event) => { setSymbol(event.target.value); setValidationError(null) }} placeholder="ml" value={symbol} /></Field>
        <Field label="Decimales permitidos">
          <CrmSelect
            onChange={(value) => setDecimalPlaces(Number(value))}
            options={Array.from({ length: MAX_INVENTORY_DECIMAL_PLACES + 1 }, (_, value) => ({
              label: value === 0 ? 'Solo cantidades enteras' : `${value} ${value === 1 ? 'decimal' : 'decimales'}`,
              value: String(value),
            }))}
            value={String(decimalPlaces)}
          />
        </Field>
        <div className="!grid !gap-3 !rounded-xl !border !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !p-4">
          <div>
            <strong className="!text-sm">Equivalencia de contenido</strong>
            <p className="!mt-1 !text-xs !font-medium !text-[var(--crm-text-muted)]">Ejemplo: Botella 70 cl contiene 700 Mililitros.</p>
          </div>
          <div className="!grid !grid-cols-[120px_minmax(0,1fr)] !gap-3">
            <Field label="Cantidad">
              <UiInput
                className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px] !font-mono"
                inputMode="decimal"
                min="0"
                onChange={(event) => { setContentQuantity(event.target.value); setValidationError(null) }}
                placeholder="700"
                step={inventoryQuantityStep(units.find((unit) => unit.id === contentUnitId)?.decimalPlaces ?? decimalPlaces)}
                type="number"
                value={contentQuantity}
              />
            </Field>
            <Field label="Unidad contenida">
              <CrmSelect
                onChange={(value) => { setContentUnitId(value); setValidationError(null) }}
                options={[
                  { label: 'La propia unidad (unidad base)', value: SELF_UNIT_VALUE },
                  ...units.filter((unit) => (
                    unit.active
                    && unit.contentUnitId === unit.id
                    && unit.contentQuantity === 1
                  )).map((unit) => ({
                    label: `${unit.name} (${unit.symbol})`,
                    value: unit.id,
                  })),
                ]}
                value={contentUnitId}
              />
            </Field>
          </div>
        </div>
        <p className="!rounded-[10px] !bg-[var(--crm-blue-soft)] !p-3 !text-xs !font-medium !text-[var(--crm-text-secondary)]">Para crear Mililitros usa 1 de la propia unidad. Para Botella 70 cl usa 700 ml.</p>
        {validationError ? <p className="!text-sm !font-semibold !text-[var(--crm-red)]">{validationError}</p> : null}
        <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-blue)] px-3.5 text-[13px] font-semibold leading-none text-white shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-blue-hover)] hover:shadow-[0_8px_20px_rgba(20,120,237,0.22)] !min-h-10 !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !font-semibold !text-white" disabled={disabled} type="submit">Crear unidad</UiButton>
      </form>
    </CrmModal>
  )
}
