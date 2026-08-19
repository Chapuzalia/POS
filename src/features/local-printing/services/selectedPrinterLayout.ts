import { createPrintAgentClient } from '../api/printAgentClient.ts'
import { usePrintAgentStore } from '../store/usePrintAgentStore.ts'
import type { Printer } from '../types.ts'
import { printerLayoutFromPrinter } from './receiptFormatters.ts'

function unwrapSelectedPrinter(value: { printer?: Printer | null } | Printer | null): Printer | null {
  if (!value) return null
  return 'printer' in value
    ? (value as { printer?: Printer | null }).printer ?? null
    : value as Printer
}

export async function loadSelectedPrinterLayout() {
  const state = usePrintAgentStore.getState()
  if (!state.token) throw new Error('Servidor de impresión no configurado.')
  const client = createPrintAgentClient({ baseUrl: state.baseUrl, token: state.token })
  const printer = unwrapSelectedPrinter(await client.getSelectedPrinter())
  if (!printer?.id) throw new Error('No hay ninguna impresora seleccionada en el agente.')
  if (printer.paperWidth !== 58 && printer.paperWidth !== 80) {
    throw new Error('La impresora seleccionada no indica un ancho de papel válido (58 u 80 mm).')
  }
  if (!printer.characterSet?.trim()) {
    throw new Error('La impresora seleccionada no indica el juego de caracteres configurado.')
  }
  return { printer, layout: printerLayoutFromPrinter(printer) }
}
