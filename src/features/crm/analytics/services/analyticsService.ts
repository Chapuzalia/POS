import { requireSupabase } from '../../shared/services/crmServiceSupport'
import { getOperationalMonthStartIso } from '../../../../lib/operationalDay'
import { supabase } from '../../../../lib/supabase'
import { type CrmStats, type CrmVenue, type HistoricalPaymentMethod, type PaymentMethod, type TenantContext } from '../../../../types'
import { type NameRow } from '../../sales/services/salesReportsService'

export type SaleStatsRow = {
  id: string
  payment_method: HistoricalPaymentMethod | null
  total_cents: number
}

export type TicketLineStatsRow = {
  product_name: string
  quantity: number
  allocated_quantity: number | null
  line_total_cents: number
}

export type TicketWithLinesStatsRow = {
  id: string
  total_cents: number
  discount_id: string | null
  discount_name: string | null
  discount_amount_cents: number | null
  ticket_lines: TicketLineStatsRow[] | null
}

export type OpenCashSessionRow = {
  id: string
  venue_id: string
  device_id: string
  opened_at: string
  opening_float_cents: number
}

export type OpenCashSessionSaleRow = {
  cash_session_id: string
  payment_method: HistoricalPaymentMethod | null
  total_cents: number
}

export async function loadCrmStats(context: TenantContext, venue: CrmVenue): Promise<CrmStats> {
  const client = requireSupabase()
  const monthStart = getOperationalMonthStartIso({
    dayChangeTime: venue.dayChangeTime,
    timeZone: venue.timeZone,
  })
  let salesQuery = client
    .from('sales')
    .select('id, payment_method, total_cents')
    .eq('tenant_id', context.tenantId)
    .gte('local_created_at', monthStart)
  let ticketsQuery = client
    .from('tickets')
    .select('id, total_cents, discount_id, discount_name, discount_amount_cents, ticket_lines(product_name, quantity, allocated_quantity, line_total_cents)')
    .eq('tenant_id', context.tenantId)
    .eq('status', 'paid')
    .gte('local_created_at', monthStart)
  let openSessionsQuery = client
    .from('cash_sessions')
    .select('id, venue_id, device_id, opened_at, opening_float_cents')
    .eq('tenant_id', context.tenantId)
    .eq('status', 'open')
    .order('opened_at', { ascending: false })

  salesQuery = salesQuery.eq('venue_id', venue.id)
  ticketsQuery = ticketsQuery.eq('venue_id', venue.id)
  openSessionsQuery = openSessionsQuery.eq('venue_id', venue.id)

  const [
    { data: salesRows, error: salesError },
    { data: ticketRows, error: linesError },
    { data: openSessionRows, error: openSessionsError },
    { data: venueRows, error: venuesError },
    { data: deviceRows, error: devicesError },
  ] = await Promise.all([
    salesQuery,
    ticketsQuery,
    openSessionsQuery,
    client.from('venues').select('id, name').eq('tenant_id', context.tenantId),
    client.from('devices').select('id, name').eq('tenant_id', context.tenantId),
  ])

  if (salesError) {
    throw salesError
  }

  if (linesError) {
    throw linesError
  }

  if (openSessionsError) {
    throw openSessionsError
  }

  if (venuesError) {
    throw venuesError
  }

  if (devicesError) {
    throw devicesError
  }

  const sales = (salesRows ?? []) as SaleStatsRow[]
  const paidTickets = (ticketRows ?? []) as TicketWithLinesStatsRow[]
  const lines = paidTickets.flatMap((ticket) => ticket.ticket_lines ?? [])
  const openSessions = (openSessionRows ?? []) as OpenCashSessionRow[]
  const venuesById = new Map(((venueRows ?? []) as NameRow[]).map((venue) => [venue.id, venue.name]))
  const devicesById = new Map(((deviceRows ?? []) as NameRow[]).map((device) => [device.id, device.name]))
  const monthSalesCents = paidTickets.reduce((total, ticket) => total + ticket.total_cents, 0)
  const discountsCents = paidTickets.reduce((total, ticket) => total + (ticket.discount_amount_cents ?? 0), 0)
  const discountedTicketCount = paidTickets.filter((ticket) => (ticket.discount_amount_cents ?? 0) > 0).length
  const byPaymentMap = new Map<PaymentMethod, { method: PaymentMethod; totalCents: number; count: number }>()
  const discountMap = new Map<string, CrmStats['discountApplications'][number]>()
  const topProductMap = new Map<string, { productName: string; quantity: number; totalCents: number }>()
  const openCashSessions = openSessions.map((session) => ({
    id: session.id,
    venueName: venuesById.get(session.venue_id) ?? 'Local sin nombre',
    deviceName: devicesById.get(session.device_id) ?? 'Caja sin nombre',
    openedAt: session.opened_at,
    openingFloatCents: session.opening_float_cents,
    salesCents: 0,
    ticketCount: 0,
    cashCents: 0,
    cardCents: 0,
    invitationCents: 0,
    otherCents: 0,
  }))
  const openCashSessionById = new Map(openCashSessions.map((session) => [session.id, session]))

  sales.forEach((sale) => {
    if (sale.payment_method !== 'cash' && sale.payment_method !== 'card') return
    const current = byPaymentMap.get(sale.payment_method) ?? {
      method: sale.payment_method,
      totalCents: 0,
      count: 0,
    }
    byPaymentMap.set(sale.payment_method, {
      ...current,
      count: current.count + 1,
      totalCents: current.totalCents + sale.total_cents,
    })
  })


  paidTickets.forEach((ticket) => {
    if (!ticket.discount_name || !ticket.discount_amount_cents) return
    const id = ticket.discount_id ?? 'manual'
    const current = discountMap.get(id) ?? {
      id,
      name: ticket.discount_name,
      applications: 0,
      discountedCents: 0,
      netSalesCents: 0,
      ticketPercentage: 0,
    }
    current.applications += 1
    current.discountedCents += ticket.discount_amount_cents
    current.netSalesCents += ticket.total_cents
    discountMap.set(id, current)
  })
  lines.forEach((line) => {
    const current = topProductMap.get(line.product_name) ?? {
      productName: line.product_name,
      quantity: 0,
      totalCents: 0,
    }
    topProductMap.set(line.product_name, {
      ...current,
      quantity: current.quantity + Number(line.allocated_quantity ?? line.quantity),
      totalCents: current.totalCents + line.line_total_cents,
    })
  })

  if (openSessions.length) {
    const { data: openSessionSaleRows, error: openSessionSalesError } = await client
      .from('sales')
      .select('cash_session_id, payment_method, total_cents')
      .eq('tenant_id', context.tenantId)
      .in(
        'cash_session_id',
        openSessions.map((session) => session.id),
      )

    if (openSessionSalesError) {
      throw openSessionSalesError
    }

    const openSessionSales = (openSessionSaleRows ?? []) as OpenCashSessionSaleRow[]

    openSessionSales.forEach((sale) => {
      const session = openCashSessionById.get(sale.cash_session_id)

      if (!session) {
        return
      }

      session.salesCents += sale.total_cents
      session.ticketCount += 1

      if (sale.payment_method === 'cash') {
        session.cashCents += sale.total_cents
      } else if (sale.payment_method === 'card') {
        session.cardCents += sale.total_cents
      } else if (sale.payment_method === 'invitation') {
        session.invitationCents += sale.total_cents
      } else {
        session.otherCents += sale.total_cents
      }
    })
  }

  return {
    averageTicketCents: paidTickets.length ? Math.round(monthSalesCents / paidTickets.length) : 0,
    byPayment: [...byPaymentMap.values()].sort((a, b) => b.totalCents - a.totalCents),
    discountApplications: [...discountMap.values()].map((item) => ({
      ...item,
      ticketPercentage: paidTickets.length ? Math.round((item.applications / paidTickets.length) * 1000) / 10 : 0,
    })).sort((a, b) => b.discountedCents - a.discountedCents),
    discountedTicketCount,
    discountsCents,
    monthSalesCents,
    monthTicketCount: paidTickets.length,
    openCashSessions,
    topProducts: [...topProductMap.values()].sort((a, b) => b.totalCents - a.totalCents).slice(0, 8),
  }
}

export function subscribeToCrmStatsChanges(context: TenantContext, onChange: () => void) {
  const client = supabase

  if (!client) {
    return () => undefined
  }

  const channel = client
    .channel(`crm-stats:${context.tenantId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'cash_sessions', filter: `tenant_id=eq.${context.tenantId}` },
      onChange,
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'sales', filter: `tenant_id=eq.${context.tenantId}` },
      onChange,
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'tickets', filter: `tenant_id=eq.${context.tenantId}` },
      onChange,
    )
    .subscribe()

  return () => {
    void client.removeChannel(channel)
  }
}
