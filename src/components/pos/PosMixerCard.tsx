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
      className={`group flex min-h-[228px] w-full min-w-0 appearance-none flex-col overflow-hidden rounded-[var(--radius)] border p-0 text-left text-[var(--foreground)] shadow-sm transition-[border-color,background-color,box-shadow,transform] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:pointer-events-none disabled:opacity-45 ${
        selected
          ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-[0_0_0_1px_var(--accent)]'
          : 'border-[var(--separator)] bg-[var(--background)] hover:-translate-y-0.5 hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:shadow-md'
      }`}
      disabled={disabled}
      onClick={(event) => onSelect(event.currentTarget)}
      type="button"
    >
      <span className="relative grid aspect-square w-full shrink-0 place-items-center overflow-hidden bg-[var(--surface-secondary)] text-[var(--accent)]">
        {imageUrl ? (
          <img
            alt={label}
            className="absolute inset-0 block size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
            decoding="async"
            loading="lazy"
            src={imageUrl}
          />
        ) : (
          <GlassWater aria-hidden="true" className="h-9 w-9" />
        )}
      </span>
      <span className="flex min-h-[88px] w-full flex-1 flex-col justify-between gap-2 p-3">
        <span className="line-clamp-2 block text-sm font-bold leading-snug">{label}</span>
        <span className="block font-mono text-lg font-black tabular-nums">
          {supplementCents ? `+${formatMoney(supplementCents)}` : 'Incluido'}
        </span>
      </span>
    </button>
  )
}
