import { createId, getLineTotal, getTicketTotal } from '../lib/format'
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
  ProductVariant,
  SaleCreatedPayload,
  SaleLinePayload,
  SaleRecord,
  TenantContext,
  TicketLine,
} from '../types'
import type {
  CategoryRow,
  DeviceRow,
  MembershipRow,
  ModifierGroupRow,
  ProductRow,
  SaleRow,
  TenantRow,
  VariantRow,
  VenueRow,
} from '../types/supabase'
import { nowIso } from '../utils/dates'
import { getReadableError } from '../utils/errors'

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
  if (kind === 'soft_bottle' || kind === 'mixer' || kind === 'other') {
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
    categoryId: row.category_id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    saleFormats: row.sale_formats?.length ? row.sale_formats : [...inferSaleFormats(row.kind)],
    canSellStandalone: row.can_sell_standalone ?? row.kind !== 'mixer',
    canUseAsMixer: row.can_use_as_mixer ?? row.kind === 'mixer',
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

  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('id, name, slug')
    .eq('slug', input.tenantSlug)
    .maybeSingle<TenantRow>()

  if (tenantError) {
    throw new Error(`No se pudo cargar el negocio: ${getReadableError(tenantError)}`)
  }

  if (!tenant) {
    throw new Error(
      `No existe un negocio visible con slug "${input.tenantSlug}". Comprueba public.tenants y public.tenant_memberships.`,
    )
  }

  const { data: membership, error: membershipError } = await supabase
    .from('tenant_memberships')
    .select('role')
    .eq('tenant_id', tenant.id)
    .eq('user_id', user.id)
    .eq('is_active', true)
    .maybeSingle<MembershipRow>()

  if (membershipError) {
    throw new Error(`No se pudo cargar la membresia del usuario: ${getReadableError(membershipError)}`)
  }

  if (!membership) {
    throw new Error(
      `El usuario ${user.email ?? user.id} no tiene membresia activa en ${tenant.name}. Aniadelo en public.tenant_memberships.`,
    )
  }

  const { data: venue, error: venueError } = await supabase
    .from('venues')
    .select('id, name')
    .eq('tenant_id', tenant.id)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .limit(1)
    .maybeSingle<VenueRow>()

  if (venueError) {
    throw new Error(`No se pudo cargar el local: ${getReadableError(venueError)}`)
  }

  if (!venue) {
    throw new Error(`El negocio ${tenant.name} no tiene ningun local activo en public.venues.`)
  }

  const { data: device, error: deviceError } = await supabase
    .from('devices')
    .upsert(
      {
        tenant_id: tenant.id,
        venue_id: venue.id,
        name: input.deviceName,
        is_active: true,
      },
      { onConflict: 'tenant_id,venue_id,name' },
    )
    .select('id, name')
    .single<DeviceRow>()

  if (deviceError) {
    throw new Error(`No se pudo registrar el dispositivo "${input.deviceName}": ${getReadableError(deviceError)}`)
  }

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

export async function loadCatalogFromSupabase(context: TenantContext): Promise<Catalog> {
  if (!supabase) {
    throw new Error('Supabase no esta configurado.')
  }

  const [{ data: categoryRows, error: categoriesError }, { data: productRows, error: productsError }] =
    await Promise.all([
      supabase
        .from('categories')
        .select('id, tenant_id, name, kind, icon, is_active, sort_order')
        .eq('tenant_id', context.tenantId)
        .order('sort_order', { ascending: true }),
      supabase
        .from('products')
        .select(
          `
          id,
          tenant_id,
          category_id,
          name,
          description,
          kind,
          sale_formats,
          can_sell_standalone,
          can_use_as_mixer,
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

  if (productsError) {
    throw productsError
  }

  return {
    categories: ((categoryRows ?? []) as CategoryRow[]).map(mapCategory),
    products: ((productRows ?? []) as ProductRow[]).map(mapProduct),
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
    const { error } = await supabase.from('cash_sessions').upsert({
      id: session.id,
      tenant_id: session.tenantId,
      venue_id: session.venueId,
      device_id: session.deviceId,
      opened_by: session.userId,
      opened_at: session.openedAt,
      opening_float_cents: session.openingFloatCents,
      status: 'open',
      sync_source: 'offline_first',
    })

    if (error) {
      throw error
    }

    return
  }

  if (event.kind === 'sale_created') {
    const { lines, payment, sale, ticket } = event.payload
    const { error: ticketError } = await supabase.from('tickets').upsert({
      id: ticket.id,
      tenant_id: ticket.tenantId,
      cash_session_id: ticket.cashSessionId,
      venue_id: ticket.venueId,
      device_id: ticket.deviceId,
      user_id: ticket.userId,
      status: 'paid',
      subtotal_cents: ticket.totalCents,
      total_cents: ticket.totalCents,
      local_created_at: ticket.createdAt,
      created_at: ticket.createdAt,
    })

    if (ticketError) {
      throw ticketError
    }

    const { error: linesError } = await supabase.from('ticket_lines').upsert(
      lines.map((line) => ({
        id: line.id,
        ticket_id: line.ticketId,
        tenant_id: line.tenantId,
        product_id: line.productId,
        variant_id: line.variantId,
        product_name: line.productName,
        variant_name: line.variantName,
        quantity: line.quantity,
        unit_price_cents: line.unitPriceCents,
        line_total_cents: line.lineTotalCents,
        modifiers: line.modifiers,
      })),
    )

    if (linesError) {
      throw linesError
    }

    const { error: saleError } = await supabase.from('sales').upsert({
      id: sale.id,
      tenant_id: sale.tenantId,
      ticket_id: sale.ticketId,
      cash_session_id: sale.cashSessionId,
      venue_id: sale.venueId,
      device_id: sale.deviceId,
      user_id: sale.userId,
      total_cents: sale.totalCents,
      payment_method: sale.paymentMethod,
      local_created_at: sale.createdAt,
      created_at: sale.createdAt,
    })

    if (saleError) {
      throw saleError
    }

    const { error: paymentError } = await supabase.from('sale_payments').upsert({
      id: payment.id,
      sale_id: payment.saleId,
      tenant_id: payment.tenantId,
      method: payment.method,
      amount_cents: payment.amountCents,
      received_cents: payment.receivedCents,
      change_cents: payment.changeCents,
    })

    if (paymentError) {
      throw paymentError
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

  if (error) {
    throw error
  }
}
