import type { LucideIcon } from "lucide-react";

type PosCatalogTabProps = {
  active?: boolean;
  ariaLabel?: string;
  disabled?: boolean;
  busy?: boolean;
  iconClassName?: string;
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  size?: "md" | "lg";
  tone?: "default" | "danger" | "success";
};

export function PosCatalogTab({
  active = false,
  ariaLabel,
  disabled = false,
  busy = false,
  iconClassName = "",
  icon: TabIcon,
  label,
  onSelect,
  size = "md",
  tone = "default",
}: PosCatalogTabProps) {
  const stateClassName =
    tone === "success"
      ? "border-[var(--success)] bg-[var(--success-soft)] text-[var(--success)] shadow-[0_0_0_1px_var(--success)]"
      : tone === "danger"
      ? "border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]"
      : active
        ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)] shadow-[0_0_0_1px_var(--accent)]"
        : "border-[var(--separator)] bg-[var(--background)] text-[var(--foreground)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]";

  return (
    <button
      aria-label={ariaLabel}
      aria-current={active ? "page" : undefined}
      aria-busy={busy || undefined}
      className={`flex w-full min-w-0 appearance-none items-center justify-center rounded-[var(--radius)] border px-3 py-2 shadow-sm transition-[border-color,background-color,box-shadow,color,transform] duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:pointer-events-none ${busy ? "motion-safe:scale-[0.98]" : "disabled:opacity-45"} ${size === "lg" ? "h-20 min-h-20" : "h-14 min-h-14"} ${stateClassName}`}
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      <span className="flex min-w-0 flex-col items-center justify-center gap-1">
        <TabIcon
          aria-hidden="true"
          className={`${size === "lg" ? "h-6 w-6 shrink-0" : "h-5 w-5 shrink-0"} ${iconClassName}`}
        />
        <span className={`block max-w-full truncate font-medium leading-none ${size === "lg" ? "text-base" : "text-xs"}`}>
          {label}
        </span>
      </span>
    </button>
  );
}
