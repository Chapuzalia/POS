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
  onPayment: (method: PaymentMethod) => void
}

export function PaymentPanel({ disabled, feedback, onPayment }: PaymentPanelProps) {
  return (
    <section className="shrink-0 rounded-(--radius) border border-(--separator) bg-(--surface) p-3 shadow-(--shadow)">
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
              type="button"
              variant={feedback === payment.id ? 'primary' : 'secondary'}
            >
              <Icon className="h-6 w-6" />
              <span className="text-sm">{feedback === payment.id ? 'Pagado' : ""}</span>
            </Button>
          )
        })}
      </div>
    </section>
  )
}
