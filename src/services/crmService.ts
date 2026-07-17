import { supabase } from '../lib/supabase'
import { validateDiscountDefinition } from '../lib/discounts'
import type { ParsedCatalogTransfer } from '../lib/catalogTransfer'
import { normalizeText } from '../lib/format'
import { PRODUCT_IMAGE_BUCKET, resizeProductImageToWebp } from '../lib/productImages'
import type { RevoImportProduct } from '../lib/revoImport'
import { isValidTaxRate } from '../lib/tax'
import type {
  CatalogKind,
  CategoryCreateInput,
  CrmDevice,
  CrmPosUser,
  CrmSalesReportAggregate,
  CrmSalesReports,
  CrmStats,
  CrmVenue,
  DeviceMode,
  Discount,
  DiscountCreateInput,
  HistoricalPaymentMethod,
  PaymentMethod,
  ProductCreateInput,
  SaleFormatDefinition,
  SaleFormat,
  TenantContext,
} from '../types'

type SaleStatsRow = {
  id: string
  payment_method: HistoricalPaymentMethod | null
  total_cents: number
}

type TicketLineStatsRow = {
  product_name: string
  quantity: number
  line_total_cents: number
}

type TicketWithLinesStatsRow = {
  id: string
  total_cents: number
  discount_id: string | null
  discount_name: string | null
  discount_amount_cents: number | null
  ticket_lines: TicketLineStatsRow[] | null
}

type SalesReportLineRow = {
  id: string
  line_total_cents: number
  tax_amount_cents: number | null
  tax_rate: number | null
  taxable_base_cents: number | null
  modifiers: Array<{
    name?: string
    priceCents?: number
    price_cents?: number
  }> | null
  product_id: string | null
  product_name: string
  quantity: number
  unit_price_cents: number
  variant_name: string
}

type SalesReportTicketRow = {
  id: string
  local_created_at: string
  sales: Array<{ payment_method: HistoricalPaymentMethod | null }> | null
  status: 'paid' | 'void'
  subtotal_cents: number
  discount_id: string | null
  discount_name: string | null
  discount_type: 'percentage' | 'fixed' | 'manual' | null
  discount_value_type: 'percentage' | 'fixed' | null
  discount_value: number | string | null
  discount_amount_cents: number | null
  ticket_lines: SalesReportLineRow[] | null
  total_cents: number
}

type SalesReportProductRow = {
  category_id: string
  id: string
}

type SalesReportCategoryRow = {
  id: string
  name: string
}

type MutableSalesReportAggregate = CrmSalesReportAggregate & {
  ticketIds: Set<string>
}

type OpenCashSessionRow = {
  id: string
  venue_id: string
  device_id: string
  opened_at: string
  opening_float_cents: number
}

type OpenCashSessionSaleRow = {
  cash_session_id: string
  payment_method: HistoricalPaymentMethod | null
  total_cents: number
}

type NameRow = {
  id: string
  name: string
}

type ProductSaleFormatsRow = {
  id: string
  sale_formats: SaleFormat[] | null
}

type ImportCategoryRow = {
  id: string
  name: string
  kind: CatalogKind
  sort_order: number
}

type ImportVariantRow = {
  id: string
  name: string
}

type ImportProductRow = {
  id: string
  category_id: string
  name: string
  sort_order: number
  product_variants: ImportVariantRow[] | null
}

export type CatalogImportResult = {
  categoriesCreated: number
  categoriesUpdated: number
  productsCreated: number
  productsUpdated: number
  variantsCreated: number
  variantsUpdated: number
}

export type CatalogBackupImportResult = CatalogImportResult & {
  saleFormatsCreated: number
  saleFormatsUpdated: number
  modifierGroupsCreated: number
  modifierGroupsUpdated: number
  modifiersCreated: number
  modifiersUpdated: number
  imagesUploaded: number
}

export type CrmAccessData = {
  venues: CrmVenue[]
  devices: CrmDevice[]
  users: CrmPosUser[]
}

export type CrmPlan = {
  limits: {
    devices: number
    venues: number
  }
  usage: {
    devices: number
    venues: number
  }
}

function requireSupabase() {
  if (!supabase) {
    throw new Error('Supabase no esta configurado.')
  }

  return supabase
}

function getMonthStartIso() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
}

function getImportKey(value: string) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, ' ').trim()
}

function createSaleFormatKey(value: string) {
  return getImportKey(value).replace(/\s+/g, '_')
}

export async function loadCrmAccessData(context: TenantContext): Promise<CrmAccessData> {
  const client = requireSupabase()
  const [{ data: venueRows, error: venuesError }, { data: deviceRows, error: devicesError }, usersResult] =
    await Promise.all([
      client
        .from('venues')
        .select('id, name, sort_order, is_active, tables_enabled, default_tax_rate')
        .eq('tenant_id', context.tenantId)
        .order('sort_order'),
      client
        .from('devices')
        .select('id, venue_id, name, is_active, device_mode, default_cash_register_id')
        .eq('tenant_id', context.tenantId)
        .order('name'),
      client.functions.invoke<{ users: CrmPosUser[] }>('manage-pos-users', {
        body: { action: 'list', tenantId: context.tenantId },
      }),
    ])

  if (venuesError || devicesError || usersResult.error) {
    throw venuesError ?? devicesError ?? usersResult.error
  }

  const functionError = (usersResult.data as { error?: string } | null)?.error
  if (functionError) {
    throw new Error(functionError)
  }

  return {
    venues: (venueRows ?? []).map((venue) => ({
      id: venue.id as string,
      name: venue.name as string,
      sortOrder: venue.sort_order as number,
      isActive: venue.is_active as boolean,
      tablesEnabled: venue.tables_enabled as boolean,
      defaultTaxRate: Number(venue.default_tax_rate),
    })),
    devices: (deviceRows ?? []).map((device) => ({
      id: device.id as string,
      venueId: device.venue_id as string,
      name: device.name as string,
      isActive: device.is_active as boolean,
      deviceMode: device.device_mode as DeviceMode,
      defaultCashRegisterId: device.default_cash_register_id as string | null,
    })),
    users: usersResult.data?.users ?? [],
  }
}

