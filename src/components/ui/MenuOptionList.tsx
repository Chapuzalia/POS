import { Search } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { ResolvedCatalogSelectionOption } from '../../features/catalog/domain/types'
import { normalizeText } from '../../lib/format'
import { Input } from './Input'

type Props = {
  disabled: boolean
  groupLabel: string
  options: ResolvedCatalogSelectionOption[]
  renderOption: (option: ResolvedCatalogSelectionOption) => ReactNode
}

export function MenuOptionList({ disabled, groupLabel, options, renderOption }: Props) {
  const [search, setSearch] = useState('')
  const searchable = options.length > 6
  const query = searchable ? normalizeText(search.trim()) : ''
  const visibleOptions = query ? options.filter((option) => normalizeText(`${option.product.name} ${option.variant.name}`).includes(query)) : options

  return <>
    {searchable ? <div className="relative mb-3">
      <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 z-10 h-5 w-5 -translate-y-1/2 text-[var(--muted)]" />
      <Input aria-label={`Buscar platos en ${groupLabel}`} className="!min-h-11 !rounded-[12px] !pl-10" disabled={disabled} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar plato…" type="search" value={search} />
    </div> : null}
    <div className="grid items-start gap-2 sm:grid-cols-2">{visibleOptions.map(renderOption)}</div>
    {!options.length ? <p className="py-4 text-sm text-[var(--muted)]">No hay platos disponibles en este pase.</p>
      : !visibleOptions.length ? <p className="py-4 text-sm text-[var(--muted)]" role="status">No hay platos que coincidan con la búsqueda.</p> : null}
  </>
}
