import { GlassWater } from 'lucide-react'
import { formatMoney } from '../../lib/format'

type PosMixerCardProps = {
  disabled: boolean
  imageUrl?: string | null
  label: string
  onSelect: (sourceElement: HTMLButtonElement) => void
  selected: boolean
  supplementCents?: number
}

export function PosMixerCard({ disabled, imageUrl, label, onSelect, selected, supplementCents = 0 }: PosMixerCardProps) {
  return (
    <button
      aria-pressed={selected}
      className={`group grid h-28 min-h-28 w-full min-w-0 appearance-none grid-cols-[6rem_minmax(0,1fr)] overflow-hidden rounded-[var(--radius)] border p-0 text-left text-[var(--foreground)] shadow-sm transition-[border-color,background-color,box-shadow] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:pointer-events-none disabled:opacity-45 ${
        selected
          ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-[0_0_0_1px_var(--accent)]'
          : 'border-[var(--separator)] bg-[var(--background)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:shadow-md'
      }`}
      disabled={disabled}
      onClick={(event) => onSelect(event.currentTarget)}
      type="button"
    >
      <span className="grid h-28 min-h-28 w-24 shrink-0 place-items-center overflow-hidden bg-[var(--surface-secondary)] text-[var(--accent)]">
        {imageUrl ? (
          <img
            alt={label}
            className="block h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
            decoding="async"
            loading="lazy"
            src={imageUrl}
          />
        ) : (
          <GlassWater aria-hidden="true" className="h-9 w-9" />
        )}
      </span>
      <span className="flex min-w-0 flex-col justify-center gap-1 px-4 py-3">
        <span className="line-clamp-2 block text-base font-medium leading-snug">{label}</span>
        {supplementCents ? (
          <span className="block text-sm text-[var(--muted)]">+{formatMoney(supplementCents)}</span>
        ) : null}
      </span>
    </button>
  )
}
