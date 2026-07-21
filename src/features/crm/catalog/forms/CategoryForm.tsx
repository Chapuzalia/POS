import { CrmModal } from '../../shared/components/CrmModal'
import { Field } from '../../shared/components/Field'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { Save, X } from 'lucide-react'
import { categoryKindOptions } from '../../../../lib/catalog'
import { createCategory, updateCategory } from '../services/catalogService'
import { type CatalogKind, type Category, type TenantContext } from '../../../../types'
import { type RunAction } from '../../shared/types'
import { useMemo, useState } from 'react'

export type CategoryFormPanelProps = {
  categories: Category[]
  category?: Category
  disabled: boolean
  mode: 'create' | 'edit'
  onCatalogChanged: () => Promise<void>
  onClose: () => void
  runAction: RunAction
  tenantContext: TenantContext
}

export function CategoryFormPanel({
  categories,
  category,
  disabled,
  mode,
  onCatalogChanged,
  onClose,
  runAction,
  tenantContext,
}: CategoryFormPanelProps) {
  const isEditing = mode === 'edit'
  const [name, setName] = useState(category?.name ?? '')
  const [kind, setKind] = useState<CatalogKind>(category?.kind ?? 'alcohol')
  const nextSortOrder = useMemo(() => categories.length + 1, [categories.length])

  async function saveCategory() {
    if (!name.trim()) {
      return
    }

    await runAction(async () => {
      if (isEditing && category) {
        await updateCategory(tenantContext, category.id, {
          kind,
          name: name.trim(),
          sortOrder: category.sortOrder,
        })
      } else {
        await createCategory(tenantContext, {
          kind,
          name: name.trim(),
          sortOrder: nextSortOrder,
        })
      }
      await onCatalogChanged()
      onClose()
    })
  }

  async function toggleCategory() {
    if (!category) {
      return
    }

    await runAction(async () => {
      await updateCategory(tenantContext, category.id, {
        isActive: !category.isActive,
      })
      await onCatalogChanged()
    })
  }

  const editorContent = (
    <>
      <div className="crm-editor-header !flex !items-center !justify-between !gap-3 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!px-[22px]">
        <div>
          <span>{isEditing ? 'Editar categoria' : 'Nueva categoria'}</span>
          <small>{isEditing ? category?.name : 'Agrupa productos del TPV'}</small>
        </div>
        <button aria-label="Cerrar editor de categoria" className="crm-editor-close !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[13px] !font-semibold !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" onClick={onClose} type="button">
          <X className="h-4 w-4" />
        </button>
      </div>

      <form
        className="crm-form-stack !grid !min-h-0 !gap-3.5 !overflow-y-auto !px-[22px] !pt-5 !pb-[22px]"
        onSubmit={(event) => {
          event.preventDefault()
          void saveCategory()
        }}
      >
      <Field label="Nombre">
        <input autoFocus={!isEditing} className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" onChange={(event) => setName(event.target.value)} value={name} />
      </Field>
      <Field label="Tipo">
        <CrmSelect
          onChange={(nextKind) => setKind(nextKind as CatalogKind)}
          options={categoryKindOptions.map((option) => ({ label: option.label, value: option.value }))}
          value={kind}
        />
      </Field>
      <div className="crm-editor-actions">
        <button className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} type="submit">
          <Save className="h-4 w-4" />
          Guardar
        </button>
        {isEditing && category ? (
          <button
            className={category.isActive ? 'crm-state-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-green-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-green)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150' : 'crm-state-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-green-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-green)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 crm-state-button-danger !bg-[var(--crm-red-soft)] !text-[var(--crm-red)]'}
            disabled={disabled}
            onClick={toggleCategory}
            type="button"
          >
            {category.isActive ? 'Marcar oculta' : 'Activar'}
          </button>
        ) : null}
      </div>
      </form>
    </>
  )

  if (!isEditing) {
    return (
      <CrmModal label="Anadir categoria" onClose={onClose}>
        {editorContent}
      </CrmModal>
    )
  }

  return (
    <aside className="crm-panel !flex !min-w-0 !flex-col !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-editor-panel !min-h-0 xl:!min-h-[calc(100dvh-var(--crm-topbar-height)-78px)]">
      {editorContent}
    </aside>
  )
}
