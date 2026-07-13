import { createId, getLineTotal, getTicketTotal } from '../lib/format'
import { defaultSaleFormats } from '../lib/catalog'
import { PRODUCT_IMAGE_BUCKET } from '../lib/productImages'
import { supabase } from '../lib/supabase'
import type {
  CashClosedPayload,
  CashSession,
  CashSummary,
  Catalog,
  Category,
  LoginInput,
  ModifierGroup,
  OfflineEvent,
  PaymentMethod,
  Product,
  ProductSalesStat,
  ProductVariant,
  SaleCreatedPayload,
  SaleLinePayload,
  SaleRecord,
  SessionTicketRecord,
  TenantContext,
  TicketLine,
  TicketLineModifier,
} from '../types'
import type {
  CategoryRow,
  DeviceAssignmentRow,
  DeviceRow,
  MembershipRow,
  ModifierGroupRow,
  ProductRow,
  SaleFormatRow,
  SaleRow,
  TicketLineProductSalesRow,
  TenantRow,
  UserMembershipRow,
  VariantRow,
  VenueRow,
} from '../types/supabase'
import { nowIso } from '../utils/dates'
import { getReadableError } from '../utils/errors'
import { claimLoginLease, releaseLocalLoginLock, releaseLoginLease } from './loginLeaseService'

async function requireExclusiveLogin() {
  if (await claimLoginLease()) {
    return
  }

  releaseLocalLoginLock()
  throw new LoginLeaseConflictError('Esta cuenta ya esta abierta en otro dispositivo o pestana.')
}

function mapCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    kind: row.kind,
    icon: row.icon ?? row.kind,
    isActive: row.is_active,
    sortOrder: row.sort_order,
  }
}

function mapSaleFormat(row: SaleFormatRow) {
  return {
    key: row.key,
    label: row.label,
    isActive: row.is_active,
    sortOrder: row.sort_order,
  }
}

function mapVariant(row: VariantRow): ProductVariant {
  return {
    id: row.id,
    productId: row.product_id,
    name: row.name,
    priceCents: row.price_cents,
    sku: row.sku,
    isDefault: row.is_default,
    sortOrder: row.sort_order,
  }
}

