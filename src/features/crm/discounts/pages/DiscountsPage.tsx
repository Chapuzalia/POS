import { CrmModal } from '../../shared/components/CrmModal'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { EmptyList } from '../../shared/components/EmptyList'
import { Field } from '../../shared/components/Field'
import { Pencil, Plus, Save, X } from 'lucide-react'
import { centsToInput, formatMoney, parseMoneyToCents } from '../../../../lib/format'
import { createDiscount, loadCrmDiscounts, loadManualDiscountEnabled, setDiscountActive, setManualDiscountEnabled, updateDiscount } from '../services/discountService'
import { discountRoundingOptions, formatDiscountRounding } from '../../../../lib/discounts'
import { type Discount, type DiscountCalculationType, type DiscountRoundingIncrementCents, type TenantContext } from '../../../../types'
import { type RunAction } from '../../shared/types'
import { useCallback, useEffect, useState } from 'react'

export type DiscountsCrmProps = {
  disabled: boolean
  onCatalogChanged: () => Promise<void>
  runAction: RunAction
  selectedVenueId: string
  tenantContext: TenantContext
}

export function DiscountsCrm({ disabled, onCatalogChanged, runAction, selectedVenueId, tenantContext }: DiscountsCrmProps) {
  const [discounts, setDiscounts] = useState<Discount[]>([])
  const [editor, setEditor] = useState<Discount | 'new' | null>(null)
  const [manualEnabled, setManualEnabled] = useState(false)

  const refresh = useCallback(async () => {
    if (!selectedVenueId) {
      setDiscounts([])
      setManualEnabled(false)
      return
    }
    const [nextDiscounts, nextManualEnabled] = await Promise.all([
      loadCrmDiscounts(tenantContext, selectedVenueId),
      loadManualDiscountEnabled(tenantContext, selectedVenueId),
    ])
    setDiscounts(nextDiscounts)
    setManualEnabled(nextManualEnabled)
  }, [selectedVenueId, tenantContext])

  useEffect(() => {
    setEditor(null)
    void runAction(refresh)
  }, [refresh, runAction])

  async function toggleManual() {
    await runAction(async () => {
      await setManualDiscountEnabled(tenantContext, selectedVenueId, !manualEnabled)
      setManualEnabled((current) => !current)
      await onCatalogChanged()
    })
  }

  async function toggleDiscount(discount: Discount) {
    await runAction(async () => {
      await setDiscountActive(tenantContext, discount.id, !discount.isActive)
      await refresh()
      await onCatalogChanged()
    })
  }

  return (
    <div className="!grid !grid-cols-1 !items-start !gap-4 xl:!gap-6">
      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-list-toolbar !flex !flex-col !items-stretch !justify-between !gap-4 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!flex-row md:!items-center md:!px-[22px]">
          <div className="crm-list-title">
            <h2>Descuentos</h2>
            <p>{discounts.length} configurados para el local seleccionado</p>
          </div>
          <button className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" disabled={disabled || !selectedVenueId} onClick={() => setEditor('new')} type="button">
            <Plus className="h-4 w-4" /> Añadir descuento
          </button>
        </div>

        <div className="!grid !gap-2 !p-[18px] md:!p-[22px]">
          {discounts.map((discount) => (
            <div className="!grid !min-h-[68px] !grid-cols-[minmax(0,1fr)_130px_100px_auto] !items-center !gap-3 !rounded-[12px] !bg-[var(--crm-surface-soft)] !px-4 !py-3 !text-[13px] !text-[var(--crm-text)]" key={discount.id}>
              <div className="!flex !min-w-0 !items-center !gap-3">
                <span className="!size-3 !shrink-0 !rounded-full !border !border-black/10" style={{ backgroundColor: discount.color ?? 'var(--crm-blue)' }} />
                <div className="crm-cell-main"><strong>{discount.name}</strong><span>{discount.type === 'percentage' ? 'Porcentaje' : 'Importe fijo'} · {formatDiscountRounding(discount.roundingIncrementCents)}</span></div>
              </div>
              <strong className="!font-mono !text-[var(--crm-text)]">{discount.type === 'percentage' ? `${discount.value} %` : formatMoney(discount.value)}</strong>
              <span className={discount.isActive ? 'crm-status-pill !w-fit !rounded-full !bg-[var(--crm-green-soft)] !px-2.5 !py-1 !text-[11px] !font-semibold !text-[var(--crm-green)]' : 'crm-status-pill !w-fit !rounded-full !bg-[var(--crm-input-bg)] !px-2.5 !py-1 !text-[11px] !font-semibold !text-[var(--crm-text-muted)]'}>{discount.isActive ? 'Activo' : 'Inactivo'}</span>
              <div className="!flex !justify-end !gap-2">
                <button className="crm-action-button !min-h-9 !rounded-[9px] !border-0 !bg-[var(--crm-surface)] !px-3 !font-semibold !text-[var(--crm-text-secondary)]" disabled={disabled} onClick={() => setEditor(discount)} type="button"><Pencil className="!mr-1 !inline !size-3.5" />Editar</button>
                <button className="crm-action-button !min-h-9 !rounded-[9px] !border-0 !bg-[var(--crm-surface)] !px-3 !font-semibold !text-[var(--crm-text-secondary)]" disabled={disabled} onClick={() => void toggleDiscount(discount)} type="button">{discount.isActive ? 'Desactivar' : 'Activar'}</button>
              </div>
            </div>
          ))}
          {!discounts.length ? <EmptyList message="No hay descuentos configurados para este local." /> : null}
        </div>
      </section>

      <section className="crm-panel !rounded-2xl !border-0 !bg-[var(--crm-surface)] !p-[18px] !shadow-[var(--crm-shadow-card)] md:!p-[22px]">
        <div className="!flex !flex-col !items-start !justify-between !gap-4 sm:!flex-row sm:!items-center">
          <div><h2 className="!text-base !font-bold">Permitir descuento manual</h2><p className="!mt-1 !text-xs !text-[var(--crm-text-muted)]">Disponible para cualquier usuario del POS en este local.</p></div>
          <button aria-pressed={manualEnabled} className={manualEnabled ? '!min-h-10 !rounded-[10px] !border-0 !bg-[var(--crm-green-soft)] !px-4 !text-[13px] !font-semibold !text-[var(--crm-green)]' : '!min-h-10 !rounded-[10px] !border-0 !bg-[var(--crm-input-bg)] !px-4 !text-[13px] !font-semibold !text-[var(--crm-text-secondary)]'} disabled={disabled || !selectedVenueId} onClick={() => void toggleManual()} type="button">{manualEnabled ? 'Activado' : 'Desactivado'}</button>
        </div>
      </section>

      {editor ? (
        <DiscountEditor
          disabled={disabled}
          discount={editor === 'new' ? null : editor}
          key={editor === 'new' ? 'new' : editor.id}
          onClose={() => setEditor(null)}
          onSaved={async () => { await refresh(); await onCatalogChanged(); setEditor(null) }}
          runAction={runAction}
          selectedVenueId={selectedVenueId}
          tenantContext={tenantContext}
        />
      ) : null}
    </div>
  )
}