export async function loadCrmPlan(context: TenantContext): Promise<CrmPlan> {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke<CrmPlan & { error?: string }>('manage-pos-users', {
    body: { action: 'tenant-plan', tenantId: context.tenantId },
  })

  if (error || data?.error) {
    throw new Error(data?.error ?? error?.message ?? 'No se pudo cargar la información del plan.')
  }
  if (!data?.limits || !data.usage) {
    throw new Error('La función no devolvió la información del plan.')
  }
  return data
}

export async function loadCrmVenues(context: TenantContext): Promise<CrmVenue[]> {
  const client = requireSupabase()
  const { data, error } = await client
    .from('venues')
    .select('id, name, sort_order, is_active, tables_enabled, default_tax_rate')
    .eq('tenant_id', context.tenantId)
    .order('sort_order')

  if (error) {
    throw error
  }

  return (data ?? []).map((venue) => ({
    id: venue.id as string,
    name: venue.name as string,
    sortOrder: venue.sort_order as number,
    isActive: venue.is_active as boolean,
    tablesEnabled: venue.tables_enabled as boolean,
    defaultTaxRate: Number(venue.default_tax_rate),
  }))
}

export async function createCrmVenue(context: TenantContext, name: string) {
  const client = requireSupabase()
  const { error } = await client.from('venues').insert({
    tenant_id: context.tenantId,
    name: name.trim(),
    sort_order: 0,
    is_active: true,
  })

  if (error) {
    throw error
  }
}

export async function updateCrmVenueDefaultTaxRate(
  context: TenantContext,
  venueId: string,
  defaultTaxRate: number,
) {
  if (!isValidTaxRate(defaultTaxRate)) {
    throw new Error('El tipo de IVA debe estar entre 0 y 100.')
  }

  const { error } = await requireSupabase()
    .from('venues')
    .update({ default_tax_rate: defaultTaxRate })
    .eq('tenant_id', context.tenantId)
    .eq('id', venueId)

  if (error) {
    throw error
  }
}

export async function createCrmDevice(context: TenantContext, venueId: string, name: string, deviceMode: DeviceMode) {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke<{
    credentials?: { email: string; password: string }
    error?: string
  }>('manage-pos-users', {
    body: {
      action: 'create-device-with-user',
      deviceMode,
      deviceName: name.trim(),
      tenantId: context.tenantId,
      venueId,
    },
  })

  if (error || data?.error || !data?.credentials) {
    throw new Error(data?.error ?? error?.message ?? 'No se pudieron crear el dispositivo y su usuario.')
  }
  return data.credentials
}

export async function setCrmPosUserActive(context: TenantContext, userId: string, isActive: boolean) {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke<{ error?: string }>('manage-pos-users', {
    body: { action: 'set-active', tenantId: context.tenantId, userId, isActive },
  })

  if (error) {
    throw error
  }

  if (data?.error) {
    throw new Error(data.error)
  }
}

export async function releaseCrmPosUserLogin(context: TenantContext, userId: string) {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke<{ error?: string }>('manage-pos-users', {
    body: { action: 'release-login', tenantId: context.tenantId, userId },
  })

  if (error) {
    throw error
  }

  if (data?.error) {
    throw new Error(data.error)
  }
}

export async function updateCrmPosUser(
  context: TenantContext,
  userId: string,
  input: { deviceId: string; deviceMode: DeviceMode; email: string; fullName: string; password?: string },
) {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke<{ error?: string }>('manage-pos-users', {
    body: { action: 'update', tenantId: context.tenantId, userId, ...input },
  })

  if (error) {
    throw error
  }

  if (data?.error) {
    throw new Error(data.error)
  }
}

export async function deleteCrmPosUser(context: TenantContext, userId: string) {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke<{ error?: string }>('manage-pos-users', {
    body: { action: 'delete', tenantId: context.tenantId, userId },
  })

  if (error) {
    throw error
  }

  if (data?.error) {
    throw new Error(data.error)
  }
}

