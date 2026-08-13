import { Dropdown, Label } from '@heroui/react'
import { Check, ChevronDown, Pencil, ShoppingBag } from 'lucide-react'

import { Button as UiButton } from '../../../components/ui/Button'
import type { DiningArea } from '../types'

type Props = {
  activeAreaId?: string
  areas: DiningArea[]
  canQuickSale: boolean
  editDisabled: boolean
  editMode: boolean
  onAreaChange: (areaId: string) => void
  onEditToggle: () => void
  onQuickSale: () => void
}

export function MobileTableMapChrome({
  activeAreaId,
  areas,
  canQuickSale,
  editDisabled,
  editMode,
  onAreaChange,
  onEditToggle,
  onQuickSale,
}: Props) {
  const activeArea = areas.find((area) => area.id === activeAreaId) ?? areas[0]

  return (
    <>
      <div className="pointer-events-auto absolute left-3 top-3 z-30">
        {areas.length > 1 ? (
          <Dropdown>
            <Dropdown.Trigger
              aria-label={`Cambiar sala. Sala actual: ${activeArea?.name ?? 'Sin sala'}`}
              className="inline-flex min-h-11 max-w-[min(58vw,220px)] items-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] px-3 text-sm font-extrabold text-[var(--foreground)] shadow-[var(--shadow)]"
            >
              <span className="truncate">{activeArea?.name ?? 'Sala'}</span>
              <ChevronDown className="size-4 shrink-0" />
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
          <div className="inline-flex min-h-11 max-w-[min(58vw,220px)] items-center rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] px-3 text-sm font-extrabold text-[var(--foreground)] shadow-[var(--shadow)]">
            <span className="truncate">{activeArea?.name ?? 'Sala'}</span>
          </div>
        )}
      </div>

      <div className="pointer-events-auto absolute right-3 top-3 z-30 grid justify-items-end gap-2">
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
