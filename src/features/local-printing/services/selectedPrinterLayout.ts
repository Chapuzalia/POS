import { createPrintAgentClient } from '../api/printAgentClient.ts'
import { PrintAgentError } from '../api/PrintAgentError.ts'
import { usePrintAgentStore } from '../store/usePrintAgentStore.ts'
import type { Printer } from '../types.ts'
import { printerLayoutFromPrinter } from './receiptFormatters.ts'
import { recoverSelectedPrinter } from './printerSelectionRecovery.ts'

function unwrapSelectedPrinter(value: { printer?: Printer | null } | Printer | null): Printer | null {
  if (!value) return null
  return 'printer' in value
    ? (value as { printer?: Printer | null }).printer ?? null
    : value as Printer
}

export async function loadSelectedPrinterLayout() {
  const state = usePrintAgentStore.getState()
  if (!state.token) throw new PrintAgentError({ code: 'UNAUTHORIZED', message: 'Servidor de impresión no configurado.' })
  const client = createPrintAgentClient({ baseUrl: state.baseUrl, token: state.token })
  const remotePrinter = unwrapSelectedPrinter(await client.getSelectedPrinter())
  // El simulador conserva la selección en memoria y puede perderla al
  // reiniciarse aunque este terminal todavía tenga una impresora elegida.
  // Reaplicar la elección previa también recupera agentes físicos cuya
  // configuración se haya restaurado sin obligar a repetir el asistente.
  const printer = await recoverSelectedPrinter(remotePrinter, state.selectedPrinterId, state.selectPrinter)
  if (!printer?.id) throw new PrintAgentError({ code: 'PRINTER_NOT_CONFIGURED' })
  if (printer.paperWidth !== 58 && printer.paperWidth !== 80) {
    throw new PrintAgentError({ code: 'CONFIGURATION_ERROR', message: 'La impresora seleccionada no indica un ancho de papel válido (58 u 80 mm).' })
  }
  if (!printer.characterSet?.trim()) {
    throw new PrintAgentError({ code: 'CONFIGURATION_ERROR', message: 'La impresora seleccionada no indica el juego de caracteres configurado.' })
  }
  return { printer, layout: printerLayoutFromPrinter(printer) }
}
