import type { LucideIcon } from "lucide-react";

type PosCategoryCardProps = {
  count: number;
  disabled: boolean;
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
};

export function PosCategoryCard({
  count,
  disabled,
  icon: CategoryIcon,
  label,
  onSelect,
}: PosCategoryCardProps) {
  return (
    <button
      className="group flex min-h-[228px] w-full min-w-0 appearance-none flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-0 text-left text-[var(--foreground)] shadow-sm transition-[border-color,background-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:pointer-events-none disabled:opacity-45"
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      <span className="grid aspect-square w-full shrink-0 place-items-center overflow-hidden bg-[var(--surface-secondary)] text-[var(--accent)]">
        <CategoryIcon aria-hidden="true" className="h-10 w-10" />
      </span>
      <span className="flex min-h-[88px] w-full flex-1 flex-col justify-between gap-2 p-3">
        <span className="line-clamp-2 block text-sm font-bold leading-snug">
          {label}
        </span>
        <span className="block text-xs font-medium text-[var(--muted)]">
          {count} productos
        </span>
      </span>
    </button>
  );
}
