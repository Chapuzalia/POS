import type { SaleCreatedPayload } from '../../../types/index.ts'
import type { PrintRequest, PrintTicketItem } from '../types.ts'
import { shouldOpenCashDrawer } from './cashDrawerRules.ts'

type MapperOptions = {
  sale: SaleCreatedPayload
  establishment: { name: string; address?: string; legalName?: string; taxId?: string }
  printerId: string
  footer?: string
  isReprint?: boolean
  copyNumber?: number
  autoOpenCashDrawer?: boolean
  cut?: boolean
}

function lineAdditions(line: SaleCreatedPayload['lines'][number]) {
  return [
    ...(line.components ?? []).flatMap((component) => [
      component.productName,
      ...(component.modifiers ?? []).map((modifier) => `${component.productName} · ${modifier.name}`),
    ]),
    ...line.modifiers.map((modifier) => modifier.name),
  ].filter(Boolean)
}

function lineName(line: SaleCreatedPayload['lines'][number]) {
  const variant = line.variantName?.trim()
  return variant && variant.toLocaleLowerCase() !== line.productName.toLocaleLowerCase()
    ? `${line.productName} ${variant}`
    : line.productName
}

export function mapSaleLineToPrintItem(line: SaleCreatedPayload['lines'][number]): PrintTicketItem {
  const additions = lineAdditions(line)
  return {
    name: lineName(line),
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    totalCents: line.lineTotalCents,
    ...(additions.length ? { additions } : {}),
    ...(line.fiscalSnapshot ? { taxCents: line.fiscalSnapshot.taxAmountCents } : {}),
  }
}

export function mapSaleToPrintRequest(options: MapperOptions): PrintRequest {
  const { sale } = options
  const isReprint = options.isReprint === true
  const copyNumber = options.copyNumber || 0
  const payments = sale.payment ? [{ method: sale.payment.method, amountCents: sale.payment.amountCents }] : []
  const hasTaxSnapshot = sale.lines.some((line) => Boolean(line.fiscalSnapshot))
  const taxCents = sale.lines.reduce((total, line) => total + (line.fiscalSnapshot?.taxAmountCents || 0), 0)
  return {
    requestId: isReprint ? `print:${sale.sale.id}:copy:${copyNumber}` : `print:${sale.sale.id}:original`,
    printerId: options.printerId,
    ticket: {
      establishmentName: options.establishment.name,
      ...(options.establishment.address ? { address: options.establishment.address } : {}),
      ...(options.establishment.legalName ? { legalName: options.establishment.legalName } : {}),
      ...(options.establishment.taxId ? { taxId: options.establishment.taxId } : {}),
      ticketNumber: sale.ticket.id,
      date: sale.sale.createdAt,
      items: sale.lines.map(mapSaleLineToPrintItem),
      subtotalCents: sale.ticket.subtotalCents,
      discountCents: sale.ticket.discountAmountCents,
      ...(hasTaxSnapshot ? { taxCents } : {}),
      totalCents: sale.sale.totalCents,
      ...(sale.payment ? {
        paymentMethod: sale.payment.method,
        payments,
        ...(sale.payment.receivedCents === null ? {} : { amountReceivedCents: sale.payment.receivedCents }),
        changeCents: sale.payment.changeCents,
      } : {}),
      ...(options.footer ? { footer: options.footer } : {}),
      ...(isReprint ? { copyLabel: 'COPIA' } : {}),
    },
    options: {
      cut: options.cut !== false,
      openCashDrawer: shouldOpenCashDrawer({ payments, isReprint, settings: { autoOpenCashDrawer: options.autoOpenCashDrawer } }),
      copies: 1,
    },
  }
}

export function mapRestaurantSaleToPrintRequest(input: {
  saleId: string
  ticketId: string
  createdAt: string
  lines: Array<{ productName: string; variantName?: string; quantity: number; unitPriceCents: number; modifiers?: Array<{ name: string }>; components?: Array<{ productName: string; modifiers?: Array<{ name: string }> }>; mixer?: { name: string } | null; note?: string | null }>
  totalCents: number
  paymentMethod: string | null
  receivedCents: number | null
  establishmentName: string
  address?: string
  legalName?: string
  taxId?: string
  printerId: string
  footer?: string
  autoOpenCashDrawer?: boolean
}) : PrintRequest {
  const items = input.lines.map((line) => {
    const additions = [
      ...(line.components || []).flatMap((component) => [component.productName, ...(component.modifiers ?? []).map((modifier) => `${component.productName} · ${modifier.name}`)]),
      ...(line.modifiers || []).map((modifier) => modifier.name),
      ...(!line.components?.length && line.mixer ? [line.mixer.name] : []),
    ]
    return {
      name: line.variantName && line.variantName !== line.productName ? `${line.productName} ${line.variantName}` : line.productName,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      totalCents: line.unitPriceCents * line.quantity,
      ...(additions.length ? { additions } : {}),
      ...(line.note ? { notes: [line.note] } : {}),
    }
  })
  const subtotalCents = items.reduce((total, item) => total + item.totalCents, 0)
  const payments = input.paymentMethod ? [{ method: input.paymentMethod, amountCents: input.totalCents }] : []
  return {
    requestId: `print:${input.saleId}:original`, printerId: input.printerId,
    ticket: {
      establishmentName: input.establishmentName,
      ...(input.address ? { address: input.address } : {}),
      ...(input.legalName ? { legalName: input.legalName } : {}),
      ...(input.taxId ? { taxId: input.taxId } : {}),
      ticketNumber: input.ticketId, date: input.createdAt,
      items, subtotalCents, discountCents: Math.max(0, subtotalCents - input.totalCents), totalCents: input.totalCents,
      ...(input.paymentMethod ? { paymentMethod: input.paymentMethod, payments } : {}),
      ...(input.receivedCents === null ? {} : { amountReceivedCents: input.receivedCents, changeCents: Math.max(0, input.receivedCents - input.totalCents) }),
      ...(input.footer ? { footer: input.footer } : {}),
    },
    options: { cut: true, openCashDrawer: shouldOpenCashDrawer({ payments, settings: { autoOpenCashDrawer: input.autoOpenCashDrawer } }), copies: 1 },
  }
}
