import { Card } from '@heroui/react'

type MetricProps = {
  label: string
  value: string
  tone?: 'default' | 'success' | 'danger'
}

export function Metric({ label, tone = 'default', value }: MetricProps) {
  return (
    <Card
      className={
        tone === 'success'
          ? 'border-success/35 bg-success-soft border-1'
          : tone === 'danger'
            ? 'border-danger/35 bg-danger-soft border-1'
            : 'border-1'
      }
      variant="secondary"
    >
      <Card.Content className="gap-1 p-3">
        <p className="text-xs font-semibold uppercase text-muted">{label}</p>
        <p className="font-mono text-xl font-bold tabular-nums text-foreground">{value}</p>
      </Card.Content>
    </Card>
  )
}
