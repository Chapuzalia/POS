import type { SaleCreatedPayload } from '../../../types/index.ts'
import { issueLocalInvoice, type LocalFiscalEntry, type ResolveFiscalSale } from './localLedger.ts'
import { getFiscalInstallationLease, loadFiscalInstallation, type FiscalInstallation } from './installation.ts'
import { isFiscalTransportUnavailable } from './availability.ts'
import { recoverServerConfirmedFiscalChain } from './serverRecovery.ts'
import type { CashSession, TenantContext } from '../../../types/index.ts'

export type PreparedFiscalInstallation = {
  readonly tenantId: string
  readonly venueId: string
  readonly deviceId: string
  readonly cashRegisterId: string
  readonly cashSessionId: string
  readonly saleId: string
  readonly installation: FiscalInstallation
  readonly preparedAt: number
  readonly preparedMonotonicAt: number
}

const PREPARED_INSTALLATION_MAX_AGE_MS = 60_000

function preparedFiscalInstallation(
  context: TenantContext, cashSession: CashSession, saleId: string, installation: FiscalInstallation,
): PreparedFiscalInstallation {
  return {
    tenantId: context.tenantId, venueId: context.venueId, deviceId: context.deviceId,
    cashRegisterId: cashSession.cashRegisterId, cashSessionId: cashSession.id, saleId, installation,
    preparedAt: Date.now(), preparedMonotonicAt: performance.now(),
  }
}

function reusablePreparedInstallation(
  prepared: PreparedFiscalInstallation | null | undefined,
  context: TenantContext, cashSession: CashSession, saleId: string,
): FiscalInstallation | null {
  if (!prepared) return null
  const installation = prepared.installation
  if (prepared.tenantId !== context.tenantId || prepared.venueId !== context.venueId
    || prepared.deviceId !== context.deviceId || prepared.cashRegisterId !== cashSession.cashRegisterId
    || prepared.cashSessionId !== cashSession.id || prepared.saleId !== saleId) return null
  if (installation.tenantId !== context.tenantId || installation.venueId !== context.venueId
    || installation.deviceId !== context.deviceId || installation.cashRegisterId !== cashSession.cashRegisterId) return null
  const wallAge = Date.now() - prepared.preparedAt
  const monotonicAge = performance.now() - prepared.preparedMonotonicAt
  if (wallAge < 0 || wallAge > PREPARED_INSTALLATION_MAX_AGE_MS) return null
  if (monotonicAge < 0 || monotonicAge > PREPARED_INSTALLATION_MAX_AGE_MS) return null
  return installation
}

function fiscalLines(payload: SaleCreatedPayload) {
  return payload.lines.map(line => {
    const tax = line.fiscalSnapshot
    if (!tax || ![4, 10, 21].includes(tax.taxRate)) {
      throw new Error('La venta incluye una línea sin desglose de IVA ordinario compatible con la emisión local.')
    }
    return {
      description: [line.productName, line.variantName].filter(Boolean).join(' — '),
      grossCents: line.lineTotalCents,
      discountCents: line.discountAmountCents ?? 0,
      baseCents: tax.taxableBaseCents,
      taxCents: tax.taxAmountCents,
      taxRate: tax.taxRate.toFixed(2),
    }
  })
}

/** Run before touching a cash device so configuration and fiscal eligibility fail early. */
export async function preflightPosInvoice(
  context: TenantContext, cashSession: CashSession, payload: SaleCreatedPayload,
  simplifiedLimitCents = 40000,
): Promise<PreparedFiscalInstallation> {
  const customer = payload.ticket.invoice?.customer
  if (!customer && payload.sale.totalCents > simplifiedLimitCents) {
    throw new Error('Esta venta requiere cliente fiscal y factura completa.')
  }
  fiscalLines(payload)
  const installation = await preflightFiscalInstallation(context, cashSession)
  return preparedFiscalInstallation(context, cashSession, payload.sale.id, installation)
}

export async function preflightFiscalInstallation(context: TenantContext, cashSession: CashSession): Promise<FiscalInstallation> {
  const installation = await loadFiscalInstallation(context, cashSession)
  await getFiscalInstallationLease(installation)
  try {
    await recoverServerConfirmedFiscalChain(installation)
  } catch (error) {
    if (!isFiscalTransportUnavailable(error)) throw error
  }
  return installation
}

