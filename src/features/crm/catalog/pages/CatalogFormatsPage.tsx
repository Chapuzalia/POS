import { ArrowDown, ArrowUp, Eye, EyeOff, Pencil, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { CatalogData } from '../../../catalog/domain/types.ts'
import { EmptyList } from '../../shared/components/EmptyList.tsx'
import { CatalogPanel, CatalogPanelHeader, CatalogStatus } from '../components/CatalogUi.tsx'
import { catalogAdminService } from '../services/catalogAdminService.ts'
import { moveCatalogItem, toReorderItems } from '../services/catalogAdminModel.ts'

type Props = {
  catalog: CatalogData
  disabled: boolean
  mutate: (action: () => Promise<unknown>) => Promise<boolean>
}

export function CatalogFormatsCrm({ catalog, disabled, mutate }: Props) {
  const [name, setName] = useState('')
  const usageByFormat = useMemo(() => {
    const counts = new Map<string, number>()
    for (const variant of catalog.variants) {
      if (variant.formatId) counts.set(variant.formatId, (counts.get(variant.formatId) ?? 0) + 1)
    }
    return counts
  }, [catalog.variants])

  async function createFormat() {
    const nextName = name.trim()
    if (!nextName) return
    const saved = await mutate(() => catalogAdminService.saveSaleFormat(catalog.venueId, {
      name: nextName,
      active: true,
      sortOrder: catalog.saleFormats.length * 10,
    }))
    if (saved) setName('')
  }

  async function moveFormat(id: string, direction: -1 | 1) {
    const reordered = moveCatalogItem(catalog.saleFormats, id, direction)
    await mutate(() => catalogAdminService.reorderSaleFormats(catalog.venueId, toReorderItems(reordered)))
  }

  async function renameFormat(id: string, currentName: string) {
    const format = catalog.saleFormats.find((item) => item.id === id)
    const nextName = window.prompt('Nombre del formato', currentName)?.trim()
    if (!format || !nextName || nextName === currentName) return
    await mutate(() => catalogAdminService.saveSaleFormat(catalog.venueId, { ...format, name: nextName }))
  }

  async function deleteFormat(id: string, formatName: string) {
    const usage = usageByFormat.get(id) ?? 0
    if (usage > 0) {
      window.alert(`“${formatName}” se utiliza en ${usage} variantes. Cambia esas variantes antes de eliminar el formato.`)
      return
    }
    if (window.confirm(`¿Eliminar definitivamente el formato “${formatName}”?`)) {
      await mutate(() => catalogAdminService.deleteSaleFormat(catalog.venueId, id))
    }
  }

  return (
    <CatalogPanel>
      <CatalogPanelHeader
        description="Define los formatos reutilizables que pueden asignarse a las variantes de cada producto."
        title="Formatos de venta"
      >
        <div className="!flex !max-w-xl !gap-2">
          <input
            aria-label="Nombre del nuevo formato"
            className="crm-input !min-w-0 !flex-1"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void createFormat() }}
            placeholder="Ej. Copa, Botella, Chupito…"
            value={name}
          />
          <button className="crm-primary-button" disabled={disabled || !name.trim()} onClick={() => void createFormat()} type="button">
            <Plus className="!size-4" /> Añadir formato
          </button>
        </div>
      </CatalogPanelHeader>

      <div className="!grid !overflow-auto">
        {catalog.saleFormats.map((format, index) => (
          <div className="!grid !min-h-[72px] !min-w-[720px] !grid-cols-[minmax(180px,1fr)_130px_130px_auto] !items-center !gap-3 !border-b !border-[var(--crm-border-subtle)] !px-[22px] !py-3 !text-sm" key={format.id}>
            <strong className="!text-[var(--crm-text)]">{format.name}</strong>
            <span className="!text-[var(--crm-text-secondary)]">{usageByFormat.get(format.id) ?? 0} variantes</span>
            <CatalogStatus active={format.active} />
            <div className="crm-action-group">
              <button aria-label="Subir formato" className="crm-action-button" disabled={disabled || index === 0} onClick={() => void moveFormat(format.id, -1)} type="button"><ArrowUp className="!size-4" /></button>
              <button aria-label="Bajar formato" className="crm-action-button" disabled={disabled || index === catalog.saleFormats.length - 1} onClick={() => void moveFormat(format.id, 1)} type="button"><ArrowDown className="!size-4" /></button>
              <button aria-label={`Editar ${format.name}`} className="crm-action-button" disabled={disabled} onClick={() => void renameFormat(format.id, format.name)} type="button"><Pencil className="!size-4" /></button>
              <button aria-label={format.active ? `Desactivar ${format.name}` : `Activar ${format.name}`} className="crm-action-button" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.saveSaleFormat(catalog.venueId, { ...format, active: !format.active }))} type="button">{format.active ? <EyeOff className="!size-4" /> : <Eye className="!size-4" />}</button>
              <button aria-label={`Eliminar ${format.name}`} className="crm-action-button crm-danger-button" disabled={disabled} onClick={() => void deleteFormat(format.id, format.name)} type="button"><Trash2 className="!size-4" /></button>
            </div>
          </div>
        ))}
        {!catalog.saleFormats.length ? <EmptyList message="Todavía no hay formatos. Añade el primero para poder crear variantes de producto." /> : null}
      </div>
    </CatalogPanel>
  )
}
