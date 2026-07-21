import { z } from 'zod'

const cents = z.number().int().nonnegative()

export const printTicketItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  quantity: z.number().positive(),
  unitPriceCents: z.number().int(),
  totalCents: z.number().int(),
  additions: z.array(z.string().trim().min(1).max(160)).optional(),
  notes: z.array(z.string().trim().min(1).max(240)).optional(),
  discountCents: cents.optional(),
  taxCents: cents.optional(),
})

export const printRequestSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  printerId: z.string().trim().min(1).max(200),
  ticket: z.object({
    establishmentName: z.string().trim().min(1).max(200),
    address: z.string().trim().max(300).optional(),
    legalName: z.string().trim().max(80).optional(),
    taxId: z.string().trim().max(80).optional(),
    ticketNumber: z.string().trim().min(1).max(100),
    date: z.string().datetime({ offset: true }),
    items: z.array(printTicketItemSchema).min(1),
    subtotalCents: cents,
    discountCents: cents.optional(),
    taxCents: cents.optional(),
    tipCents: cents.optional(),
    totalCents: cents,
    paymentMethod: z.string().trim().max(80).optional(),
    payments: z.array(z.object({ method: z.string().trim().min(1), amountCents: cents })).optional(),
    amountReceivedCents: cents.optional(),
    changeCents: cents.optional(),
    footer: z.string().trim().max(500).optional(),
    copyLabel: z.string().trim().max(80).optional(),
    deferredLabel: z.string().trim().max(80).optional(),
  }),
  options: z.object({
    cut: z.boolean(),
    openCashDrawer: z.boolean(),
    copies: z.number().int().min(1).max(5),
  }),
})

const signedCents = z.number().int()

export const cashClosingPrintDocumentSchema = z.object({
  reportTitle: z.string().trim().min(1).max(100),
  companyName: z.string().trim().min(1).max(200),
  registerName: z.string().trim().min(1).max(200),
  shiftLabel: z.string().trim().min(1).max(100),
  closedAt: z.string().datetime({ offset: true }),
  timezone: z.string().trim().min(1).max(100),
  currency: z.string().trim().length(3),
  locale: z.string().trim().min(2).max(20),
  copyLabel: z.string().trim().max(40).optional(),
  summary: z.object({
    totalSalesCents: signedCents,
    salesCount: z.number().int().nonnegative(),
    averageSaleCents: signedCents,
  }),
  payments: z.array(z.object({
    code: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(120),
    amountCents: signedCents,
  })),
  cashMovements: z.object({ entriesCents: cents, exitsCents: cents }),
  cashFund: z.object({ openingCashFundCents: cents, finalCashFundCents: cents }),
  differences: z.object({ cashDifferenceCents: signedCents, cardDifferenceCents: signedCents }),
  expectedAndCounted: z.object({
    expectedCashCents: signedCents,
    countedCashCents: signedCents,
    expectedCardCents: signedCents,
    countedCardCents: signedCents,
  }).optional(),
  users: z.object({ openedBy: z.string().trim().max(200).optional(), closedBy: z.string().trim().max(200).optional() }).optional(),
  times: z.object({ openedAt: z.string().datetime({ offset: true }), closedAt: z.string().datetime({ offset: true }) }).optional(),
  includeTotalPayments: z.boolean().optional(),
  paperWidth: z.union([z.literal(32), z.literal(42), z.literal(48)]),
})

export const cashClosingPrintRequestSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  printerId: z.string().trim().min(1).max(200),
  documentType: z.literal('cash-closing'),
  cashClosing: cashClosingPrintDocumentSchema,
  options: z.object({
    cut: z.boolean(),
    openCashDrawer: z.literal(false),
    copies: z.number().int().min(1).max(5),
  }),
})

export const printDocumentRequestSchema = z.union([printRequestSchema, cashClosingPrintRequestSchema])

export const printerActionSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  printerId: z.string().trim().min(1).max(200),
})

export const selectPrinterSchema = z.object({ printerId: z.string().trim().min(1).max(200) })
