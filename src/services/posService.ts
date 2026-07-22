import { createId, getLineTotal, getTicketTotal } from '../lib/format'
import { assertValidTicketPayment, calculateAppliedDiscount } from '../lib/discounts'
import { loadCurrentCatalog } from '../features/catalog/data/load-current-catalog.ts'
import { supabase } from '../lib/supabase'
export { summarizeSales } from '../features/cash-registers/services/cashSummary.ts'
import type {
  AppliedDiscount,
  CashClosedPayload,
  CashSession,
  Catalog,
  HistoricalPaymentMethod,
  LoginInput,
  OfflineEvent,
  PaymentMethod,
  ProductSalesStat,
  SaleCreatedPayload,
  SaleLinePayload,
  SaleRecord,
  SessionTicketRecord,
  TenantContext,
  TicketLine,
  TicketLineFiscalSnapshot,
  TicketLineModifier,
} from '../types'
import type {
  DeviceAssignmentRow,
  DeviceRow,
  MembershipRow,
  SaleRow,
  TenantRow,
  TicketLineProductSalesRow,
  UserMembershipRow,
  VenueRow,
} from '../types/supabase'
import { nowIso } from '../utils/dates'
import { getReadableError } from '../utils/errors'
import { claimLoginLease, releaseLocalLoginLock, releaseLoginLease } from './loginLeaseService'
async function requireExclusiveLogin(context: TenantContext) {
  if (await claimLoginLease()) {
    return context
  }

  releaseLocalLoginLock()
  throw new LoginLeaseConflictError('Esta cuenta ya esta abierta en otro dispositivo o pestana.', context)
}

function mapFiscalSnapshot(row: {
  line_total_cents: number
  tax_amount_cents: number | null
  tax_rate: number | null
  taxable_base_cents: number | null
}): TicketLineFiscalSnapshot | null {
  if (row.tax_rate === null || row.taxable_base_cents === null || row.tax_amount_cents === null) {
    return null
  }

  return {
    taxRate: Number(row.tax_rate),
    taxableBaseCents: row.taxable_base_cents,
    taxAmountCents: row.tax_amount_cents,
    grossTotalCents: row.line_total_cents,
  }
}

