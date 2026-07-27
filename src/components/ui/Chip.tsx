import { Chip as HeroChip } from '@heroui/react'
import type { LucideIcon } from 'lucide-react'

type ChipProps = {
  children?: string
  icon?: LucideIcon
  tone?: 'default' | 'success' | 'danger' | 'warning'
}

export function Chip({ children, icon: Icon, tone = 'default' }: ChipProps) {
  return (
    <HeroChip color={tone} className="p-1" variant={tone === 'default' ? 'secondary' : 'soft'}>
      {Icon ? <Icon aria-hidden="true" className="size-4" /> : null}
      {children ? <HeroChip.Label>{children ?? null}</HeroChip.Label> : null}
    </HeroChip>
  )
}
