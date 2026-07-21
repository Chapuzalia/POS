import { LoaderCircle, WalletCards } from 'lucide-react'
import { sileo } from 'sileo'
import { Button } from '../../../components/ui'
import { getPrintAgentErrorMessage } from '../api/PrintAgentError'
import { usePrintAgent } from '../hooks/usePrintAgent'

export function ManualCashDrawerButton({ canOpenDrawer }: { canOpenDrawer: boolean }) {
  const agent = usePrintAgent()
  const isConfigured = agent.hasToken && Boolean(agent.selectedPrinterId)

  if (!canOpenDrawer) return null

  async function handleOpenCashDrawer() {
    try {
      await agent.openCashDrawer()
      sileo.success({ title: 'Cajon abierto' })
    } catch (error) {
      sileo.warning({
        title: 'No se ha podido abrir el cajon',
        description: getPrintAgentErrorMessage(error),
      })
    }
  }

  const disabled = !isConfigured || agent.isOpeningCashDrawer || agent.isPrintingTicket
  const title = !isConfigured
    ? 'Configura el servidor y la impresora para abrir el cajon.'
    : agent.isPrintingTicket
      ? 'Espera a que termine la impresion en curso.'
      : 'Abrir el cajon de efectivo'

  return (
    <Button
      aria-label="Abrir el cajon de efectivo"
      className="min-h-9 whitespace-nowrap"
      disabled={disabled}
      onClick={() => void handleOpenCashDrawer()}
      size="sm"
      title={title}
      type="button"
      variant="secondary"
    >
      {agent.isOpeningCashDrawer
        ? <LoaderCircle className="h-4 w-4 animate-spin" />
        : <WalletCards className="h-4 w-4" />}
      {agent.isOpeningCashDrawer ? 'Abriendo cajon' : 'Abrir cajon'}
    </Button>
  )
}
