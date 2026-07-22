import { ArrowDown, ArrowUp, Eye, EyeOff, Link2, Pencil, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { CatalogData } from '../../../catalog/domain/types.ts'
import { catalogIconOptions, getCatalogIconComponent } from '../../../catalog/ui/catalogIcons.ts'
import { CrmSelect } from '../../shared/components/CrmSelect.tsx'
import { CrmModal } from '../../shared/components/CrmModal.tsx'
import { catalogAdminService } from '../services/catalogAdminService.ts'
import { moveCatalogItem, toReorderItems } from '../services/catalogAdminModel.ts'

type Props = {
  catalog: CatalogData
  disabled: boolean
  mutate: (action: () => Promise<unknown>) => Promise<boolean>
}

export function CatalogStructureCrm({ catalog, disabled, mutate }: Props) {
  const [categoryName, setCategoryName] = useState('')
  const [tabLabel, setTabLabel] = useState('')
  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [editingTabLabel, setEditingTabLabel] = useState('')
  const [editingTabIcon, setEditingTabIcon] = useState('receipt')
  const [iconSearch, setIconSearch] = useState('')
  const [associationTabId, setAssociationTabId] = useState(catalog.tabs[0]?.id ?? '')
  const [associationCategoryId, setAssociationCategoryId] = useState(catalog.categories[0]?.id ?? '')
  const placementsByCategory = useMemo(() => {
    const counts = new Map<string, number>()
    for (const placement of catalog.placements) if (placement.categoryId) counts.set(placement.categoryId, (counts.get(placement.categoryId) ?? 0) + 1)
    return counts
  }, [catalog.placements])
  const placementsByTab = useMemo(() => {
    const counts = new Map<string, number>()
    for (const placement of catalog.placements) counts.set(placement.tabId, (counts.get(placement.tabId) ?? 0) + 1)
    return counts
  }, [catalog.placements])
  const categoryById = useMemo(() => new Map(catalog.categories.map((category) => [category.id, category])), [catalog.categories])
  const visibleIconOptions = useMemo(() => {
    const query = iconSearch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('es')
    if (!query) return catalogIconOptions
    return catalogIconOptions.filter((option) => option.label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').includes(query))
  }, [iconSearch])

  async function createCategory() {
    if (!categoryName.trim()) return
    const saved = await mutate(() => catalogAdminService.saveCategory(catalog.venueId, { name: categoryName.trim(), active: true, unused: false, sortOrder: catalog.categories.length * 10 }))
    if (saved) setCategoryName('')
  }

  async function createTab() {
    if (!tabLabel.trim()) return
    const key = `${tabLabel.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'tab'}_${catalogAdminService.uuid().slice(0, 8)}`
    const saved = await mutate(() => catalogAdminService.saveTab(catalog.venueId, { key, label: tabLabel.trim(), icon: 'receipt', active: true, sortOrder: catalog.tabs.length * 10 }))
    if (saved) setTabLabel('')
  }

  function openTabEditor(tab: CatalogData['tabs'][number]) {
    setEditingTabId(tab.id)
    setEditingTabLabel(tab.label)
    setEditingTabIcon(tab.icon || 'receipt')
    setIconSearch('')
  }

  async function saveEditedTab() {
    const tab = catalog.tabs.find((item) => item.id === editingTabId)
    if (!tab || !editingTabLabel.trim()) return
    const saved = await mutate(() => catalogAdminService.saveTab(catalog.venueId, {
      ...tab,
      icon: editingTabIcon,
      label: editingTabLabel.trim(),
    }))
    if (saved) setEditingTabId(null)
  }

  async function move(entity: 'categories' | 'tabs' | 'tab_categories', items: readonly { id: string }[], id: string, direction: -1 | 1) {
    await mutate(() => catalogAdminService.reorder(catalog.venueId, { entity, items: toReorderItems(moveCatalogItem(items, id, direction)) }))
  }

  async function removeCategory(id: string, name: string) {
    const impact = placementsByCategory.get(id) ?? 0
    if (impact > 0) {
      window.alert(`“${name}” se usa en ${impact} apariciones. Muévelas o elimínalas antes de borrar la categoría.`)
      return
    }
    if (window.confirm(`Eliminar definitivamente la categoría “${name}”?`)) await mutate(() => catalogAdminService.deleteCategory(catalog.venueId, id))
  }

  async function removeTab(id: string, label: string) {
    const impact = placementsByTab.get(id) ?? 0
    if (impact > 0) {
      window.alert(`“${label}” contiene ${impact} apariciones. Muévelas o elimínalas antes de borrar la pestaña.`)
      return
    }
    if (window.confirm(`Eliminar definitivamente la pestaña “${label}”?`)) await mutate(() => catalogAdminService.deleteTab(catalog.venueId, id))
  }

  return (
    <div className="!grid !gap-4 xl:!grid-cols-2">
      <section className="crm-panel !overflow-hidden !rounded-2xl !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)]">
        <header className="!border-b !border-[var(--crm-border-subtle)] !p-5"><h2 className="!text-lg !font-bold">Categorías del local</h2><p className="!text-sm !text-[var(--crm-text-muted)]">Son globales y pueden aparecer en varias pestañas.</p><div className="!mt-4 !flex !gap-2"><input className="crm-input !min-w-0 !flex-1" onChange={(event) => setCategoryName(event.target.value)} placeholder="Nueva categoría" value={categoryName} /><button className="crm-primary-button" disabled={disabled || !categoryName.trim()} onClick={() => void createCategory()} type="button"><Plus className="!size-4" /> Añadir</button></div></header>
        <div className="!grid">
          {catalog.categories.map((category, index) => (
            <div className="!grid !grid-cols-[1fr_auto] !items-center !gap-3 !border-b !border-[var(--crm-border-subtle)] !p-4" key={category.id}>
              <div><strong>{category.name}</strong><small className="!ml-2 !text-[var(--crm-text-muted)]">{placementsByCategory.get(category.id) ?? 0} apariciones · {category.active ? 'Activa' : 'Inactiva'}</small></div>
              <div className="crm-action-group">
                <button aria-label="Subir categoría" className="crm-action-button" disabled={disabled || index === 0} onClick={() => void move('categories', catalog.categories, category.id, -1)} type="button"><ArrowUp className="!size-4" /></button>
                <button aria-label="Bajar categoría" className="crm-action-button" disabled={disabled || index === catalog.categories.length - 1} onClick={() => void move('categories', catalog.categories, category.id, 1)} type="button"><ArrowDown className="!size-4" /></button>
                <button aria-label="Editar categoría" className="crm-action-button" disabled={disabled} onClick={() => { const name = window.prompt('Nombre de la categoría', category.name)?.trim(); if (name) void mutate(() => catalogAdminService.saveCategory(catalog.venueId, { ...category, name })) }} type="button"><Pencil className="!size-4" /></button>
                <button aria-label={category.active ? 'Desactivar categoría' : 'Activar categoría'} className="crm-action-button" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.saveCategory(catalog.venueId, { ...category, active: !category.active }))} type="button">{category.active ? <EyeOff className="!size-4" /> : <Eye className="!size-4" />}</button>
                <button aria-label="Eliminar categoría" className="crm-action-button crm-danger-button" disabled={disabled} onClick={() => void removeCategory(category.id, category.name)} type="button"><Trash2 className="!size-4" /></button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="crm-panel !overflow-hidden !rounded-2xl !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)]">
        <header className="!border-b !border-[var(--crm-border-subtle)] !p-5"><h2 className="!text-lg !font-bold">Pestañas del TPV</h2><p className="!text-sm !text-[var(--crm-text-muted)]">Organizan la navegación del TPV, no duplican categorías.</p><div className="!mt-4 !flex !gap-2"><input className="crm-input !min-w-0 !flex-1" onChange={(event) => setTabLabel(event.target.value)} placeholder="Nueva pestaña" value={tabLabel} /><button className="crm-primary-button" disabled={disabled || !tabLabel.trim()} onClick={() => void createTab()} type="button"><Plus className="!size-4" /> Añadir</button></div></header>
        <div className="!grid">
          {catalog.tabs.map((tab, index) => (
            <div className="!grid !grid-cols-[1fr_auto] !items-center !gap-3 !border-b !border-[var(--crm-border-subtle)] !p-4" key={tab.id}>
              <div className="!flex !min-w-0 !items-center !gap-3"><span className="!grid !size-9 !shrink-0 !place-items-center !rounded-lg !bg-[var(--crm-surface-soft)] !text-[var(--crm-blue)]">{(() => { const Icon = getCatalogIconComponent(tab.icon); return <Icon className="!size-4" /> })()}</span><span className="!min-w-0"><strong className="!block !truncate">{tab.label}</strong><small className="!text-[var(--crm-text-muted)]">{placementsByTab.get(tab.id) ?? 0} apariciones · {tab.active ? 'Activa' : 'Inactiva'}</small></span></div>
              <div className="crm-action-group">
                <button aria-label="Subir pestaña" className="crm-action-button" disabled={disabled || index === 0} onClick={() => void move('tabs', catalog.tabs, tab.id, -1)} type="button"><ArrowUp className="!size-4" /></button>
                <button aria-label="Bajar pestaña" className="crm-action-button" disabled={disabled || index === catalog.tabs.length - 1} onClick={() => void move('tabs', catalog.tabs, tab.id, 1)} type="button"><ArrowDown className="!size-4" /></button>
                <button aria-label="Editar pestaña" className="crm-action-button" disabled={disabled} onClick={() => openTabEditor(tab)} type="button"><Pencil className="!size-4" /></button>
                <button aria-label={tab.active ? 'Desactivar pestaña' : 'Activar pestaña'} className="crm-action-button" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.saveTab(catalog.venueId, { ...tab, active: !tab.active }))} type="button">{tab.active ? <EyeOff className="!size-4" /> : <Eye className="!size-4" />}</button>
                <button aria-label="Eliminar pestaña" className="crm-action-button crm-danger-button" disabled={disabled} onClick={() => void removeTab(tab.id, tab.label)} type="button"><Trash2 className="!size-4" /></button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {editingTabId ? <CrmModal label="Editar pestaña del TPV" onClose={() => setEditingTabId(null)} size="large">
        <form className="!flex !min-h-0 !flex-1 !flex-col" onSubmit={(event) => { event.preventDefault(); void saveEditedTab() }}>
          <div className="!grid !min-h-0 !gap-5 !overflow-y-auto !px-5 !py-5">
            <label className="!grid !gap-1.5"><span className="!text-[11px] !font-semibold !text-[var(--crm-text-secondary)]">Nombre</span><input autoFocus className="crm-input !h-11 !w-full" disabled={disabled} onChange={(event) => setEditingTabLabel(event.target.value)} value={editingTabLabel} /></label>
            <fieldset disabled={disabled}>
              <legend className="!mb-2 !text-[11px] !font-semibold !text-[var(--crm-text-secondary)]">Icono visible</legend>
              <input aria-label="Buscar iconos" className="crm-input !mb-3 !h-10 !w-full" onChange={(event) => setIconSearch(event.target.value)} placeholder="Buscar icono…" value={iconSearch} />
              {visibleIconOptions.length ? <div className="!grid !grid-cols-3 !gap-2 sm:!grid-cols-5 md:!grid-cols-6">
                {visibleIconOptions.map(({ Icon, key, label }) => <button aria-label={`Usar icono ${label}`} aria-pressed={editingTabIcon === key} className={editingTabIcon === key ? '!grid !min-h-20 !place-items-center !gap-1.5 !rounded-[10px] !border !border-[var(--crm-blue)] !bg-[var(--crm-blue-soft)] !p-2 !text-xs !font-semibold !text-[var(--crm-blue)]' : '!grid !min-h-20 !place-items-center !gap-1.5 !rounded-[10px] !border !border-[var(--crm-border)] !bg-[var(--crm-surface-soft)] !p-2 !text-xs !font-semibold !text-[var(--crm-text-secondary)] hover:!border-[var(--crm-blue)]'} key={key} onClick={() => setEditingTabIcon(key)} type="button"><Icon className="!size-5" /><span>{label}</span></button>)}
              </div> : <p className="!rounded-lg !border !border-dashed !border-[var(--crm-border)] !p-5 !text-center !text-sm !text-[var(--crm-text-muted)]">No hay iconos que coincidan con la búsqueda.</p>}
            </fieldset>
          </div>
          <div className="!flex !justify-end !gap-2 !border-t !border-[var(--crm-border-subtle)] !px-5 !py-4"><button className="crm-secondary-button" disabled={disabled} onClick={() => setEditingTabId(null)} type="button">Cancelar</button><button className="crm-primary-button" disabled={disabled || !editingTabLabel.trim()} type="submit">Guardar cambios</button></div>
        </form>
      </CrmModal> : null}

      <section className="crm-panel !rounded-2xl !bg-[var(--crm-surface)] !p-5 !shadow-[var(--crm-shadow-card)] xl:!col-span-2">
        <h2 className="!text-lg !font-bold">Categorías dentro de cada pestaña</h2><p className="!text-sm !text-[var(--crm-text-muted)]">La misma categoría puede asociarse a varias pestañas y tener un orden diferente en cada una.</p>
        <div className="!mt-4 !grid !gap-2 md:!grid-cols-[1fr_1fr_auto]"><CrmSelect onChange={setAssociationTabId} options={catalog.tabs.map((tab) => ({ label: tab.label, value: tab.id }))} value={associationTabId} /><CrmSelect onChange={setAssociationCategoryId} options={catalog.categories.map((category) => ({ label: category.name, value: category.id }))} value={associationCategoryId} /><button className="crm-primary-button" disabled={disabled || !associationTabId || !associationCategoryId} onClick={() => void mutate(() => catalogAdminService.saveTabCategory(catalog.venueId, { tabId: associationTabId, categoryId: associationCategoryId, active: true, sortOrder: catalog.tabCategories.filter((item) => item.tabId === associationTabId).length * 10 }))} type="button"><Link2 className="!size-4" /> Asociar</button></div>
        <div className="!mt-4 !grid !gap-2">
          {catalog.tabs.map((tab) => {
            const associations = catalog.tabCategories.filter((item) => item.tabId === tab.id)
            return <div className="!rounded-xl !bg-[var(--crm-surface-soft)] !p-4" key={tab.id}><strong>{tab.label}</strong><div className="!mt-2 !grid !gap-2">{associations.map((association, index) => <div className="!flex !items-center !justify-between !gap-3" key={association.id}><span>{categoryById.get(association.categoryId)?.name ?? 'Categoría'} · {association.active ? 'Visible' : 'Oculta'}</span><div className="crm-action-group"><button aria-label="Subir asociación" className="crm-action-button" disabled={disabled || index === 0} onClick={() => void move('tab_categories', associations, association.id, -1)} type="button"><ArrowUp className="!size-4" /></button><button aria-label="Bajar asociación" className="crm-action-button" disabled={disabled || index === associations.length - 1} onClick={() => void move('tab_categories', associations, association.id, 1)} type="button"><ArrowDown className="!size-4" /></button><button aria-label="Activar o desactivar asociación" className="crm-action-button" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.saveTabCategory(catalog.venueId, { ...association, active: !association.active }))} type="button">{association.active ? <EyeOff className="!size-4" /> : <Eye className="!size-4" />}</button><button aria-label="Eliminar asociación" className="crm-action-button crm-danger-button" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.deleteTabCategory(catalog.venueId, association.id))} type="button"><Trash2 className="!size-4" /></button></div></div>)}</div></div>
          })}
        </div>
      </section>
    </div>
  )
}