export async function loginTenant(input: LoginInput): Promise<TenantContext> {
  if (!supabase) {
    throw new Error('Supabase no esta configurado.')
  }

  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: input.email,
    password: input.password,
  })

  if (authError) {
    throw authError
  }

  const user = authData.user

  if (!user) {
    throw new Error('No se ha recibido usuario autenticado.')
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('full_name, is_superadmin')
    .eq('id', user.id)
    .maybeSingle<{ full_name: string | null; is_superadmin: boolean }>()

  if (profileError) {
    throw new Error(`No se pudo comprobar el perfil global: ${getReadableError(profileError)}`)
  }

  if (profile?.is_superadmin) {
    return requireExclusiveLogin({
      tenantId: '',
      tenantName: 'Plataforma CLUB POS',
      tenantSlug: '',
      venueId: '',
      venueName: '',
      deviceId: '',
      deviceName: '',
      userId: user.id,
      userName: profile.full_name ?? user.user_metadata.full_name ?? user.email ?? 'Superadmin',
      role: 'superadmin',
    })
  }

  const { data: memberships, error: membershipError } = await supabase
    .from('tenant_memberships')
    .select('tenant_id, role')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .limit(2)

  if (membershipError) {
    throw new Error(`No se pudo cargar la membresia del usuario: ${getReadableError(membershipError)}`)
  }

  const activeMemberships = (memberships ?? []) as UserMembershipRow[]

  if (activeMemberships.length === 0) {
    throw new Error(`El usuario ${user.email ?? user.id} no tiene acceso activo a ningun negocio.`)
  }

  if (activeMemberships.length > 1) {
    throw new Error('Este usuario pertenece a mas de un negocio. Usa una cuenta diferente para cada negocio.')
  }

  const membership = activeMemberships[0]
  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('id, name, slug, is_active')
    .eq('id', membership.tenant_id)
    .single<TenantRow>()

  if (tenantError || !tenant || tenant.is_active === false) {
    throw new Error(`No se pudo cargar el negocio asignado: ${getReadableError(tenantError)}`)
  }

  if (membership.role === 'owner' || membership.role === 'admin') {
    return requireExclusiveLogin({
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      venueId: '',
      venueName: '',
      deviceId: '',
      deviceName: '',
      userId: user.id,
      userName: user.user_metadata.full_name ?? user.email ?? 'Administrador',
      role: membership.role,
    })
  }

  if (membership.role !== 'cashier') {
    throw new Error('Este usuario no tiene permisos de administracion ni una cuenta de caja compatible.')
  }

  const { data: assignment, error: assignmentError } = await supabase
    .from('device_user_assignments')
    .select('tenant_id, user_id, venue_id, device_id, is_active')
    .eq('tenant_id', tenant.id)
    .eq('user_id', user.id)
    .eq('is_active', true)
    .maybeSingle<DeviceAssignmentRow>()

  if (assignmentError) {
    throw new Error(`No se pudo cargar la asignacion del TPV: ${getReadableError(assignmentError)}`)
  }

  if (!assignment) {
    throw new Error('Este usuario no tiene ningun dispositivo activo asignado. Contacta con administracion.')
  }

  const [{ data: venue, error: venueError }, { data: device, error: deviceError }] = await Promise.all([
    supabase
      .from('venues')
      .select('id, name, address, legal_name, tax_id')
      .eq('tenant_id', tenant.id)
      .eq('id', assignment.venue_id)
      .eq('is_active', true)
      .maybeSingle<VenueRow>(),
    supabase
      .from('devices')
      .select('id, name, device_mode, default_cash_register_id, can_take_orders, can_take_payments, can_open_cash_session, can_close_cash_session, can_manage_cash')
      .eq('tenant_id', tenant.id)
      .eq('venue_id', assignment.venue_id)
      .eq('id', assignment.device_id)
      .eq('is_active', true)
      .maybeSingle<DeviceRow>(),
  ])

  if (venueError) {
    throw new Error(`No se pudo cargar el local: ${getReadableError(venueError)}`)
  }

  if (deviceError) {
    throw new Error(`No se pudo cargar el dispositivo asignado: ${getReadableError(deviceError)}`)
  }

  if (!venue || !device) {
    throw new Error('El local o dispositivo asignado esta desactivado o ya no existe.')
  }

  return requireExclusiveLogin({
    tenantId: tenant.id,
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
    venueId: venue.id,
    venueName: venue.name,
    venueAddress: venue.address ?? undefined,
    venueLegalName: venue.legal_name ?? undefined,
    venueTaxId: venue.tax_id ?? undefined,
    deviceId: device.id,
    deviceName: device.name,
    deviceMode: device.device_mode,
    defaultCashRegisterId: device.default_cash_register_id,
    canTakeOrders: device.can_take_orders,
    canTakePayments: device.can_take_payments,
    canOpenCashSession: device.can_open_cash_session,
    canCloseCashSession: device.can_close_cash_session,
    canManageCash: device.can_manage_cash,
    userId: user.id,
    userName: user.user_metadata.full_name ?? user.email ?? 'Usuario',
    role: membership.role,
  })
}

export class TenantSessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TenantSessionError'
  }
}

export class LoginLeaseConflictError extends TenantSessionError {
  readonly context: TenantContext

  constructor(message: string, context: TenantContext) {
    super(message)
    this.name = 'LoginLeaseConflictError'
    this.context = context
  }
}