export function DiscountEditor({ disabled, discount, onClose, onSaved, runAction, selectedVenueId, tenantContext }: {
  disabled: boolean
  discount: Discount | null
  onClose: () => void
  onSaved: () => Promise<void>
  runAction: RunAction
  selectedVenueId: string
  tenantContext: TenantContext
}) {
  const [name, setName] = useState(discount?.name ?? '')
  const [type, setType] = useState<DiscountCalculationType>(discount?.type ?? 'percentage')
  const [value, setValue] = useState(discount ? (discount.type === 'fixed' ? centsToInput(discount.value) : String(discount.value)) : '')
  const [roundingIncrementCents, setRoundingIncrementCents] = useState<DiscountRoundingIncrementCents | null>(discount?.roundingIncrementCents ?? null)
  const [color, setColor] = useState(discount?.color ?? '#2563eb')
  const [isActive, setIsActive] = useState(discount?.isActive ?? true)
  const [validationError, setValidationError] = useState<string | null>(null)

  async function save() {
    const parsedValue = type === 'fixed' ? parseMoneyToCents(value) : Number(value.replace(',', '.'))
    if (!name.trim() || !Number.isFinite(parsedValue) || parsedValue <= 0 || (type === 'percentage' && parsedValue > 100)) {
      setValidationError(type === 'percentage' ? 'Indica un nombre y un porcentaje entre 0 y 100.' : 'Indica un nombre y un importe mayor que 0.')
      return
    }
    await runAction(async () => {
      const input = { name: name.trim(), type, value: parsedValue, roundingIncrementCents, color: color || null, isActive }
      if (discount) await updateDiscount(tenantContext, discount.id, input)
      else await createDiscount(tenantContext, { ...input, venueId: selectedVenueId })
      await onSaved()
    })
  }

  return (
    <CrmModal label={discount ? 'Editar descuento' : 'Añadir descuento'} onClose={onClose}>
      <div className="crm-editor-header !flex !items-center !justify-between !gap-3 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!px-[22px]"><div><span>{discount ? 'Editar descuento' : 'Nuevo descuento'}</span><small>Aplicable a la cuenta completa</small></div><button aria-label="Cerrar" className="crm-editor-close !inline-flex !size-10 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !p-0 !text-[var(--crm-text-muted)]" onClick={onClose} type="button"><X className="h-4 w-4" /></button></div>
      <form className="crm-form-stack !grid !gap-3.5 !px-[22px] !py-5" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <Field label="Nombre"><input autoFocus className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none" onChange={(event) => setName(event.target.value)} value={name} /></Field>
        <Field label="Tipo">
          <CrmSelect
            onChange={(nextType) => { setType(nextType as DiscountCalculationType); setValue('') }}
            options={[
              { label: 'Porcentaje', value: 'percentage' },
              { label: 'Importe fijo', value: 'fixed' },
            ]}
            value={type}
          />
        </Field>
        <Field label={type === 'percentage' ? 'Porcentaje' : 'Importe'}><input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none" inputMode="decimal" onChange={(event) => { setValue(event.target.value); setValidationError(null) }} value={value} /></Field>
        <Field label="Redondeo del total">
          <CrmSelect
            onChange={(nextValue) => setRoundingIncrementCents(nextValue ? Number(nextValue) as DiscountRoundingIncrementCents : null)}
            options={discountRoundingOptions.map((option) => ({ label: option.label, value: String(option.value ?? '') }))}
            value={String(roundingIncrementCents ?? '')}
          />
          <small className="!mt-1.5 !block !text-xs !text-[var(--crm-text-muted)]">Se redondeará el total final tras aplicar el descuento.</small>
        </Field>
        <Field label="Color"><div className="crm-color-field"><span>{color.toUpperCase()}</span><input aria-label="Color del descuento" onChange={(event) => setColor(event.target.value)} type="color" value={color} /></div></Field>
        <label className="!flex !min-h-11 !items-center !gap-2.5 !rounded-[10px] !bg-[var(--crm-input-bg)] !px-3.5 !text-sm !font-semibold !text-[var(--crm-text)]"><input className="!size-4 !accent-[var(--crm-blue)]" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} type="checkbox" /> Activo</label>
        {validationError ? <p className="!text-sm !font-semibold !text-[var(--crm-red)]">{validationError}</p> : null}
        <button className="crm-primary-button !min-h-10 !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !font-semibold !text-white" disabled={disabled} type="submit"><Save className="!mr-2 !inline !size-4" />Guardar</button>
      </form>
    </CrmModal>
  )
}
