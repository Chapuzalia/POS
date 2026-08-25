import { z } from 'zod'
import { hasPrintControlCharacters } from '../services/receiptFormatters.ts'

const cents = z.number().int().nonnegative()

const printLineSchema = z.string().max(1000).refine(
  (line) => !hasPrintControlCharacters(line),
  'Cada elemento debe ser una sola línea sin caracteres de control.',
)

const printElementSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), value: printLineSchema }).strict(),
  z.object({
    type: z.literal('qr'),
    data: z.string().min(1).max(4096).refine(
      (value) => !hasPrintControlCharacters(value),
      'El contenido del QR no puede contener caracteres de control.',
    ),
    size: z.number().int().min(1).max(16).optional(),
    errorCorrection: z.enum(['L', 'M', 'Q', 'H']).optional(),
  }).strict(),
])

export const printRequestSchema = z.object({
  requestId: z.string().trim().min(3).max(200),
  printerId: z.string().trim().min(1).max(200),
  force: z.boolean(),
  lines: z.array(printLineSchema).min(1).max(1000).refine(
    (lines) => lines.reduce((total, line) => total + line.length, 0) <= 100000,
    'El documento supera los 100.000 caracteres.',
  ),
  elements: z.array(printElementSchema).min(1).max(1000).refine(
    (elements) => elements.reduce(
      (total, element) => total + (element.type === 'text' ? element.value.length : element.data.length),
      0,
    ) <= 100000,
    'El documento estructurado supera los 100.000 caracteres.',
  ).optional(),
  options: z.object({
    cut: z.boolean(),
    openCashDrawer: z.boolean(),
    copies: z.number().int().min(1).max(5),
  }).strict(),
}).strict()

const signedCents = z.number().int()

const cashMovementsSchema = z.object({
  cashEntriesCents: cents.optional(),
  cashExitsCents: cents.optional(),
  cardCashbackCents: cents.optional(),
  entriesCents: cents.optional(),
  exitsCents: cents.optional(),
}).transform((value) => ({
  cashEntriesCents: value.cashEntriesCents ?? value.entriesCents ?? 0,
  cashExitsCents: value.cashExitsCents ?? value.exitsCents ?? 0,
  cardCashbackCents: value.cardCashbackCents ?? 0,
}))

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
  cashMovements: cashMovementsSchema,
  cashFund: z.object({ openingCashFundCents: cents, finalCashFundCents: cents }),
  operationalSummary: z.object({
    billedCardCents: signedCents,
    billedCashCents: signedCents,
    cardTerminalExpectedCents: signedCents,
    cashOverOpeningFundCents: signedCents,
    cashToWithdrawCents: signedCents,
  }).optional(),
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

export const printerActionSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  printerId: z.string().trim().min(1).max(200),
})

export const selectPrinterSchema = z.object({ printerId: z.string().trim().min(1).max(200) })
