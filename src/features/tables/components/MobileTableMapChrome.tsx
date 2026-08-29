import { Dropdown, Label } from '@heroui/react'
import { Check, ChevronDown, Pencil, Plus, ShoppingBag } from 'lucide-react'

import { Button as UiButton } from '../../../components/ui/Button'
import type { DiningArea } from '../types'

type Props = {
  activeAreaId?: string
  areas: DiningArea[]
  canQuickSale: boolean
  canCreateVirtual: boolean
  editDisabled: boolean
  editMode: boolean
  onAreaChange: (areaId: string) => void
  onEditToggle: () => void
  onCreateVirtual: () => void
  onQuickSale: () => void
}

export function MobileTableMapChrome({
  activeAreaId,
  areas,
  canQuickSale,
  canCreateVirtual,
  editDisabled,
  editMode,
  onAreaChange,
  onEditToggle,
  onCreateVirtual,
  onQuickSale,
}: Props) {
  const activeArea = areas.find((area) => area.id === activeAreaId) ?? areas[0]
  const activeAreaIndex = Math.max(0, areas.findIndex((area) => area.id === activeArea?.id))

  return (
    <>
      <div className="pointer-events-auto absolute left-3 top-3 z-30">
        {areas.length > 1 ? (
          <Dropdown>
            <Dropdown.Trigger
              aria-label={`Cambiar sala. Sala actual: ${activeArea?.name ?? 'Sin sala'}`}
              className="inline-flex min-h-10 max-w-[min(58vw,220px)] items-center gap-2 rounded-full border border-[var(--separator)] bg-[color-mix(in_srgb,var(--surface)_96%,transparent)] px-2.5 text-xs font-extrabold text-[var(--foreground)] shadow-[var(--shadow)]"
            >
              <span aria-hidden="true" className="flex shrink-0 items-center gap-1">
                {areas.map((area) => (
                  <span
                    className={`h-1.5 rounded-full transition-[width,background-color] ${area.id === activeArea?.id ? "w-5 bg-[var(--accent)]" : "w-1.5 bg-[var(--separator)]"}`}
                    key={area.id}
                  />
                ))}
              </span>
              <span className="truncate">{activeArea?.name ?? 'Sala'}</span>
              <ChevronDown className="size-3.5 shrink-0" />
              <span className="sr-only">
                Sala {activeAreaIndex + 1} de {areas.length} seleccionada
              </span>
            </Dropdown.Trigger>
            <Dropdown.Popover className="!w-[min(280px,calc(100vw-24px))]">
              <Dropdown.Menu onAction={(key) => onAreaChange(String(key))} selectionMode="single" selectedKeys={activeAreaId ? new Set([activeAreaId]) : new Set()}>
                {areas.map((area) => (
                  <Dropdown.Item className="flex min-h-11 items-center" id={area.id} key={area.id} textValue={area.name}>
                    <Label>{area.name}</Label>
                  </Dropdown.Item>
                ))}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        ) : (
          <div className="inline-flex min-h-10 max-w-[min(58vw,220px)] items-center gap-2 rounded-full border border-[var(--separator)] bg-[color-mix(in_srgb,var(--surface)_96%,transparent)] px-2.5 text-xs font-extrabold text-[var(--foreground)] shadow-[var(--shadow)]">
            <span aria-hidden="true" className="h-1.5 w-5 shrink-0 rounded-full bg-[var(--accent)]" />
            <span className="truncate">{activeArea?.name ?? 'Sala'}</span>
          </div>
        )}
      </div>

      <div className="pointer-events-auto absolute right-3 top-3 z-30 grid justify-items-end gap-2">
        <div className="flex items-center justify-end gap-2">
          {canCreateVirtual && !editMode ? (
            <UiButton
              aria-label="Crear mesa virtual"
              className="inline-flex size-11 min-h-11 min-w-11 items-center justify-center rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] text-[var(--foreground)] shadow-[var(--shadow)]"
              onClick={onCreateVirtual}
              type="button"
            >
              <Plus className="size-[18px]" />
            </UiButton>
          ) : null}
          <UiButton
            aria-label={editMode ? 'Finalizar edición de mesas' : 'Editar mesas'}
            aria-pressed={editMode}
            className={`inline-flex size-11 min-h-11 min-w-11 items-center justify-center rounded-[var(--radius)] border shadow-[var(--shadow)] ${editMode ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]' : 'border-[var(--separator)] bg-[var(--surface)] text-[var(--foreground)]'}`}
            disabled={editDisabled}
            onClick={onEditToggle}
            type="button"
          >
            {editMode ? <Check className="size-[18px]" /> : <Pencil className="size-[18px]" />}
          </UiButton>
        </div>

        {editMode ? (
          <div className="rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--surface)] px-3 py-2 text-right shadow-[var(--shadow)]">
            <strong className="block text-xs text-[var(--accent)]">Editando mesas</strong>
            <small className="block text-[10px] font-semibold text-[var(--muted)]">Guardado automático</small>
          </div>
        ) : canQuickSale ? (
          <UiButton
            aria-label="Venta rápida"
            className="inline-flex size-11 min-h-11 min-w-11 items-center justify-center rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)] shadow-[var(--shadow)]"
            onClick={onQuickSale}
            type="button"
          >
            <ShoppingBag className="size-[18px]" />
          </UiButton>
        ) : null}
      </div>
    </>
  )
}