/** The payment payload already carries the historical line, discount and tax snapshots. */
export async function issuePosInvoice(
  context: TenantContext, cashSession: CashSession, payload: SaleCreatedPayload,
  economicAlreadySynced = false,
  resolveSale?: ResolveFiscalSale,
  simplifiedLimitCents = 40000,
  prepared?: PreparedFiscalInstallation | null,
): Promise<LocalFiscalEntry> {
  const installation = reusablePreparedInstallation(prepared, context, cashSession, payload.sale.id)
    ?? await loadFiscalInstallation(context, cashSession)
  const lease = await getFiscalInstallationLease(installation)
  try {
    await recoverServerConfirmedFiscalChain(installation)
  } catch (error) {
    if (!isFiscalTransportUnavailable(error)) throw error
  }
  const customer = payload.ticket.invoice?.customer
  const recipient = customer ? { name: customer.legalName, nif: customer.taxId.toUpperCase() } : undefined
  if (!recipient && payload.sale.totalCents > simplifiedLimitCents) {
    throw new Error('Esta venta supera el límite configurado de factura simplificada. Selecciona un cliente fiscal para expedir factura completa.')
  }
  const lines = fiscalLines(payload)
  return issueLocalInvoice({
    environment: 'production', qrEnvironment: installation.aeatEnvironment, lease, transmissionMode: installation.bridgeUrl ? 'bridge' : 'local-only',
    salePayload: payload, economicAlreadySynced,
    tenantId: installation.tenantId, fiscalSubjectId: installation.fiscalSubjectId,
    issuerNif: installation.issuerNif, issuerName: installation.issuerName,
    issuerAddress: context.venueAddress,
    venueId: installation.venueId, venueCode: installation.venueCode,
    cashRegisterId: installation.cashRegisterId, registerCode: installation.registerCode,
    installationId: installation.installationId, installationNumber: installation.installationNumber,
    installationCode: installation.installationCode, deviceId: installation.deviceId,
    ticketId: payload.ticket.id, saleId: payload.sale.id, paymentId: payload.payment?.id ?? null,
    invoiceId: crypto.randomUUID(), invoiceType: recipient ? 'F1' : 'F2', recipient,
    description: 'Venta de bienes y servicios', system: installation.system, timezone: installation.timezone,
    lines,
  }, resolveSale)
}

export function printPayloadWithLocalFiscal(payload: SaleCreatedPayload, entry: LocalFiscalEntry): SaleCreatedPayload {
  if (payload.ticket.id !== entry.invoice.ticketId || payload.sale.id !== entry.invoice.saleId) {
    throw new Error('El registro fiscal no corresponde a este ticket.')
  }
  const invoice = payload.ticket.invoice
  const delivery = entry.delivery
  const status = delivery.state === 'AEAT_ACCEPTED' ? 'accepted'
    : delivery.state === 'AEAT_ACCEPTED_WITH_ERRORS' ? 'accepted_with_errors'
      : delivery.state === 'AEAT_REJECTED' ? 'rejected'
        : delivery.state === 'REQUIRES_ACTION' ? 'error' : 'pending'
  return {
    ...payload,
    localFiscal: {
      ...payload.localFiscal,
      recordId: entry.id, series: entry.invoice.series, number: entry.invoice.number,
      issuedAt: entry.invoice.issuedAt, documentKind: invoice ? 'complete' : 'simplified',
      issuerName: entry.invoice.issuerName, issuerNif: entry.invoice.issuerNif,
      issuerAddress: entry.invoice.issuerAddress ?? '',
      // Records created by older POS versions always required a bridge URL.
      verifactuLegend: entry.invoice.transmissionMode !== 'local-only',
    },
    ticket: {
      ...payload.ticket,
      invoice: invoice ? { ...invoice, series: entry.invoice.series, number: String(entry.invoice.number), issuedAt: entry.invoice.issuedAt } : null,
    },
    fiscal: {
      invoiceId: entry.record.invoiceId, provider: 'verifactu', status, uuid: null,
      qrBase64: null, verificationUrl: entry.invoice.qrUrl,
      externalCode: `${entry.invoice.series}/${entry.invoice.number}`,
      errorCode: delivery.result?.code ?? null, errorMessage: delivery.result?.description ?? null,
    },
  }
}
