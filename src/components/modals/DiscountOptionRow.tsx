type DiscountOptionRowProps = {
  color?: string | null;
  disabled: boolean;
  label: string;
  onSelect: () => void;
  roundingLabel?: string | null;
  valueLabel: string;
};

export function DiscountOptionRow({
  color,
  disabled,
  label,
  onSelect,
  roundingLabel,
  valueLabel,
}: DiscountOptionRowProps) {
  return (
    <button
      className="flex min-h-14 w-full items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] px-4 py-3 text-left text-[var(--foreground)] shadow-sm transition-[border-color,background-color] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:pointer-events-none disabled:opacity-45"
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      <span className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="h-3 w-3 shrink-0 rounded-full border border-black/10"
          style={{ backgroundColor: color ?? "var(--accent)" }}
        />
        <strong className="truncate">{label}</strong>
      </span>
      <span className="flex shrink-0 flex-col items-end">
        <strong className="font-mono">{valueLabel}</strong>
        {roundingLabel ? (
          <small className="text-xs text-[var(--muted)]">{roundingLabel}</small>
        ) : null}
      </span>
    </button>
  );
}
