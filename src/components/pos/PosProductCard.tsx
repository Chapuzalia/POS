import type { LucideIcon } from "lucide-react";
import type { ResolvedCatalogItem } from "../../features/catalog/domain/types";
import { formatMoney } from "../../lib/format";

type PosProductCardProps = {
  disabled: boolean;
  formatCount: number;
  icon: LucideIcon;
  item: ResolvedCatalogItem;
  onSelect: (sourceElement: HTMLButtonElement) => void;
};

export function PosProductCard({
  disabled,
  formatCount,
  icon: ProductIcon,
  item,
  onSelect,
}: PosProductCardProps) {
  const isMenu = item.product.type === "menu";
  const menuCourseCount = item.selectionGroups.filter((group) => group.group.type === "menu_component").length;
  return (
    <button
      className="group flex min-h-[228px] w-full min-w-0 appearance-none flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-0 text-left text-[var(--foreground)] shadow-sm transition-[border-color,background-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:pointer-events-none disabled:opacity-45"
      disabled={disabled}
      onClick={(event) => onSelect(event.currentTarget)}
      type="button"
    >
      <span className="relative grid aspect-square w-full shrink-0 place-items-center overflow-hidden bg-[var(--surface-secondary)] text-[var(--accent)]">
        {isMenu ? <span className="absolute left-2 top-2 z-[1] rounded-full bg-[var(--foreground)] px-2.5 py-1 text-[11px] font-black uppercase tracking-wide text-[var(--background)]">Menú</span> : null}
        {item.image?.publicUrl ? (
          <img
            alt={item.product.name}
            className="absolute inset-0 block size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
            decoding="async"
            loading="lazy"
            src={item.image.publicUrl}
          />
        ) : (
          <ProductIcon aria-hidden="true" className="" />
        )}
      </span>
      <span className="flex min-h-[88px] w-full flex-1 flex-col justify-between gap-2 p-3">
        <span className="min-w-0">
          <span className="line-clamp-2 block text-lg max-md:text-base font-bold leading-snug">
            {item.product.name}
          </span>
          {formatCount > 1 ? (
            <span className="mt-1 block text-xs font-medium text-[var(--muted)]">
              {formatCount} formatos{isMenu && menuCourseCount ? ` · ${menuCourseCount} elecciones` : ""}
            </span>
          ) : isMenu && menuCourseCount ? <span className="mt-1 block text-xs font-medium text-[var(--muted)]">{menuCourseCount} elecciones</span> : null}
        </span>
        {formatCount === 1 ? (
          <span className="block font-mono text-lg font-black tabular-nums">
            {isMenu ? "Desde " : ""}{formatMoney(item.basePriceCents)}
          </span>
        ) : null}
      </span>
    </button>
  );
}