function createProductImagePath(context: TenantContext) {
  const imageId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`

  return `${context.tenantId}/products/${imageId}.webp`
}

export async function uploadProductImage(context: TenantContext, file: File, fillColor?: string) {
  const client = requireSupabase()
  const imageBlob = await resizeProductImageToWebp(file, fillColor)
  const imagePath = createProductImagePath(context)
  const { error } = await client.storage.from(PRODUCT_IMAGE_BUCKET).upload(imagePath, imageBlob, {
    cacheControl: '31536000',
    contentType: 'image/webp',
    upsert: false,
  })

  if (error) {
    throw error
  }

  return imagePath
}

export async function deleteProductImage(context: TenantContext, imagePath: string | null | undefined) {
  if (!imagePath || !imagePath.startsWith(`${context.tenantId}/`)) {
    return
  }

  const client = requireSupabase()
  const { data: references, error: referencesError } = await client
    .from('products')
    .select('id')
    .eq('tenant_id', context.tenantId)
    .eq('image_path', imagePath)
    .limit(1)

  if (referencesError) {
    throw referencesError
  }

  if (references?.length) {
    return
  }

  const { error } = await client.storage.from(PRODUCT_IMAGE_BUCKET).remove([imagePath])

  if (error) {
    throw error
  }
}

export async function createCategory(context: TenantContext, input: CategoryCreateInput) {
  const client = requireSupabase()
  const { error } = await client.from('categories').insert({
    tenant_id: context.tenantId,
    name: input.name,
    kind: input.kind,
    icon: input.kind,
    sort_order: input.sortOrder,
    is_active: true,
  })

  if (error) {
    throw error
  }
}

export async function updateCategory(
  context: TenantContext,
  categoryId: string,
  input: Partial<CategoryCreateInput> & { isActive?: boolean },
) {
  const client = requireSupabase()
  const { error } = await client
    .from('categories')
    .update({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.kind !== undefined ? { kind: input.kind, icon: input.kind } : {}),
      ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
      ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
    })
    .eq('tenant_id', context.tenantId)
    .eq('id', categoryId)

  if (error) {
    throw error
  }
}

export async function deleteCategory(context: TenantContext, categoryId: string) {
  const client = requireSupabase()
  const { error } = await client.from('categories').delete().eq('tenant_id', context.tenantId).eq('id', categoryId)

  if (error) {
    throw error
  }
}

export async function createSaleFormat(context: TenantContext, input: { label: string; sortOrder: number }) {
  const client = requireSupabase()
  const label = input.label.trim()
  const key = createSaleFormatKey(label)

  if (!label || !key) {
    throw new Error('Indica un nombre valido para el formato.')
  }

  if (key === 'all' || key === 'top') {
    throw new Error('Ese nombre esta reservado para pestanas del catalogo.')
  }

  const { error } = await client.from('sale_formats').insert({
    tenant_id: context.tenantId,
    key,
    label,
    sort_order: input.sortOrder,
    is_active: true,
  })

  if (error) {
    throw error
  }
}

export async function updateSaleFormat(
  context: TenantContext,
  saleFormat: SaleFormatDefinition,
  input: { isActive?: boolean; label?: string; sortOrder?: number },
) {
  const client = requireSupabase()
  const nextLabel = input.label?.trim()
  const { error } = await client
    .from('sale_formats')
    .update({
      ...(nextLabel !== undefined ? { label: nextLabel || saleFormat.label } : {}),
      ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
      ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
    })
    .eq('tenant_id', context.tenantId)
    .eq('key', saleFormat.key)

  if (error) {
    throw error
  }
}

export async function deleteSaleFormat(context: TenantContext, saleFormat: SaleFormatDefinition) {
  const client = requireSupabase()
  const { data: productRows, error: productsError } = await client
    .from('products')
    .select('id, sale_formats')
    .eq('tenant_id', context.tenantId)
    .contains('sale_formats', [saleFormat.key])

  if (productsError) {
    throw productsError
  }

  for (const product of (productRows ?? []) as ProductSaleFormatsRow[]) {
    const nextSaleFormats = (product.sale_formats ?? []).filter((format) => format !== saleFormat.key)
    const { error } = await client
      .from('products')
      .update({ sale_formats: nextSaleFormats })
      .eq('tenant_id', context.tenantId)
      .eq('id', product.id)

    if (error) {
      throw error
    }
  }

  const { error } = await client
    .from('sale_formats')
    .delete()
    .eq('tenant_id', context.tenantId)
    .eq('key', saleFormat.key)

  if (error) {
    throw error
  }
}

export async function createProductWithVariant(context: TenantContext, input: ProductCreateInput) {
  const client = requireSupabase()

  if (!input.variants.length) {
    throw new Error('Selecciona al menos un formato de venta con su precio.')
  }

  const { data: product, error: productError } = await client
    .from('products')
    .insert({
      tenant_id: context.tenantId,
      venue_id: input.venueId,
      category_id: input.categoryId,
      name: input.name,
      description: input.description || null,
      image_path: input.imagePath ?? null,
      kind: input.kind,
      sale_formats: input.saleFormats,
      can_sell_standalone: input.canSellStandalone,
      can_use_as_mixer: input.canUseAsMixer,
      is_featured: input.isFeatured,
      mixer_supplement_cents: input.canUseAsMixer ? input.mixerSupplementCents : 0,
      tax_rate: input.taxRate,
      is_active: true,
      sort_order: 0,
    })
    .select('id')
    .single<{ id: string }>()

  if (productError) {
    throw productError
  }

  const { error: variantError } = await client.from('product_variants').insert(
    input.variants.map((variant, index) => ({
      tenant_id: context.tenantId,
      product_id: product.id,
      name: variant.name,
      price_cents: variant.priceCents,
      is_default: index === 0,
      sort_order: index * 10,
    })),
  )

  if (variantError) {
    throw variantError
  }

}

export async function updateProduct(
  context: TenantContext,
  productId: string,
  input: {
    categoryId?: string
    description?: string
    imagePath?: string | null
    isActive?: boolean
    isFeatured?: boolean
    kind?: CatalogKind
    name?: string
    saleFormats?: ProductCreateInput['saleFormats']
    canSellStandalone?: boolean
    canUseAsMixer?: boolean
    mixerSupplementCents?: number
    taxRate?: number | null
  },
) {
  const client = requireSupabase()
  const { error } = await client
    .from('products')
    .update({
      ...(input.categoryId !== undefined ? { category_id: input.categoryId } : {}),
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.imagePath !== undefined ? { image_path: input.imagePath } : {}),
      ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
      ...(input.isFeatured !== undefined ? { is_featured: input.isFeatured } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.saleFormats !== undefined ? { sale_formats: input.saleFormats } : {}),
      ...(input.canSellStandalone !== undefined ? { can_sell_standalone: input.canSellStandalone } : {}),
      ...(input.canUseAsMixer !== undefined ? { can_use_as_mixer: input.canUseAsMixer } : {}),
      ...(input.mixerSupplementCents !== undefined ? { mixer_supplement_cents: input.mixerSupplementCents } : {}),
      ...(input.taxRate !== undefined ? { tax_rate: input.taxRate } : {}),
    })
    .eq('tenant_id', context.tenantId)
    .eq('id', productId)

  if (error) {
    throw error
  }

}

export async function deleteProduct(context: TenantContext, productId: string) {
  const client = requireSupabase()
  const { error } = await client.from('products').delete().eq('tenant_id', context.tenantId).eq('id', productId)

  if (error) {
    throw error
  }
}

export async function updateVariant(
  context: TenantContext,
  variantId: string,
  input: {
    isDefault?: boolean
    name?: string
    priceCents?: number
    sku?: string | null
  },
) {
  const client = requireSupabase()
  const { error } = await client
    .from('product_variants')
    .update({
      ...(input.isDefault !== undefined ? { is_default: input.isDefault } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.priceCents !== undefined ? { price_cents: input.priceCents } : {}),
      ...(input.sku !== undefined ? { sku: input.sku } : {}),
    })
    .eq('tenant_id', context.tenantId)
    .eq('id', variantId)

  if (error) {
    throw error
  }
}

export async function createVariant(
  context: TenantContext,
  productId: string,
  input: {
    isDefault?: boolean
    name: string
    priceCents: number
  },
) {
  const client = requireSupabase()
  const { error } = await client.from('product_variants').insert({
    tenant_id: context.tenantId,
    product_id: productId,
    name: input.name,
    price_cents: input.priceCents,
    is_default: input.isDefault ?? false,
    sort_order: 10,
  })

  if (error) {
    throw error
  }
}

export async function deleteVariant(context: TenantContext, variantId: string) {
  const client = requireSupabase()
  const { error } = await client
    .from('product_variants')
    .delete()
    .eq('tenant_id', context.tenantId)
    .eq('id', variantId)

  if (error) {
    throw error
  }
}

type BackupVariantRow = {
  id: string
  name: string
}

type BackupModifierRow = {
  id: string
  name: string
}

type BackupModifierGroupRow = {
  id: string
  name: string
  modifiers: BackupModifierRow[] | null
}

type BackupProductRow = {
  id: string
  category_id: string
  name: string
  image_path: string | null
  product_variants: BackupVariantRow[] | null
  modifier_groups: BackupModifierGroupRow[] | null
}

function getBackupImagePath(context: TenantContext, sourceProductId: string) {
  const safeId = sourceProductId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'product'
  return `${context.tenantId}/products/backup-${safeId}.webp`
}

/**
 * Merges a complete CRM catalog backup into the selected venue. Records are
 * matched by their source id first and by normalized name second, which makes
 * re-importing the same ZIP idempotent without coupling backups to a tenant.
 */
export async function importCatalogBackup(
  context: TenantContext,
  transfer: ParsedCatalogTransfer,
  venueId: string,
): Promise<CatalogBackupImportResult> {
  const client = requireSupabase()
  const result: CatalogBackupImportResult = {
    categoriesCreated: 0,
    categoriesUpdated: 0,
    productsCreated: 0,
    productsUpdated: 0,
    variantsCreated: 0,
    variantsUpdated: 0,
    saleFormatsCreated: 0,
    saleFormatsUpdated: 0,
    modifierGroupsCreated: 0,
    modifierGroupsUpdated: 0,
    modifiersCreated: 0,
    modifiersUpdated: 0,
    imagesUploaded: 0,
  }
  const [categoriesResult, saleFormatsResult, productsResult] = await Promise.all([
    client
      .from('categories')
      .select('id, name')
      .eq('tenant_id', context.tenantId),
    client
      .from('sale_formats')
      .select('key')
      .eq('tenant_id', context.tenantId),
    client
      .from('products')
      .select(`
        id,
        category_id,
        name,
        image_path,
        product_variants (id, name),
        modifier_groups (id, name, modifiers (id, name))
      `)
      .eq('tenant_id', context.tenantId)
      .eq('venue_id', venueId),
  ])

  if (categoriesResult.error || saleFormatsResult.error || productsResult.error) {
    throw categoriesResult.error ?? saleFormatsResult.error ?? productsResult.error
  }

  const existingSaleFormats = new Set((saleFormatsResult.data ?? []).map((row) => row.key as string))
  if (transfer.manifest.saleFormats.length) {
    const { error } = await client.from('sale_formats').upsert(
      transfer.manifest.saleFormats.map((saleFormat) => ({
        tenant_id: context.tenantId,
        key: saleFormat.key,
        label: saleFormat.label,
        sort_order: saleFormat.sortOrder,
        is_active: saleFormat.isActive,
      })),
      { onConflict: 'tenant_id,key' },
    )
    if (error) {
      throw error
    }
    for (const saleFormat of transfer.manifest.saleFormats) {
      if (existingSaleFormats.has(saleFormat.key)) {
        result.saleFormatsUpdated += 1
      } else {
        result.saleFormatsCreated += 1
      }
    }
  }

  const categoryRows = (categoriesResult.data ?? []) as Array<{ id: string; name: string }>
  const categoryById = new Map(categoryRows.map((category) => [category.id, category]))
  const categoryByName = new Map(categoryRows.map((category) => [getImportKey(category.name), category]))
  const categoryIdMap = new Map<string, string>()

  for (const category of transfer.manifest.categories) {
    const existing = categoryById.get(category.id) ?? categoryByName.get(getImportKey(category.name))
    if (existing) {
      const { error } = await client
        .from('categories')
        .update({
          name: category.name,
          kind: category.kind,
          icon: category.icon || category.kind,
          sort_order: category.sortOrder,
          is_active: category.isActive,
        })
        .eq('tenant_id', context.tenantId)
        .eq('id', existing.id)
      if (error) {
        throw error
      }
      categoryIdMap.set(category.id, existing.id)
      result.categoriesUpdated += 1
      continue
    }

    const { data, error } = await client
      .from('categories')
      .insert({
        tenant_id: context.tenantId,
        name: category.name,
        kind: category.kind,
        icon: category.icon || category.kind,
        sort_order: category.sortOrder,
        is_active: category.isActive,
      })
      .select('id, name')
      .single<{ id: string; name: string }>()
    if (error) {
      throw error
    }
    categoryByName.set(getImportKey(data.name), data)
    categoryIdMap.set(category.id, data.id)
    result.categoriesCreated += 1
  }

  const productRows = (productsResult.data ?? []) as BackupProductRow[]
  const productById = new Map(productRows.map((product) => [product.id, product]))
  const productByName = new Map(
    productRows.map((product) => [`${product.category_id}:${getImportKey(product.name)}`, product]),
  )

  for (const product of transfer.manifest.products) {
    const categoryId = categoryIdMap.get(product.categoryId)
    if (!categoryId) {
      throw new Error(`No se ha podido resolver la categoria de ${product.name}.`)
    }
    const existing = productById.get(product.id) ?? productByName.get(`${categoryId}:${getImportKey(product.name)}`)
    const previousImagePath = existing?.image_path ?? null
    let imagePath: string | null = null

    if (product.imageFile) {
      const image = transfer.images.get(product.imageFile)
      if (!image) {
        throw new Error(`No se ha encontrado la imagen de ${product.name}.`)
      }
      imagePath = getBackupImagePath(context, product.id)
      const imageBuffer = image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength) as ArrayBuffer
      const { error } = await client.storage
        .from(PRODUCT_IMAGE_BUCKET)
        .upload(imagePath, new Blob([imageBuffer], { type: 'image/webp' }), {
          cacheControl: '31536000',
          contentType: 'image/webp',
          upsert: true,
        })
      if (error) {
        throw new Error(`No se ha podido importar la imagen de ${product.name}: ${error.message}`)
      }
      result.imagesUploaded += 1
    }

    const productPayload = {
      category_id: categoryId,
      name: product.name,
      description: product.description,
      image_path: imagePath,
      kind: product.kind,
      sale_formats: product.saleFormats,
      can_sell_standalone: product.canSellStandalone,
      can_use_as_mixer: product.canUseAsMixer,
      is_featured: product.isFeatured,
      mixer_supplement_cents: product.canUseAsMixer ? product.mixerSupplementCents : 0,
      tax_rate: product.taxRate,
      is_active: product.isActive,
      sort_order: product.sortOrder,
    }
    let savedProduct: BackupProductRow

    if (existing) {
      const { error } = await client
        .from('products')
        .update(productPayload)
        .eq('tenant_id', context.tenantId)
        .eq('id', existing.id)
      if (error) {
        throw error
      }
      savedProduct = existing
      result.productsUpdated += 1
    } else {
      const { data, error } = await client
        .from('products')
        .insert({
          tenant_id: context.tenantId,
          venue_id: venueId,
          ...productPayload,
        })
        .select('id, category_id, name, image_path')
        .single<Omit<BackupProductRow, 'product_variants' | 'modifier_groups'>>()
      if (error) {
        throw error
      }
      savedProduct = { ...data, product_variants: [], modifier_groups: [] }
      productByName.set(`${categoryId}:${getImportKey(product.name)}`, savedProduct)
      result.productsCreated += 1
    }

    if (previousImagePath && previousImagePath !== imagePath) {
      await deleteProductImage(context, previousImagePath).catch(() => undefined)
    }

    const variants = savedProduct.product_variants ?? []
    const variantById = new Map(variants.map((variant) => [variant.id, variant]))
    const variantByName = new Map(variants.map((variant) => [getImportKey(variant.name), variant]))
    for (const variant of product.variants) {
      const existingVariant = variantById.get(variant.id) ?? variantByName.get(getImportKey(variant.name))
      const payload = {
        name: variant.name,
        price_cents: variant.priceCents,
        sku: variant.sku,
        is_default: variant.isDefault,
        sort_order: variant.sortOrder,
      }
      if (existingVariant) {
        const { error } = await client
          .from('product_variants')
          .update(payload)
          .eq('tenant_id', context.tenantId)
          .eq('id', existingVariant.id)
        if (error) {
          throw error
        }
        result.variantsUpdated += 1
      } else {
        const { error } = await client.from('product_variants').insert({
          tenant_id: context.tenantId,
          product_id: savedProduct.id,
          ...payload,
        })
        if (error) {
          throw error
        }
        result.variantsCreated += 1
      }
    }

    const groups = savedProduct.modifier_groups ?? []
    const groupById = new Map(groups.map((group) => [group.id, group]))
    const groupByName = new Map(groups.map((group) => [getImportKey(group.name), group]))
    for (const group of product.modifierGroups) {
      const existingGroup = groupById.get(group.id) ?? groupByName.get(getImportKey(group.name))
      const groupPayload = {
        name: group.name,
        min_select: group.minSelect,
        max_select: group.maxSelect,
        sort_order: group.sortOrder,
      }
      let savedGroup: BackupModifierGroupRow
      if (existingGroup) {
        const { error } = await client
          .from('modifier_groups')
          .update(groupPayload)
          .eq('tenant_id', context.tenantId)
          .eq('id', existingGroup.id)
        if (error) {
          throw error
        }
        savedGroup = existingGroup
        result.modifierGroupsUpdated += 1
      } else {
        const { data, error } = await client
          .from('modifier_groups')
          .insert({ tenant_id: context.tenantId, product_id: savedProduct.id, ...groupPayload })
          .select('id, name')
          .single<{ id: string; name: string }>()
        if (error) {
          throw error
        }
        savedGroup = { ...data, modifiers: [] }
        result.modifierGroupsCreated += 1
      }

      const modifiers = savedGroup.modifiers ?? []
      const modifierById = new Map(modifiers.map((modifier) => [modifier.id, modifier]))
      const modifierByName = new Map(modifiers.map((modifier) => [getImportKey(modifier.name), modifier]))
      for (const modifier of group.modifiers) {
        const existingModifier = modifierById.get(modifier.id) ?? modifierByName.get(getImportKey(modifier.name))
        const modifierPayload = {
          name: modifier.name,
          price_cents: modifier.priceCents,
          sort_order: modifier.sortOrder,
        }
        if (existingModifier) {
          const { error } = await client
            .from('modifiers')
            .update(modifierPayload)
            .eq('tenant_id', context.tenantId)
            .eq('id', existingModifier.id)
          if (error) {
            throw error
          }
          result.modifiersUpdated += 1
        } else {
          const { error } = await client.from('modifiers').insert({
            tenant_id: context.tenantId,
            group_id: savedGroup.id,
            ...modifierPayload,
          })
          if (error) {
            throw error
          }
          result.modifiersCreated += 1
        }
      }
    }
  }

  return result
}

export async function importRevoCatalogProducts(
  context: TenantContext,
  products: RevoImportProduct[],
  venueId: string,
): Promise<CatalogImportResult> {
  const client = requireSupabase()
  const result: CatalogImportResult = {
    categoriesCreated: 0,
    categoriesUpdated: 0,
    productsCreated: 0,
    productsUpdated: 0,
    variantsCreated: 0,
    variantsUpdated: 0,
  }
  const [{ data: categoryRows, error: categoriesError }, { data: productRows, error: productsError }] =
    await Promise.all([
      client
        .from('categories')
        .select('id, name, kind, sort_order')
        .eq('tenant_id', context.tenantId)
        .order('sort_order', { ascending: true }),
      client
        .from('products')
        .select(
          `
          id,
          category_id,
          name,
          sort_order,
          product_variants (
            id,
            name
          )
        `,
        )
        .eq('tenant_id', context.tenantId)
        .eq('venue_id', venueId)
        .order('sort_order', { ascending: true }),
    ])

  if (categoriesError) {
    throw categoriesError
  }

  if (productsError) {
    throw productsError
  }

  const categoriesByKey = new Map(
    ((categoryRows ?? []) as ImportCategoryRow[]).map((category) => [getImportKey(category.name), category]),
  )
  const productsByKey = new Map(
    ((productRows ?? []) as ImportProductRow[]).map((product) => [
      `${product.category_id}:${getImportKey(product.name)}`,
      product,
    ]),
  )
  let nextCategorySortOrder = Math.max(0, ...((categoryRows ?? []) as ImportCategoryRow[]).map((row) => row.sort_order)) + 1
  let nextProductSortOrder = Math.max(0, ...((productRows ?? []) as ImportProductRow[]).map((row) => row.sort_order)) + 1

  async function ensureCategory(product: RevoImportProduct) {
    const categoryKey = getImportKey(product.categoryName)
    const existingCategory = categoriesByKey.get(categoryKey)

    if (existingCategory) {
      if (existingCategory.kind !== product.categoryKind) {
        const { error } = await client
          .from('categories')
          .update({
            icon: product.categoryKind,
            kind: product.categoryKind,
          })
          .eq('tenant_id', context.tenantId)
          .eq('id', existingCategory.id)

        if (error) {
          throw error
        }

        existingCategory.kind = product.categoryKind
        result.categoriesUpdated += 1
      }

      return existingCategory
    }

    const { data: category, error } = await client
      .from('categories')
      .insert({
        tenant_id: context.tenantId,
        name: product.categoryName,
        kind: product.categoryKind,
        icon: product.categoryKind,
        sort_order: nextCategorySortOrder,
        is_active: true,
      })
      .select('id, name, kind, sort_order')
      .single<ImportCategoryRow>()

    if (error) {
      throw error
    }

    nextCategorySortOrder += 1
    categoriesByKey.set(categoryKey, category)
    result.categoriesCreated += 1
    return category
  }

  for (const product of products) {
    const category = await ensureCategory(product)
    const productKey = `${category.id}:${getImportKey(product.name)}`
    const existingProduct = productsByKey.get(productKey)

    if (existingProduct) {
      const { error } = await client
        .from('products')
        .update({
          category_id: category.id,
          name: product.name,
          kind: product.kind,
          sale_formats: product.saleFormats as SaleFormat[],
          can_sell_standalone: product.canSellStandalone,
          can_use_as_mixer: product.canUseAsMixer,
          mixer_supplement_cents: product.canUseAsMixer ? product.mixerSupplementCents : 0,
          is_active: product.active,
        })
        .eq('tenant_id', context.tenantId)
        .eq('id', existingProduct.id)

      if (error) {
        throw error
      }

      result.productsUpdated += 1
    } else {
      const { data: createdProduct, error } = await client
        .from('products')
        .insert({
          tenant_id: context.tenantId,
          venue_id: venueId,
          category_id: category.id,
          name: product.name,
          description: null,
          kind: product.kind,
          sale_formats: product.saleFormats as SaleFormat[],
          can_sell_standalone: product.canSellStandalone,
          can_use_as_mixer: product.canUseAsMixer,
          mixer_supplement_cents: product.canUseAsMixer ? product.mixerSupplementCents : 0,
          is_active: product.active,
          sort_order: nextProductSortOrder,
        })
        .select('id, category_id, name, sort_order')
        .single<Omit<ImportProductRow, 'product_variants'>>()

      if (error) {
        throw error
      }

      nextProductSortOrder += 1
      result.productsCreated += 1
      productsByKey.set(productKey, {
        ...createdProduct,
        product_variants: [],
      })
    }

    const savedProduct = productsByKey.get(productKey)

    if (!savedProduct) {
      continue
    }

    if (product.variants.length) {
      const { error } = await client
        .from('product_variants')
        .update({ is_default: false })
        .eq('tenant_id', context.tenantId)
        .eq('product_id', savedProduct.id)

      if (error) {
        throw error
      }
    }

    const variantsByKey = new Map(
      (savedProduct.product_variants ?? []).map((variant) => [getImportKey(variant.name), variant]),
    )

    for (const [variantIndex, variant] of product.variants.entries()) {
      const variantKey = getImportKey(variant.name)
      const existingVariant = variantsByKey.get(variantKey)
      const payload = {
        name: variant.name,
        price_cents: variant.priceCents,
        is_default: variantIndex === 0,
        sort_order: variant.sortOrder,
      }

      if (existingVariant) {
        const { error } = await client
          .from('product_variants')
          .update(payload)
          .eq('tenant_id', context.tenantId)
          .eq('id', existingVariant.id)

        if (error) {
          throw error
        }

        result.variantsUpdated += 1
      } else {
        const { data: createdVariant, error } = await client
          .from('product_variants')
          .insert({
            tenant_id: context.tenantId,
            product_id: savedProduct.id,
            ...payload,
          })
          .select('id, name')
          .single<ImportVariantRow>()

        if (error) {
          throw error
        }

        variantsByKey.set(variantKey, createdVariant)
        savedProduct.product_variants = [...(savedProduct.product_variants ?? []), createdVariant]
        result.variantsCreated += 1
      }
    }
  }

  return result
}

function addSalesReportLine(
  report: Map<string, MutableSalesReportAggregate>,
  id: string,
  label: string,
  ticketId: string,
  line: SalesReportLineRow,
) {
  const current = report.get(id) ?? {
    id,
    label,
    quantity: 0,
    ticketCount: 0,
    ticketIds: new Set<string>(),
    totalCents: 0,
  }

  current.quantity += line.quantity
  current.totalCents += line.line_total_cents
  current.ticketIds.add(ticketId)
  current.ticketCount = current.ticketIds.size
  report.set(id, current)
}

function finalizeSalesReport(report: Map<string, MutableSalesReportAggregate>): CrmSalesReportAggregate[] {
  return [...report.values()]
    .map((item) => ({
      id: item.id,
      label: item.label,
      quantity: item.quantity,
      ticketCount: item.ticketCount,
      totalCents: item.totalCents,
    }))
    .sort((a, b) => b.totalCents - a.totalCents || b.quantity - a.quantity || a.label.localeCompare(b.label, 'es'))
}

export async function loadCrmSalesReports(context: TenantContext, venueId?: string): Promise<CrmSalesReports> {
  const client = requireSupabase()
  let productsQuery = client
    .from('products')
    .select('id, category_id')
    .eq('tenant_id', context.tenantId)

  if (venueId) {
    productsQuery = productsQuery.eq('venue_id', venueId)
  }

  const ticketRowsPromise = (async () => {
    const rows: SalesReportTicketRow[] = []
    const batchSize = 1000
    let offset = 0

    while (true) {
      let ticketBatchQuery = client
        .from('tickets')
        .select(`
          id,
          status,
          subtotal_cents,
          discount_id,
          discount_name,
          discount_type,
          discount_value_type,
          discount_value,
          discount_amount_cents,
          total_cents,
          local_created_at,
          ticket_lines (
            id,
            product_id,
            product_name,
            variant_name,
            quantity,
            unit_price_cents,
            modifiers,
            line_total_cents,
            tax_rate,
            taxable_base_cents,
            tax_amount_cents
          ),
          sales (
            payment_method
          )
        `)
        .eq('tenant_id', context.tenantId)
        .order('local_created_at', { ascending: false })
        .range(offset, offset + batchSize - 1)

      if (venueId) {
        ticketBatchQuery = ticketBatchQuery.eq('venue_id', venueId)
      }

      const { data, error } = await ticketBatchQuery
      if (error) throw error

      const batch = (data ?? []) as SalesReportTicketRow[]
      rows.push(...batch)

      if (batch.length < batchSize) break
      offset += batchSize
    }

    return rows
  })()

  const [
    ticketRows,
    { data: productRows, error: productsError },
    { data: categoryRows, error: categoriesError },
  ] = await Promise.all([
    ticketRowsPromise,
    productsQuery,
    client.from('categories').select('id, name').eq('tenant_id', context.tenantId),
  ])

  if (productsError) throw productsError
  if (categoriesError) throw categoriesError

  const tickets = ticketRows
  const categoryIdByProductId = new Map(
    ((productRows ?? []) as SalesReportProductRow[]).map((product) => [product.id, product.category_id]),
  )
  const categoryNameById = new Map(
    ((categoryRows ?? []) as SalesReportCategoryRow[]).map((category) => [category.id, category.name]),
  )
  const byProduct = new Map<string, MutableSalesReportAggregate>()
  const byCategory = new Map<string, MutableSalesReportAggregate>()
  const byFormat = new Map<string, MutableSalesReportAggregate>()

  tickets.forEach((ticket) => {
    if (ticket.status !== 'paid') return

    ;(ticket.ticket_lines ?? []).forEach((line) => {
      const productId = line.product_id ?? `deleted:${normalizeText(line.product_name)}`
      const categoryId = line.product_id ? categoryIdByProductId.get(line.product_id) : undefined
      const categoryName = categoryId ? categoryNameById.get(categoryId) : undefined
      const formatName = line.variant_name.trim() || 'Sin formato'

      addSalesReportLine(byProduct, productId, line.product_name, ticket.id, line)
      addSalesReportLine(byCategory, categoryId ?? 'uncategorized', categoryName ?? 'Sin categoría', ticket.id, line)
      addSalesReportLine(byFormat, normalizeText(formatName) || 'sin-formato', formatName, ticket.id, line)
    })
  })

  return {
    byCategory: finalizeSalesReport(byCategory),
    byFormat: finalizeSalesReport(byFormat),
    byProduct: finalizeSalesReport(byProduct),
    tickets: tickets.map((ticket) => ({
      id: ticket.id,
      createdAt: ticket.local_created_at,
      lineCount: ticket.ticket_lines?.length ?? 0,
      lines: (ticket.ticket_lines ?? []).map((line) => {
        const categoryId = line.product_id ? categoryIdByProductId.get(line.product_id) ?? null : null

        return {
          categoryId,
          categoryName: categoryId ? categoryNameById.get(categoryId) ?? 'Sin categoría' : 'Sin categoría',
          id: line.id,
          lineTotalCents: line.line_total_cents,
          modifiers: (line.modifiers ?? []).map((modifier) => ({
            name: modifier.name?.trim() || 'Modificador',
            priceCents: modifier.priceCents ?? modifier.price_cents ?? 0,
          })),
          productId: line.product_id,
          productName: line.product_name,
          quantity: line.quantity,
          unitPriceCents: line.unit_price_cents,
          variantName: line.variant_name,
          fiscalSnapshot: line.tax_rate === null
            || line.taxable_base_cents === null
            || line.tax_amount_cents === null
            ? null
            : {
                taxRate: Number(line.tax_rate),
                taxableBaseCents: line.taxable_base_cents,
                taxAmountCents: line.tax_amount_cents,
                grossTotalCents: line.line_total_cents,
              },
        }
      }),
      discountAmountCents: ticket.discount_amount_cents ?? 0,
      discountId: ticket.discount_id,
      discountName: ticket.discount_name,
      discountType: ticket.discount_type,
      discountValue: ticket.discount_value === null ? null : ticket.discount_value_type === 'fixed'
        ? Math.round(Number(ticket.discount_value) * 100) : Number(ticket.discount_value),
      discountValueType: ticket.discount_value_type,
      paymentMethod: ticket.sales?.[0]?.payment_method ?? null,
      quantity: (ticket.ticket_lines ?? []).reduce((total, line) => total + line.quantity, 0),
      status: ticket.status,
      subtotalCents: ticket.subtotal_cents,
      totalCents: ticket.total_cents,
    })),
  }
}

export async function loadCrmStats(context: TenantContext, venueId?: string): Promise<CrmStats> {
  const client = requireSupabase()
  const monthStart = getMonthStartIso()
  let salesQuery = client
    .from('sales')
    .select('id, payment_method, total_cents')
    .eq('tenant_id', context.tenantId)
    .gte('created_at', monthStart)
  let ticketsQuery = client
    .from('tickets')
    .select('id, total_cents, discount_id, discount_name, discount_amount_cents, ticket_lines(product_name, quantity, line_total_cents)')
    .eq('tenant_id', context.tenantId)
    .eq('status', 'paid')
    .gte('created_at', monthStart)
  let openSessionsQuery = client
    .from('cash_sessions')
    .select('id, venue_id, device_id, opened_at, opening_float_cents')
    .eq('tenant_id', context.tenantId)
    .eq('status', 'open')
    .order('opened_at', { ascending: false })

  if (venueId) {
    salesQuery = salesQuery.eq('venue_id', venueId)
    ticketsQuery = ticketsQuery.eq('venue_id', venueId)
    openSessionsQuery = openSessionsQuery.eq('venue_id', venueId)
  }

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
      quantity: current.quantity + line.quantity,
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
type DiscountRow = {
  id: string
  tenant_id: string
  venue_id: string
  name: string
  type: 'percentage' | 'fixed'
  value: number | string
  color: string | null
  is_active: boolean
  sort_order: number
}

function mapDiscount(row: DiscountRow): Discount {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    venueId: row.venue_id,
    name: row.name,
    type: row.type,
    value: row.type === 'fixed' ? Math.round(Number(row.value) * 100) : Number(row.value),
    color: row.color,
    isActive: row.is_active,
    sortOrder: row.sort_order,
  }
}

function serializeDiscountValue(type: DiscountCreateInput['type'], value: number) {
  if (!Number.isFinite(value) || value <= 0 || (type === 'percentage' && value > 100)) {
    throw new Error(type === 'percentage' ? 'El porcentaje debe estar entre 0 y 100.' : 'El importe debe ser mayor que 0.')
  }
  if (type === 'fixed' && !Number.isInteger(value)) throw new Error('El importe debe expresarse en céntimos.')
  return type === 'fixed' ? (value / 100).toFixed(2) : value
}

export async function loadCrmDiscounts(context: TenantContext, venueId: string): Promise<Discount[]> {
  const { data, error } = await requireSupabase()
    .from('discounts')
    .select('id, tenant_id, venue_id, name, type, value, color, is_active, sort_order')
    .eq('tenant_id', context.tenantId)
    .eq('venue_id', venueId)
    .order('sort_order')
    .order('name')
  if (error) throw error
  return ((data ?? []) as DiscountRow[]).map(mapDiscount)
}

export async function createDiscount(context: TenantContext, input: DiscountCreateInput) {
  const name = validateDiscountDefinition(input.name, input.type, input.value)
  const { error } = await requireSupabase().from('discounts').insert({
    tenant_id: context.tenantId,
    venue_id: input.venueId,
    name,
    type: input.type,
    value: serializeDiscountValue(input.type, input.value),
    color: input.color || null,
    is_active: input.isActive,
    sort_order: 0,
  })
  if (error) throw error
}

export async function updateDiscount(context: TenantContext, discountId: string, input: Omit<DiscountCreateInput, 'venueId'>) {
  const name = validateDiscountDefinition(input.name, input.type, input.value)
  const { error } = await requireSupabase().from('discounts').update({
    name,
    type: input.type,
    value: serializeDiscountValue(input.type, input.value),
    color: input.color || null,
    is_active: input.isActive,
  }).eq('tenant_id', context.tenantId).eq('id', discountId)
  if (error) throw error
}

export async function setDiscountActive(context: TenantContext, discountId: string, isActive: boolean) {
  const { error } = await requireSupabase().from('discounts').update({ is_active: isActive })
    .eq('tenant_id', context.tenantId).eq('id', discountId)
  if (error) throw error
}

export async function loadManualDiscountEnabled(context: TenantContext, venueId: string) {
  const { data, error } = await requireSupabase().from('venues').select('manual_discount_enabled')
    .eq('tenant_id', context.tenantId).eq('id', venueId).single<{ manual_discount_enabled: boolean }>()
  if (error) throw error
  return data.manual_discount_enabled
}

export async function setManualDiscountEnabled(context: TenantContext, venueId: string, enabled: boolean) {
  const { error } = await requireSupabase().from('venues').update({ manual_discount_enabled: enabled })
    .eq('tenant_id', context.tenantId).eq('id', venueId)
  if (error) throw error
}
