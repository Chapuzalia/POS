import { LoaderCircle, Printer } from 'lucide-react'
import { sileo } from 'sileo'
import { Button } from '../../../components/ui'
import type { AppliedDiscount, CashSession, Customer, TenantContext, TicketLine } from '../../../types'
import { getPrintAgentErrorMessage } from '../api/PrintAgentError'
import { usePrintAgent } from '../hooks/usePrintAgent'
import { printPreTicket } from '../services/printPreTicket'

type Props = {
  cashSession: CashSession
  context: TenantContext
  disabled?: boolean
  discount: AppliedDiscount | null
  invoiceCustomer?: Customer | null
  lines: TicketLine[]
}

export function PreTicketButton({ cashSession, context, disabled, discount, invoiceCustomer, lines }: Props) {
  const agent = usePrintAgent()
  const isConfigured = agent.hasToken && Boolean(agent.selectedPrinterId)

  if (!isConfigured) return null

  async function handlePrint() {
    try {
      await printPreTicket({ cashSession, context, discount, invoiceCustomer, lines })
      sileo.success({ title: 'Pre-ticket impreso correctamente' })
    } catch (error) {
      sileo.warning({
        title: 'No se ha podido imprimir el pre-ticket',
        description: getPrintAgentErrorMessage(error),
      })
    }
  }

  const busy = agent.isPrintingTicket || agent.isOpeningCashDrawer
  return <Button
    aria-label="Imprimir pre-ticket"
    className="min-h-9 min-w-9 px-2"
    disabled={disabled || busy || lines.length === 0}
    onClick={() => void handlePrint()}
    size="sm"
    title={lines.length === 0 ? 'Añade productos para imprimir el pre-ticket.' : 'Imprimir pre-ticket'}
    type="button"
    variant="secondary"
  >
    {agent.isPrintingTicket ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
  </Button>
}
