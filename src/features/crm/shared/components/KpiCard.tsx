const kpiColorClasses = {
  blue: {
    card: "!bg-[var(--crm-blue)]",
    label: "!text-white/85",
    value: "!text-white",
  },
  green: {
    card: "!bg-[var(--crm-green)]",
    label: "!text-white/85",
    value: "!text-white",
  },
  neutral: {
    card: "!bg-[var(--crm-surface-soft)]",
    label: "!text-[var(--crm-text-secondary)]",
    value: "!text-[var(--crm-text)]",
  },
} as const;

export function KpiCard({
  color,
  label,
  value,
}: {
  color: keyof typeof kpiColorClasses;
  label: string;
  value: number | string;
}) {
  const colorClasses = kpiColorClasses[color];

  return (
    <div
      className={`!flex !min-h-[126px] !flex-col !items-start !justify-end !rounded-[18px] !border-0 !p-[22px] !text-left md:!min-h-[150px] ${colorClasses.card}`}
    >
      <strong
        className={`!text-[26px] !leading-none !font-bold !tracking-[-0.04em] !tabular-nums ${colorClasses.value}`}
      >
        {value}
      </strong>
      <span className={`!mt-[9px] !text-xs !font-medium ${colorClasses.label}`}>
        {label}
      </span>
    </div>
  );
}

