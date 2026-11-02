import { formatMoney } from "../../../../lib/format"
import type { CrmStats } from "../../../../types"

export function TopProductsList({ stats }: { stats: CrmStats | null }) {
  return (
    <div className="grid gap-[9px] px-[22px] pt-3 pb-[22px]">
      {(stats?.topProducts ?? []).map((product, index) => (
        <div className="flex min-h-[52px] min-w-0 items-center justify-between gap-3 rounded-[var(--crm-radius-sm)] bg-[var(--crm-surface-soft)] px-[13px] py-[11px]" key={product.productName}>
          <span className="!grid !size-[30px] !shrink-0 !place-items-center !rounded-[9px] !bg-[var(--crm-blue-soft)] !text-xs !font-semibold !text-[var(--crm-blue)]">{index + 1}</span>
          <div className="!grid !min-w-0 !flex-1 !gap-0.5">
            <strong className="!truncate !text-sm !font-semibold">{product.productName}</strong>
            <small className="!text-xs !text-[var(--crm-text-secondary)]">{product.quantity} uds</small>
          </div>
          <b className="!whitespace-nowrap !text-[15px] !font-semibold !tabular-nums">{formatMoney(product.totalCents)}</b>
        </div>
      ))}
    </div>
  )
}