function mapModifierGroups(rows: ModifierGroupRow[] | null): ModifierGroup[] {
  return (rows ?? [])
    .map((group) => ({
      id: group.id,
      productId: group.product_id,
      name: group.name,
      minSelect: group.min_select,
      maxSelect: group.max_select,
      sortOrder: group.sort_order,
      modifiers: (group.modifiers ?? [])
        .map((modifier) => ({
          id: modifier.id,
          groupId: modifier.group_id,
          name: modifier.name,
          priceCents: modifier.price_cents,
          sortOrder: modifier.sort_order,
        }))
        .sort((a, b) => a.sortOrder - b.sortOrder),
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

function getProductImageUrl(imagePath: string | null | undefined) {
  if (!imagePath || !supabase) {
    return null
  }

  return supabase.storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(imagePath).data.publicUrl
}

function inferSaleFormats(kind: ProductRow['kind']) {
  if (kind === 'alcohol' || kind === 'mixed') {
    return ['cubata'] as const
  }
  if (kind === 'shot') {
    return ['shot'] as const
  }
  if (kind === 'beer' || kind === 'beer_bottle') {
    return ['beer_bottle'] as const
  }
  if (kind === 'soft_bottle' || kind === 'mixer') {
    return ['soft_bottle'] as const
  }
  if (kind === 'cocktail') {
    return ['cocktail'] as const
  }

  return ['soft_bottle'] as const
}

function mapProduct(row: ProductRow): Product {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    venueId: row.venue_id,
    categoryId: row.category_id,
    name: row.name,
    description: row.description,
    imagePath: row.image_path ?? null,
    imageUrl: getProductImageUrl(row.image_path),
    kind: row.kind,
    saleFormats: row.sale_formats?.length ? row.sale_formats : [...inferSaleFormats(row.kind)],
    canSellStandalone: row.can_sell_standalone ?? row.kind !== 'mixer',
    canUseAsMixer: row.can_use_as_mixer ?? row.kind === 'mixer',
    isFeatured: row.is_featured ?? false,
    mixerSupplementCents: row.mixer_supplement_cents ?? 0,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    variants: (row.product_variants ?? []).map(mapVariant).sort((a, b) => a.sortOrder - b.sortOrder),
    modifierGroups: mapModifierGroups(row.modifier_groups),
  }
}

export function summarizeSales(openingFloatCents: number, records: SaleRecord[]): CashSummary {
  return records.reduce(
    (totals, record) => {
      if (record.paymentMethod === 'cash') {
        totals.cashCents += record.totalCents
      } else if (record.paymentMethod === 'card') {
        totals.cardCents += record.totalCents
      } else if (record.paymentMethod === 'invitation') {
        totals.invitationCents += record.totalCents
      } else {
        totals.otherCents += record.totalCents
      }

      totals.totalSalesCents += record.totalCents
      return totals
    },
    {
      cashCents: openingFloatCents,
      cardCents: 0,
      invitationCents: 0,
      otherCents: 0,
      totalSalesCents: 0,
    },
  )
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
    .select('id, name, slug')
    .eq('id', membership.tenant_id)
    .single<TenantRow>()

  if (tenantError || !tenant) {
    throw new Error(`No se pudo cargar el negocio asignado: ${getReadableError(tenantError)}`)
  }

  if (membership.role === 'owner' || membership.role === 'admin') {
    await requireExclusiveLogin()
    return {
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
    }
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
      .select('id, name')
      .eq('tenant_id', tenant.id)
      .eq('id', assignment.venue_id)
      .eq('is_active', true)
      .maybeSingle<VenueRow>(),
    supabase
      .from('devices')
      .select('id, name')
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

  await requireExclusiveLogin()
  return {
    tenantId: tenant.id,
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
    venueId: venue.id,
    venueName: venue.name,
    deviceId: device.id,
    deviceName: device.name,
    userId: user.id,
    userName: user.user_metadata.full_name ?? user.email ?? 'Usuario',
    role: membership.role,
  }
}

export class TenantSessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TenantSessionError'
  }
}

export class LoginLeaseConflictError extends TenantSessionError {
  constructor(message: string) {
    super(message)
    this.name = 'LoginLeaseConflictError'
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

  const [{ data: tenant, error: tenantError }, { data: membership, error: membershipError }] = await Promise.all([
    supabase
      .from('tenants')
      .select('id, name, slug')
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

  if (!tenant || !membership) {
    throw new TenantSessionError('El usuario ya no tiene acceso activo a este negocio.')
  }

  if (membership.role === 'owner' || membership.role === 'admin') {
    await requireExclusiveLogin()
    return {
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
    }
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
      .select('id, name')
      .eq('tenant_id', tenant.id)
      .eq('id', assignment.venue_id)
      .eq('is_active', true)
      .maybeSingle<VenueRow>(),
    supabase
      .from('devices')
      .select('id, name')
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

  await requireExclusiveLogin()
  return {
    tenantId: tenant.id,
    tenantName: tenant.name,
    tenantSlug: tenant.slug,
    venueId: venue.id,
    venueName: venue.name,
    deviceId: device.id,
    deviceName: device.name,
    userId: user.id,
    userName: user.user_metadata.full_name ?? user.email ?? 'Usuario',
    role: membership.role,
  }
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
  if (!supabase) {
    throw new Error('Supabase no esta configurado.')
  }

  const [
    { data: categoryRows, error: categoriesError },
    { data: saleFormatRows, error: saleFormatsError },
    { data: productRows, error: productsError },
  ] =
    await Promise.all([
      supabase
        .from('categories')
        .select('id, tenant_id, name, kind, icon, is_active, sort_order')
        .eq('tenant_id', context.tenantId)
        .order('sort_order', { ascending: true }),
      supabase
        .from('sale_formats')
        .select('key, label, is_active, sort_order')
        .eq('tenant_id', context.tenantId)
        .order('sort_order', { ascending: true }),
      supabase
        .from('products')
        .select(
          `
          id,
          tenant_id,
          venue_id,
          category_id,
          name,
          description,
          image_path,
          kind,
          sale_formats,
          can_sell_standalone,
          can_use_as_mixer,
          is_featured,
          mixer_supplement_cents,
          is_active,
          sort_order,
          product_variants (
            id,
            product_id,
            name,
            price_cents,
            sku,
            is_default,
            sort_order
          ),
          modifier_groups (
            id,
            product_id,
            name,
            min_select,
            max_select,
            sort_order,
            modifiers (
              id,
              group_id,
              name,
              price_cents,
              sort_order
            )
          )
        `,
        )
        .eq('tenant_id', context.tenantId)
        .order('sort_order', { ascending: true }),
    ])

  if (categoriesError) {
    throw categoriesError
  }

  if (saleFormatsError) {
    throw saleFormatsError
  }

  if (productsError) {
    throw productsError
  }

  const saleFormats = ((saleFormatRows ?? []) as SaleFormatRow[]).map(mapSaleFormat)
  const allProducts = ((productRows ?? []) as ProductRow[]).map(mapProduct)
  const products = context.venueId
    ? allProducts.filter((product) => product.venueId === context.venueId)
    : allProducts
  const visibleCategoryIds = new Set(products.map((product) => product.categoryId))

  return {
    categories: ((categoryRows ?? []) as CategoryRow[])
      .map(mapCategory)
      .filter((category) => !context.venueId || visibleCategoryIds.has(category.id)),
    products,
    saleFormats: saleFormats.length ? saleFormats : defaultSaleFormats,
    updatedAt: nowIso(),
    source: 'supabase',
  }
}

export async function loadOpenCashSession(context: TenantContext) {
  if (!supabase) {
    return null
  }

  const { data, error } = await supabase
    .from('cash_sessions')
    .select('id, tenant_id, venue_id, device_id, opened_by, opened_at, opening_float_cents')
    .eq('tenant_id', context.tenantId)
    .eq('device_id', context.deviceId)
    .eq('status', 'open')
    .order('opened_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw error
  }

  if (!data) {
    return null
  }

  return {
    id: data.id as string,
    tenantId: data.tenant_id as string,
    venueId: data.venue_id as string,
    deviceId: data.device_id as string,
    userId: data.opened_by as string,
    openedAt: data.opened_at as string,
    openingFloatCents: data.opening_float_cents as number,
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
  venue_id: string
  device_id: string
  user_id: string
  status: 'paid' | 'void'
  total_cents: number
  local_created_at: string
  ticket_lines: Array<{
    id: string
    product_id: string | null
    variant_id: string | null
    product_name: string
    variant_name: string
    quantity: number
    unit_price_cents: number
    line_total_cents: number
    modifiers: TicketLineModifier[]
  }> | null
  sales: Array<{
    id: string
    payment_method: PaymentMethod
    total_cents: number
    local_created_at: string
    sale_payments: Array<{
      id: string
      method: PaymentMethod
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
        venue_id,
        device_id,
        user_id,
        status,
        total_cents,
        local_created_at,
        ticket_lines (
          id,
          product_id,
          variant_id,
          product_name,
          variant_name,
          quantity,
          unit_price_cents,
          line_total_cents,
          modifiers
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
    const paymentMethod = sale?.payment_method ?? loggedPayload?.sale.paymentMethod ?? 'other'
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
        quantity: line.quantity,
        unitPriceCents: line.unit_price_cents,
        lineTotalCents: line.line_total_cents,
        modifiers: line.modifiers ?? [],
      }
    })
    const payload: SaleCreatedPayload = {
      ticket: {
        id: ticket.id,
        tenantId: ticket.tenant_id,
        cashSessionId: ticket.cash_session_id,
        venueId: ticket.venue_id,
        deviceId: ticket.device_id,
        userId: ticket.user_id,
        totalCents: ticket.total_cents,
        createdAt: ticket.local_created_at,
      },
      lines,
      sale: {
        id: saleId,
        tenantId: ticket.tenant_id,
        ticketId: ticket.id,
        cashSessionId: ticket.cash_session_id,
        venueId: ticket.venue_id,
        deviceId: ticket.device_id,
        userId: ticket.user_id,
        totalCents: sale?.total_cents ?? ticket.total_cents,
        paymentMethod,
        createdAt,
      },
      payment: {
        id: payment?.id ?? loggedPayload?.payment.id ?? ticket.id,
        tenantId: ticket.tenant_id,
        saleId,
        method: payment?.method ?? paymentMethod,
        amountCents: payment?.amount_cents ?? ticket.total_cents,
        receivedCents: payment?.received_cents ?? loggedPayload?.payment.receivedCents ?? null,
        changeCents: payment?.change_cents ?? loggedPayload?.payment.changeCents ?? 0,
      },
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
    .select('product_id, quantity, line_total_cents, tickets!inner(status)')
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
      quantity: current.quantity + line.quantity,
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
  paymentMethod: PaymentMethod,
  receivedCents: number | null,
): SaleCreatedPayload {
  const createdAt = nowIso()
  const ticketId = createId()
  const saleId = createId()
  const totalCents = getTicketTotal(lines)
  const saleLines: SaleLinePayload[] = lines.map((line) => ({
    id: createId(),
    ticketId,
    tenantId: context.tenantId,
    productId: line.productId,
    variantId: line.variantId,
    productName: line.productName,
    variantName: line.variantName,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    lineTotalCents: getLineTotal(line),
    modifiers: line.modifiers,
  }))

  return {
    ticket: {
      id: ticketId,
      tenantId: context.tenantId,
      cashSessionId: cashSession.id,
      venueId: context.venueId,
      deviceId: context.deviceId,
      userId: context.userId,
      totalCents,
      createdAt,
    },
    lines: saleLines,
    sale: {
      id: saleId,
      tenantId: context.tenantId,
      ticketId,
      cashSessionId: cashSession.id,
      venueId: context.venueId,
      deviceId: context.deviceId,
      userId: context.userId,
      totalCents,
      paymentMethod,
      createdAt,
    },
    payment: {
      id: createId(),
      tenantId: context.tenantId,
      saleId,
      method: paymentMethod,
      amountCents: totalCents,
      receivedCents,
      changeCents: Math.max(0, (receivedCents ?? totalCents) - totalCents),
    },
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
    const { error } = await supabase.rpc('sync_sale_created', {
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
    .channel(`cash-sessions-${context.deviceId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'cash_sessions',
        filter: `device_id=eq.${context.deviceId}`,
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
