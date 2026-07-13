import { CheckCircle2, CircleHelp, Coins, CreditCard, Gift, type LucideIcon } from 'lucide-react'
import type { PaymentMethod } from '../../types'
import { Button } from '../ui'

const paymentOptions: Array<{ id: PaymentMethod; label: string; icon: LucideIcon }> = [
  { id: 'cash', label: 'Efectivo', icon: Coins },
  { id: 'card', label: 'Tarjeta', icon: CreditCard },
  { id: 'invitation', label: 'Invitacion', icon: Gift },
  { id: 'other', label: 'Otro', icon: CircleHelp },
]

type PaymentPanelProps = {
  disabled: boolean
  feedback: PaymentMethod | null
  heading?: string
  onPayment: (method: PaymentMethod) => void
}

export function PaymentPanel({ disabled, feedback, heading, onPayment }: PaymentPanelProps) {
  return (
    <section className="space-y-2">
      {heading ? <h2 className="text-sm font-black uppercase tracking-wide text-[var(--foreground)]">{heading}</h2> : null}
      <div className="gap-2 flex flex-row xl:grid-cols-4">
        {paymentOptions.map((payment) => {
          const Icon = feedback === payment.id ? CheckCircle2 : payment.icon
          return (
            <Button
              disabled={disabled}
              fullWidth
              key={payment.id}
              onClick={() => onPayment(payment.id)}
              size="lg"
              className="flex flex-col items-center justify-center"
              type="button"
              variant={feedback === payment.id ? 'primary' : 'secondary'}
            >
              <Icon className="h-6 w-6" />
            </Button>
          )
        })}
      </div>
    </section>
  )
}
