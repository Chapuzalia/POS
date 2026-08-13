type PosCategoryCardProps = {
  count: number;
  disabled: boolean;
  label: string;
  onSelect: () => void;
};

export function PosCategoryCard({
  count,
  disabled,
  label,
  onSelect,
}: PosCategoryCardProps) {
  return (
    <button
      className="group flex min-h-0 w-full min-w-0 appearance-none flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-0 text-left text-[var(--foreground)] shadow-sm transition-[border-color,background-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:pointer-events-none disabled:opacity-45"
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      <span className="flex min-h-[98px] w-full flex-1 flex-col justify-between gap-2 p-3">
        <span className="line-clamp-2 block text-2xl max-md:text-lg font-bold leading-snug">
          {label}
        </span>
        <span className="block text-xs font-medium text-[var(--muted)]">
          {count} productos
        </span>
      </span>
    </button>
  );
}
