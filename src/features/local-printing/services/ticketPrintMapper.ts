import type { SaleCreatedPayload } from '../../../types/index.ts'
import { allocateNetTotalToLines } from '../../../lib/discounts.ts'
import { calculateTaxFromGross, isValidTaxRate } from '../../../lib/tax.ts'
import type { PrintRequest, PrintTicketItem } from '../types.ts'
import { shouldOpenCashDrawer } from './cashDrawerRules.ts'

type MapperOptions = {
  sale: SaleCreatedPayload
  establishment: { name: string; address?: string; legalName?: string; taxId?: string }
  printerId: string
  footer?: string
  isReprint?: boolean
  copyNumber?: number
  isPreTicket?: boolean
  autoOpenCashDrawer?: boolean
  cashlogyConfigured?: boolean
  cut?: boolean
}

type PrintableComponent = {
  type?: 'mixer' | 'menu_component'
  selectionGroupName?: string
  productName: string
  variantName?: string
  quantity?: number
  priceDeltaCents?: number
  modifiers?: Array<{ name: string }>
}

function componentAdditions(component: PrintableComponent) {
  const quantity = component.quantity ?? 1
  const variant = component.variantName?.trim()
  const supplement = component.priceDeltaCents
    ? ` ${component.priceDeltaCents > 0 ? '+' : ''}${(component.priceDeltaCents * quantity / 100).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}`
    : ''
  const groupLabel = component.type === 'menu_component' && component.selectionGroupName
    ? `${component.selectionGroupName} · `
    : ''
  const heading = `${groupLabel}${quantity > 1 ? `${quantity} × ` : ''}${component.productName}${variant ? ` (${variant})` : ''}${supplement}`
  return [heading, ...(component.modifiers ?? []).map((modifier) => `  · ${modifier.name}`)]
}

function lineAdditions(line: SaleCreatedPayload['lines'][number]) {
  return [
    ...(line.components ?? []).flatMap(componentAdditions),
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
    totalCents: line.netTotalCents ?? line.lineTotalCents,
    ...(additions.length ? { additions } : {}),
    ...(line.fiscalSnapshot ? { taxCents: line.fiscalSnapshot.taxAmountCents } : {}),
  }
}

export function mapSaleToPrintRequest(options: MapperOptions): PrintRequest {
  const { sale } = options
  const isReprint = options.isReprint === true
  const isPreTicket = options.isPreTicket === true
  const copyNumber = options.copyNumber || 0
  const payments = sale.payment && !isPreTicket ? [{ method: sale.payment.method, amountCents: sale.payment.amountCents }] : []
  const hasCompleteFiscalSnapshot = sale.lines.length > 0 && sale.lines.every(
    (line) => line.fiscalSnapshot && isValidTaxRate(line.fiscalSnapshot.taxRate),
  )
  const fiscalSnapshots = hasCompleteFiscalSnapshot
    ? allocateNetTotalToLines(sale.lines.map((line) => line.netTotalCents ?? line.lineTotalCents), sale.sale.totalCents)
      .map((grossTotalCents, index) => ({
        taxRate: sale.lines[index].fiscalSnapshot!.taxRate,
        ...calculateTaxFromGross(grossTotalCents, sale.lines[index].fiscalSnapshot!.taxRate),
      }))
    : null
  const taxCents = fiscalSnapshots?.reduce((total, snapshot) => total + snapshot.taxAmountCents, 0)
  const taxableBaseCents = fiscalSnapshots?.reduce((total, snapshot) => total + snapshot.taxableBaseCents, 0)
  const items = sale.lines.map((line, index) => {
    const item = mapSaleLineToPrintItem(line)
    if (fiscalSnapshots) return { ...item, taxCents: fiscalSnapshots[index].taxAmountCents }
    const { taxCents: _taxCents, ...itemWithoutTax } = item
    return itemWithoutTax
  })
  return {
    requestId: isPreTicket
      ? `pre-ticket:${sale.sale.id}`
      : isReprint ? `print:${sale.sale.id}:copy:${copyNumber}` : `print:${sale.sale.id}:original`,
    printerId: options.printerId,
    ticket: {
      establishmentName: options.establishment.name,
      ...(options.establishment.address ? { address: options.establishment.address } : {}),
      ...(options.establishment.legalName ? { legalName: options.establishment.legalName } : {}),
      ...(options.establishment.taxId ? { taxId: options.establishment.taxId } : {}),
      ticketNumber: sale.ticket.id,
      date: sale.sale.createdAt,
      items,
      subtotalCents: taxableBaseCents ?? sale.ticket.subtotalCents,
      discountCents: sale.ticket.discountAmountCents,
      ...(taxCents === undefined ? {} : { taxCents }),
      totalCents: sale.sale.totalCents,
      ...(sale.payment && !isPreTicket ? {
        paymentMethod: sale.payment.method,
        payments,
        ...(sale.payment.receivedCents === null ? {} : { amountReceivedCents: sale.payment.receivedCents }),
        changeCents: sale.payment.changeCents,
      } : {}),
      ...(options.footer ? { footer: options.footer } : {}),
      ...(isPreTicket ? { copyLabel: 'PRE-TICKET' } : isReprint ? { copyLabel: 'COPIA' } : {}),
      ...(sale.fiscal && !isPreTicket ? {
        fiscal: {
          provider: sale.fiscal.provider,
          status: sale.fiscal.status,
          ...(sale.fiscal.uuid ? { uuid: sale.fiscal.uuid } : {}),
          ...(sale.fiscal.externalCode ? { externalCode: sale.fiscal.externalCode } : {}),
          ...(sale.fiscal.verificationUrl ? { verificationUrl: sale.fiscal.verificationUrl } : {}),
          ...(sale.fiscal.qrBase64 ? { qrBase64: sale.fiscal.qrBase64 } : {}),
        },
      } : {}),
    },
    options: {
      cut: options.cut !== false,
      openCashDrawer: isPreTicket ? false : shouldOpenCashDrawer({ payments, isReprint, settings: { autoOpenCashDrawer: options.autoOpenCashDrawer, cashlogyConfigured: options.cashlogyConfigured } }),
      copies: 1,
    },
  }
}

export function mapRestaurantSaleToPrintRequest(input: {
  saleId: string
  ticketId: string
  createdAt: string
  lines: Array<{ productName: string; variantName?: string; quantity: number; unitPriceCents: number; modifiers?: Array<{ name: string }>; components?: PrintableComponent[]; mixer?: { name: string } | null; note?: string | null }>
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
  cashlogyConfigured?: boolean
}) : PrintRequest {
  const items = input.lines.map((line) => {
    const additions = [
      ...(line.components || []).flatMap(componentAdditions),
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
    options: { cut: true, openCashDrawer: shouldOpenCashDrawer({ payments, settings: { autoOpenCashDrawer: input.autoOpenCashDrawer, cashlogyConfigured: input.cashlogyConfigured } }), copies: 1 },
  }
}