export async function restoreTenantContext(cachedContext: TenantContext): Promise<TenantContext> {
  if (!supabase) {
    throw new Error('Supabase no esta configurado.')
  }

  const { data: authData, error: authError } = await supabase.auth.getUser()

  if (authError) {
    const authStatus = (authError as { status?: number }).status
    if (authError.name === 'AuthSessionMissingError' || authStatus === 401 || authStatus === 403) {
      throw new TenantSessionError('La sesion ha caducado. Inicia sesion de nuevo.')
    }

    throw authError
  }

  const user = authData.user

  if (!user || user.id !== cachedContext.userId) {
    throw new TenantSessionError('La sesion guardada no pertenece al usuario de este TPV.')
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('full_name, is_superadmin')
    .eq('id', user.id)
    .maybeSingle<{ full_name: string | null; is_superadmin: boolean }>()

  if (profileError) {
    throw profileError
  }

  if (profile?.is_superadmin) {
    return requireExclusiveLogin({
      tenantId: '',
      tenantName: 'Plataforma CLUB POS',
      tenantSlug: '',
      venueId: '',
      venueName: '',
      deviceId: '',
      deviceName: '',
      userId: user.id,
      userName: profile.full_name ?? user.user_metadata.full_name ?? user.email ?? 'Superadmin',
      role: 'superadmin',
    })
  }

  const [{ data: tenant, error: tenantError }, { data: membership, error: membershipError }] = await Promise.all([
    supabase
      .from('tenants')
      .select('id, name, slug, is_active')
      .eq('id', cachedContext.tenantId)
      .maybeSingle<TenantRow>(),
    supabase
      .from('tenant_memberships')
      .select('role')
      .eq('tenant_id', cachedContext.tenantId)
      .eq('user_id', user.id)
      .eq('is_active', true)
      .maybeSingle<MembershipRow>(),
  ])

  if (tenantError || membershipError) {
    throw tenantError ?? membershipError
  }

  if (!tenant || tenant.is_active === false || !membership) {
    throw new TenantSessionError('El usuario ya no tiene acceso activo a este negocio.')
  }

  if (membership.role === 'owner' || membership.role === 'admin') {
    return requireExclusiveLogin({
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      venueId: '',
      venueName: '',
      deviceId: '',
      deviceName: '',
      userId: user.id,
      userName: user.user_metadata.full_name ?? user.email ?? 'Administrador',
      role: membership.role,
    })
  }

  const { data: assignment, error: assignmentError } = await supabase
    .from('device_user_assignments')
    .select('tenant_id, user_id, venue_id, device_id, is_active')
    .eq('tenant_id', tenant.id)
    .eq('user_id', user.id)
    .eq('is_active', true)
    .maybeSingle<DeviceAssignmentRow>()

  if (assignmentError) {
    throw assignmentError
  }

  if (membership.role !== 'cashier' || !assignment) {
    throw new TenantSessionError('El usuario ya no tiene un dispositivo activo asignado.')
  }

  const [{ data: venue, error: venueError }, { data: device, error: deviceError }] = await Promise.all([
    supabase
      .from('venues')
      .select('id, name, address, legal_name, tax_id')
      .eq('tenant_id', tenant.id)
      .eq('id', assignment.venue_id)
      .eq('is_active', true)
      .maybeSingle<VenueRow>(),
    supabase
      .from('devices')
      .select('id, name, device_mode, default_cash_register_id, can_take_orders, can_take_payments, can_open_cash_session, can_close_cash_session, can_manage_cash')
      .eq('tenant_id', tenant.id)
      .eq('venue_id', assignment.venue_id)
      .eq('id', assignment.device_id)
      .eq('is_active', true)
      .maybeSingle<DeviceRow>(),
  ])

  if (venueError || deviceError) {
    throw venueError ?? deviceError
  }

  if (!venue || !device) {
    throw new TenantSessionError('El local o dispositivo asignado esta desactivado.')
  }

  return requireExclusiveLogin({
    tenantId: tenant.id,
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
    venueId: venue.id,
    venueName: venue.name,
    venueAddress: venue.address ?? undefined,
    venueLegalName: venue.legal_name ?? undefined,
    venueTaxId: venue.tax_id ?? undefined,
    deviceId: device.id,
    deviceName: device.name,
    deviceMode: device.device_mode,
    defaultCashRegisterId: device.default_cash_register_id,
    canTakeOrders: device.can_take_orders,
    canTakePayments: device.can_take_payments,
    canOpenCashSession: device.can_open_cash_session,
    canCloseCashSession: device.can_close_cash_session,
    canManageCash: device.can_manage_cash,
    userId: user.id,
    userName: user.user_metadata.full_name ?? user.email ?? 'Usuario',
    role: membership.role,
  })
}

export async function hasValidOfflineSession(context: TenantContext) {
  if (!supabase) {
    return false
  }

  const { data, error } = await supabase.auth.getSession()
  const session = data.session
  const expiresAtMs = session?.expires_at ? session.expires_at * 1000 : 0

  return !error && Boolean(session && session.user.id === context.userId && expiresAtMs > Date.now())
}

export async function logoutTenant() {
  if (!supabase) {
    return
  }

  let leaseError: unknown = null

  try {
    await releaseLoginLease()
  } catch (error) {
    leaseError = error
    releaseLocalLoginLock()
  }

  const { error } = await supabase.auth.signOut({ scope: 'local' })

  if (error || leaseError) {
    throw error ?? leaseError
  }
}

export async function loadCatalogFromSupabase(context: TenantContext): Promise<Catalog> {
  return loadCurrentCatalog(context)
}

export async function loadOpenCashSession(context: TenantContext) {
  if (!supabase) {
    return null
  }

  const { data, error } = await supabase
    .from('cash_sessions')
    .select('id, tenant_id, venue_id, opened_by_device_id, opened_by, opened_at, opening_float_cents, cash_register_id, cash_registers(name)')
    .eq('tenant_id', context.tenantId)
    .eq('venue_id', context.venueId)
    .eq('status', 'open')
    .order('opened_at', { ascending: false })

  if (error) {
    throw error
  }

  if (!data?.length) {
    return null
  }

  const selected = data.length === 1 ? data[0] : null
  if (!selected) return null

  return {
    id: selected.id as string,
    tenantId: selected.tenant_id as string,
    venueId: selected.venue_id as string,
    deviceId: selected.opened_by_device_id as string,
    cashRegisterId: selected.cash_register_id as string,
    cashRegisterName: (selected.cash_registers as unknown as { name?: string } | null)?.name ?? 'Caja',
    userId: selected.opened_by as string,
    openedAt: selected.opened_at as string,
    openingFloatCents: selected.opening_float_cents as number,
    status: 'open' as const,
  }
}

export async function loadSalesLedgerFromSupabase(context: TenantContext, cashSessionId: string) {
  if (!supabase) {
    return []
  }

  const { data, error } = await supabase
    .from('sales')
    .select('id, cash_session_id, payment_method, total_cents, created_at')
    .eq('tenant_id', context.tenantId)
    .eq('cash_session_id', cashSessionId)
    .order('created_at', { ascending: true })

  if (error) {
    throw error
  }

  return ((data ?? []) as SaleRow[]).map((sale) => ({
    id: sale.id,
    cashSessionId: sale.cash_session_id,
    paymentMethod: sale.payment_method,
    totalCents: sale.total_cents,
    createdAt: sale.created_at,
  }))
}

type SessionTicketQueryRow = {
  id: string
  tenant_id: string
  cash_session_id: string
  cash_register_id: string
  venue_id: string
  device_id: string
  user_id: string
  status: 'paid' | 'void'
  subtotal_cents: number
  discount_id: string | null
  discount_name: string | null
  discount_type: 'percentage' | 'fixed' | 'manual' | null
  discount_value_type: 'percentage' | 'fixed' | null
  discount_value: number | string | null
  discount_rounding_increment_cents: 5 | 10 | 50 | 100 | null
  discount_amount_cents: number | null
  total_cents: number
  local_created_at: string
  ticket_lines: Array<{
    id: string
    product_id: string | null
    variant_id: string | null
    product_name: string
    variant_name: string
    quantity: number
    allocated_quantity: number | null
    unit_price_cents: number
    line_total_cents: number
    tax_rate: number | null
    taxable_base_cents: number | null
    tax_amount_cents: number | null
    modifiers: TicketLineModifier[]
    sale_format_id: string | null
    sale_format_name_snapshot: string | null
    category_id_snapshot: string | null
    category_name_snapshot: string | null
    catalog_tab_id_snapshot: string | null
    catalog_tab_name_snapshot: string | null
    base_price_cents: number | null
    component_delta_cents: number | null
    modifier_delta_cents: number | null
    gross_before_discount_cents: number | null
    ticket_line_components: Array<{
      id: string; component_type: 'mixer' | 'menu_component'; selection_group_id: string | null; selection_group_name_snapshot: string
      product_id: string | null; variant_id: string | null; product_name_snapshot: string; variant_name_snapshot: string
      quantity: number; price_delta_cents: number; sort_order: number
      metadata: { modifiers?: Array<{ id: string; groupId: string; name: string; priceCents: number }> } | null
    }> | null
  }> | null
  sales: Array<{
    id: string
    payment_method: HistoricalPaymentMethod | null
    total_cents: number
    local_created_at: string
    sale_payments: Array<{
      id: string
      method: HistoricalPaymentMethod
      amount_cents: number
      received_cents: number | null
      change_cents: number
    }> | null
  }> | null
}

export async function loadSessionTicketsFromSupabase(
  context: TenantContext,
  cashSessionId: string,
): Promise<SessionTicketRecord[]> {
  if (!supabase) {
    throw new Error('Supabase no esta configurado.')
  }

  const [{ data: ticketData, error: ticketsError }, { data: eventData, error: eventsError }] = await Promise.all([
    supabase
      .from('tickets')
      .select(`
        id,
        tenant_id,
        cash_session_id,
        cash_register_id,
        venue_id,
        device_id,
        user_id,
        status,
        subtotal_cents,
        discount_id,
        discount_name,
        discount_type,
        discount_value_type,
        discount_value,
        discount_rounding_increment_cents,
        discount_amount_cents,
        total_cents,
        local_created_at,
        ticket_lines (
          id,
          product_id,
          variant_id,
          product_name,
          variant_name,
          quantity,
          allocated_quantity,
          unit_price_cents,
          line_total_cents,
          tax_rate,
          taxable_base_cents,
          tax_amount_cents,
          modifiers
          ,sale_format_id,
          sale_format_name_snapshot,
          category_id_snapshot,
          category_name_snapshot,
          catalog_tab_id_snapshot,
          catalog_tab_name_snapshot,
          base_price_cents,
          component_delta_cents,
          modifier_delta_cents,
          gross_before_discount_cents,
          ticket_line_components (
            id, component_type, selection_group_id, selection_group_name_snapshot,
            product_id, variant_id, product_name_snapshot, variant_name_snapshot,
            quantity, price_delta_cents, sort_order, metadata
          )
        ),
        sales (
          id,
          payment_method,
          total_cents,
          local_created_at,
          sale_payments (
            id,
            method,
            amount_cents,
            received_cents,
            change_cents
          )
        )
      `)
      .eq('tenant_id', context.tenantId)
      .eq('cash_session_id', cashSessionId)
      .order('local_created_at', { ascending: false }),
    supabase
      .from('offline_event_log')
      .select('payload')
      .eq('tenant_id', context.tenantId)
      .eq('event_kind', 'sale_created')
      .filter('payload->ticket->>cashSessionId', 'eq', cashSessionId),
  ])

  if (ticketsError || eventsError) {
    throw ticketsError ?? eventsError
  }

  const loggedPayloads = new Map<string, SaleCreatedPayload>()

  for (const row of eventData ?? []) {
    const payload = row.payload as SaleCreatedPayload | null

    if (payload?.ticket?.id) {
      loggedPayloads.set(payload.ticket.id, payload)
    }
  }

  return ((ticketData ?? []) as SessionTicketQueryRow[]).map((ticket) => {
    const loggedPayload = loggedPayloads.get(ticket.id)
    const sale = ticket.sales?.[0]
    const payment = sale?.sale_payments?.[0]
    const saleId = sale?.id ?? loggedPayload?.sale.id ?? ticket.id
    const paymentMethod = sale?.payment_method ?? loggedPayload?.sale.paymentMethod ?? null
    const createdAt = sale?.local_created_at ?? loggedPayload?.sale.createdAt ?? ticket.local_created_at
    const lines = (ticket.ticket_lines ?? []).map((line) => {
      const loggedLine = loggedPayload?.lines.find((item) => item.id === line.id)

      return {
        id: line.id,
        ticketId: ticket.id,
        tenantId: ticket.tenant_id,
        productId: line.product_id ?? loggedLine?.productId ?? '',
        variantId: line.variant_id ?? loggedLine?.variantId ?? '',
        productName: line.product_name,
        variantName: line.variant_name,
        basePriceCents: loggedLine?.basePriceCents ?? line.base_price_cents ?? line.unit_price_cents - (line.modifiers ?? []).reduce((total, modifier) => total + modifier.priceCents, 0),
        componentDeltaCents: loggedLine?.componentDeltaCents ?? line.component_delta_cents ?? 0,
        modifierDeltaCents: loggedLine?.modifierDeltaCents ?? line.modifier_delta_cents ?? (line.modifiers ?? []).reduce((total, modifier) => total + modifier.priceCents, 0),
        grossBeforeDiscountCents: loggedLine?.grossBeforeDiscountCents ?? line.gross_before_discount_cents ?? line.unit_price_cents,
        quantity: Number(line.allocated_quantity ?? line.quantity),
        unitPriceCents: line.unit_price_cents,
        lineTotalCents: line.line_total_cents,
        fiscalSnapshot: mapFiscalSnapshot(line),
        modifiers: line.modifiers ?? [],
        components: loggedLine?.components ?? (line.ticket_line_components ?? []).map((component) => ({
          id: component.id, type: component.component_type, selectionGroupId: component.selection_group_id,
          selectionGroupName: component.selection_group_name_snapshot, productId: component.product_id ?? '',
          variantId: component.variant_id, productName: component.product_name_snapshot,
          variantName: component.variant_name_snapshot, quantity: component.quantity,
          priceDeltaCents: component.price_delta_cents, sortOrder: component.sort_order,
          modifiers: component.metadata?.modifiers ?? [],
        })),
        catalogSnapshot: loggedLine?.catalogSnapshot ?? { saleFormatId: line.sale_format_id, saleFormatName: line.sale_format_name_snapshot ?? line.variant_name, categoryId: line.category_id_snapshot, categoryName: line.category_name_snapshot ?? '', catalogTabId: line.catalog_tab_id_snapshot, catalogTabName: line.catalog_tab_name_snapshot ?? '' },
      }
    })
    const payload: SaleCreatedPayload = {
      ticket: {
        id: ticket.id,
        tenantId: ticket.tenant_id,
        cashSessionId: ticket.cash_session_id,
        cashRegisterId: ticket.cash_register_id,
        venueId: ticket.venue_id,
        deviceId: ticket.device_id,
        userId: ticket.user_id,
        subtotalCents: ticket.subtotal_cents,
        discount: ticket.discount_type && ticket.discount_name && ticket.discount_value_type && ticket.discount_value !== null
          ? {
              discountId: ticket.discount_id,
              name: ticket.discount_name,
              type: ticket.discount_type,
              calculationType: ticket.discount_value_type,
              value: ticket.discount_value_type === 'fixed'
                ? Math.round(Number(ticket.discount_value) * 100)
                : Number(ticket.discount_value),
              roundingIncrementCents: ticket.discount_rounding_increment_cents,
              color: null,
            }
          : null,
        discountAmountCents: ticket.discount_amount_cents ?? 0,
        totalCents: ticket.total_cents,
        createdAt: ticket.local_created_at,
      },
      lines,
      sale: {
        id: saleId,
        tenantId: ticket.tenant_id,
        ticketId: ticket.id,
        cashSessionId: ticket.cash_session_id,
        cashRegisterId: ticket.cash_register_id,
        venueId: ticket.venue_id,
        deviceId: ticket.device_id,
        userId: ticket.user_id,
        totalCents: sale?.total_cents ?? ticket.total_cents,
        paymentMethod,
        createdAt,
      },
      payment: payment && (payment.method === 'cash' || payment.method === 'card') ? {
        id: payment.id,
        tenantId: ticket.tenant_id,
        saleId,
        method: payment.method,
        amountCents: payment.amount_cents,
        receivedCents: payment.received_cents,
        changeCents: payment.change_cents,
      } : null,
    }

    return {
      id: saleId,
      cashSessionId: ticket.cash_session_id,
      paymentMethod,
      totalCents: ticket.total_cents,
      createdAt,
      status: ticket.status === 'void' ? 'voided' : 'active',
      payload,
    }
  })
}

export async function loadProductSalesStatsFromSupabase(context: TenantContext): Promise<ProductSalesStat[]> {
  if (!supabase) {
    return []
  }

  const { data, error } = await supabase
    .from('ticket_lines')
    .select('product_id, quantity, allocated_quantity, line_total_cents, tickets!inner(status)')
    .eq('tenant_id', context.tenantId)
    .eq('tickets.status', 'paid')
    .not('product_id', 'is', null)

  if (error) {
    throw error
  }

  const statsByProduct = new Map<string, ProductSalesStat>()
  const lines = (data ?? []) as TicketLineProductSalesRow[]

  lines.forEach((line) => {
    if (!line.product_id) {
      return
    }

    const current = statsByProduct.get(line.product_id) ?? {
      productId: line.product_id,
      quantity: 0,
      totalCents: 0,
    }

    statsByProduct.set(line.product_id, {
      ...current,
      quantity: current.quantity + Number(line.allocated_quantity ?? line.quantity),
      totalCents: current.totalCents + line.line_total_cents,
    })
  })

  return [...statsByProduct.values()].sort(
    (a, b) => b.quantity - a.quantity || b.totalCents - a.totalCents || a.productId.localeCompare(b.productId),
  )
}

export function mergeLedgers(localRecords: SaleRecord[], remoteRecords: SaleRecord[]) {
  const recordsById = new Map<string, SaleRecord>()

  remoteRecords.forEach((record) => recordsById.set(record.id, record))
  localRecords.forEach((record) => recordsById.set(record.id, record))

  return [...recordsById.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function buildSalePayload(
  context: TenantContext,
  cashSession: CashSession,
  lines: TicketLine[],
  paymentMethod: PaymentMethod | null,
  receivedCents: number | null,
  discount: AppliedDiscount | null,
): SaleCreatedPayload {
  const createdAt = nowIso()
  const ticketId = createId()
  const saleId = createId()
  const subtotalCents = getTicketTotal(lines)
  const { discountAmountCents, totalCents } = calculateAppliedDiscount(subtotalCents, discount)
  assertValidTicketPayment(totalCents, paymentMethod)
  const saleLines: SaleLinePayload[] = lines.map((line) => ({
    id: createId(),
    ticketId,
    tenantId: context.tenantId,
    productId: line.productId,
    variantId: line.variantId,
    productName: line.productName,
    variantName: line.variantName,
    basePriceCents: line.basePriceCents,
    componentDeltaCents: line.componentDeltaCents,
    modifierDeltaCents: line.modifierDeltaCents,
    grossBeforeDiscountCents: line.unitPriceCents,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    lineTotalCents: getLineTotal(line),
    modifiers: line.modifiers,
    components: line.components,
    catalogSnapshot: line.catalogSnapshot,
    fiscalSnapshot: null,
  }))

  return {
    ticket: {
      id: ticketId,
      tenantId: context.tenantId,
      cashSessionId: cashSession.id,
      cashRegisterId: cashSession.cashRegisterId,
      venueId: context.venueId,
      deviceId: context.deviceId,
      userId: context.userId,
      subtotalCents,
      discount,
      discountAmountCents,
      totalCents,
      createdAt,
    },
    lines: saleLines,
    sale: {
      id: saleId,
      tenantId: context.tenantId,
      ticketId,
      cashSessionId: cashSession.id,
      cashRegisterId: cashSession.cashRegisterId,
      venueId: context.venueId,
      deviceId: context.deviceId,
      userId: context.userId,
      totalCents,
      paymentMethod,
      createdAt,
    },
    payment: paymentMethod ? {
      id: createId(),
      tenantId: context.tenantId,
      saleId,
      method: paymentMethod,
      amountCents: totalCents,
      receivedCents,
      changeCents: Math.max(0, (receivedCents ?? totalCents) - totalCents),
    } : null,
  }
}

export async function syncEvent(event: OfflineEvent) {
  if (!supabase) {
    throw new Error('Supabase no esta configurado.')
  }

  if (event.kind === 'cash_opened') {
    const { session } = event.payload
    const { error } = await supabase.from('cash_sessions').upsert(
      {
        id: session.id,
        tenant_id: session.tenantId,
        venue_id: session.venueId,
        device_id: session.deviceId,
        opened_by: session.userId,
        opened_at: session.openedAt,
        opening_float_cents: session.openingFloatCents,
        status: 'open',
        sync_source: 'offline_first',
      },
      { ignoreDuplicates: true, onConflict: 'id' },
    )

    if (error) {
      throw error
    }

    return
  }

  if (event.kind === 'sale_created') {
    const rpcName = 'subtotalCents' in event.payload.ticket
      ? 'sync_sale_created_v2'
      : 'sync_sale_created'
    const { error } = await supabase.rpc(rpcName, {
      p_event_id: event.id,
      p_payload: event.payload,
    })

    if (error) {
      throw error
    }

    return
  }

  if (event.kind === 'sale_payment_changed') {
    const { changeCents, paymentId, paymentMethod, receivedCents, saleId } = event.payload
    const { error: saleError } = await supabase
      .from('sales')
      .update({ payment_method: paymentMethod })
      .eq('tenant_id', event.tenantId)
      .eq('id', saleId)

    if (saleError) {
      throw saleError
    }

    const { error: paymentError } = await supabase
      .from('sale_payments')
      .update({
        method: paymentMethod,
        received_cents: receivedCents,
        change_cents: changeCents,
      })
      .eq('tenant_id', event.tenantId)
      .eq('id', paymentId)

    if (paymentError) {
      throw paymentError
    }

    return
  }

  if (event.kind === 'sale_voided') {
    const { saleId, ticketId } = event.payload
    const { error: paymentError } = await supabase
      .from('sale_payments')
      .delete()
      .eq('tenant_id', event.tenantId)
      .eq('sale_id', saleId)

    if (paymentError) {
      throw paymentError
    }

    const { error: saleError } = await supabase
      .from('sales')
      .delete()
      .eq('tenant_id', event.tenantId)
      .eq('id', saleId)

    if (saleError) {
      throw saleError
    }

    const { error: ticketError } = await supabase
      .from('tickets')
      .update({ status: 'void' })
      .eq('tenant_id', event.tenantId)
      .eq('id', ticketId)

    if (ticketError) {
      throw ticketError
    }

    return
  }

  const payload: CashClosedPayload = event.payload
  const { error } = await supabase
    .from('cash_sessions')
    .update({
      status: 'closed',
      closed_at: payload.closedAt,
      closed_by: payload.closedBy,
      expected_cash_cents: payload.expectedCashCents,
      expected_card_cents: payload.expectedCardCents,
      expected_invitation_cents: payload.expectedInvitationCents,
      expected_other_cents: payload.expectedOtherCents,
      counted_cash_cents: payload.countedCashCents,
      counted_card_cents: payload.countedCardCents,
      counted_invitation_cents: payload.countedInvitationCents,
      counted_other_cents: payload.countedOtherCents,
      discrepancy_cents: payload.discrepancyCents,
      notes: payload.notes,
    })
    .eq('id', payload.sessionId)
    .eq('tenant_id', payload.tenantId)
    .eq('status', 'open')

  if (error) {
    throw error
  }
}

export function subscribeToCashSessionChanges(
  context: TenantContext,
  onChange: () => void,
) {
  if (!supabase) {
    return () => undefined
  }

  const client = supabase
  const channel = client
    .channel(`cash-sessions-${context.tenantId}-${context.venueId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'cash_sessions',
        filter: `venue_id=eq.${context.venueId}`,
      },
      (payload) => {
        const session = (Object.keys(payload.new).length ? payload.new : payload.old) as {
          tenant_id?: string
        }

        if (session.tenant_id === context.tenantId) {
          onChange()
        }
      },
    )
    .subscribe()

  return () => {
    void client.removeChannel(channel)
  }
}
