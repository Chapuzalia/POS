import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import type { CatalogPlacement, CatalogTab, Category, Product, TenantContext } from '../../../../types'
import type { RunAction } from '../../shared/types'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { createCatalogPlacement, createCatalogTab, setCatalogPlacementActive, setCatalogTabActive } from '../services/catalogService'

type Props = { context: TenantContext; venueId: string; tabs: CatalogTab[]; placements: CatalogPlacement[]; categories: Category[]; products: Product[]; disabled: boolean; runAction: RunAction; onCatalogChanged: () => Promise<void> }

export function CatalogOrganizationCrm({ context, venueId, tabs, placements, categories, products, disabled, runAction, onCatalogChanged }: Props) {
  const [tabLabel, setTabLabel] = useState('')
  const [tabId, setTabId] = useState(tabs[0]?.id ?? '')
  const [productId, setProductId] = useState(products[0]?.id ?? '')
  const product = products.find((item) => item.id === productId)
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '')
  const [variantId, setVariantId] = useState('')
  const productById = useMemo(() => new Map(products.map((item) => [item.id, item])), [products])
  const categoryById = useMemo(() => new Map(categories.map((item) => [item.id, item])), [categories])
  const tabById = useMemo(() => new Map(tabs.map((item) => [item.id, item])), [tabs])

  async function refresh(action: () => Promise<void>) { await runAction(async () => { await action(); await onCatalogChanged() }) }

  return <div className="grid gap-4 xl:grid-cols-2">
    <section className="rounded-2xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]">
      <h2 className="text-lg font-bold">Pestanas del TPV</h2>
      <p className="mt-1 text-sm text-[var(--crm-text-muted)]">Son independientes de los formatos de venta.</p>
      <div className="mt-4 flex gap-2">
        <input className="crm-input min-w-0 flex-1" placeholder="Nueva pestana" value={tabLabel} onChange={(event) => setTabLabel(event.target.value)} />
        <button className="crm-primary-button" disabled={disabled || !tabLabel.trim()} onClick={() => void refresh(async () => { await createCatalogTab(context, { venueId, label: tabLabel, icon: 'receipt', sortOrder: tabs.length * 10 }); setTabLabel('') })} type="button"><Plus className="h-4 w-4" /> Anadir</button>
      </div>
      <div className="mt-4 grid gap-2">{tabs.map((tab) => <div className="flex items-center justify-between rounded-xl bg-[var(--crm-surface-soft)] p-3" key={tab.id}><span><strong>{tab.label}</strong><small className="ml-2 text-[var(--crm-text-muted)]">{tab.key}</small></span><button className="crm-secondary-button" disabled={disabled} onClick={() => void refresh(() => setCatalogTabActive(context, tab.id, !tab.isActive))} type="button">{tab.isActive ? 'Desactivar' : 'Activar'}</button></div>)}</div>
    </section>

    <section className="rounded-2xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]">
      <h2 className="text-lg font-bold">Colocaciones</h2>
      <p className="mt-1 text-sm text-[var(--crm-text-muted)]">Un producto puede aparecer en varias pestanas y categorias.</p>
      <div className="mt-4 grid gap-3">
        <CrmSelect options={tabs.filter((item) => item.isActive).map((item) => ({ label: item.label, value: item.id }))} value={tabId} onChange={setTabId} />
        <CrmSelect options={products.filter((item) => item.isActive).map((item) => ({ label: item.name, value: item.id }))} value={productId} onChange={(value) => { setProductId(value); setVariantId('') }} />
        <CrmSelect options={categories.filter((item) => item.isActive).map((item) => ({ label: item.name, value: item.id }))} value={categoryId} onChange={setCategoryId} />
        <CrmSelect options={[{ label: 'Variante predeterminada del producto', value: '' }, ...(product?.variants.filter((item) => item.isActive).map((item) => ({ label: `${item.name}`, value: item.id })) ?? [])]} value={variantId} onChange={setVariantId} />
        <button className="crm-primary-button" disabled={disabled || !tabId || !productId || !categoryId} onClick={() => void refresh(() => createCatalogPlacement(context, { venueId, tabId, productId, categoryId, defaultVariantId: variantId || null, isFeatured: false, sortOrder: placements.length * 10 }))} type="button"><Plus className="h-4 w-4" /> Anadir colocacion</button>
      </div>
      <div className="mt-4 grid gap-2">{placements.map((placement) => <div className="flex items-center justify-between rounded-xl bg-[var(--crm-surface-soft)] p-3" key={placement.id}><span className="text-sm"><strong>{productById.get(placement.productId)?.name ?? 'Producto'}</strong><br />{tabById.get(placement.tabId)?.label ?? 'Pestana'} / {categoryById.get(placement.categoryId)?.name ?? 'Categoria'}</span><button className="crm-secondary-button" disabled={disabled} onClick={() => void refresh(() => setCatalogPlacementActive(context, placement.id, !placement.isActive))} type="button">{placement.isActive ? 'Ocultar' : 'Mostrar'}</button></div>)}</div>
    </section>
  </div>
}

