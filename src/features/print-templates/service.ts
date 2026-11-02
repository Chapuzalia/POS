import type { TenantContext } from '../../types/index.ts'
import { requireSupabase } from '../../services/backendService.ts'
import { getSafeDefaultPrintTemplate } from './defaults.ts'
import { printTemplateDefinitionSchema } from './schema.ts'
import { resolveSafeTemplateDefinition } from './saleTemplateGuard.ts'
import type { PrintTemplateDefinition, PrintTemplateType, ResolvedPrintTemplate } from './types.ts'

type CachedTemplate = { value?: ResolvedPrintTemplate; expiresAt: number }
const templates = new Map<string, CachedTemplate>()
const templateKey = (context: Pick<TenantContext, 'tenantId' | 'venueId'>, type: PrintTemplateType) =>
  JSON.stringify([context.tenantId, context.venueId, type])

export async function resolvePrintTemplate(
  context: Pick<TenantContext, 'tenantId' | 'venueId'>,
  type: PrintTemplateType,
): Promise<ResolvedPrintTemplate> {
  const safe = (): ResolvedPrintTemplate => ({ definition: getSafeDefaultPrintTemplate(type), isCustom: false, source: 'safe-default', type })
  const key = templateKey(context, type)
  const cached = templates.get(key) ?? { expiresAt: 0 }
  templates.set(key, cached)
  const fallback = () => structuredClone(cached.value ?? safe())
  if (cached.value && cached.expiresAt > Date.now()) return fallback()
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return fallback()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  // One budget covers both cloud reads, including a client stuck waiting for auth.
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(null) }, 1_000)
  })
  try {
    const resolved = await Promise.race([loadTemplate(), timeout])
    if (!resolved) return fallback()
    if (templates.get(key) === cached) {
      cached.value = structuredClone(resolved)
      cached.expiresAt = Date.now() + 60_000
    }
    return resolved
  } catch {
    return fallback()
  } finally { clearTimeout(timer) }

  async function loadTemplate(): Promise<ResolvedPrintTemplate | null> {
    const client = requireSupabase()
    const custom = await client.from('print_templates').select('definition, is_active')
      .eq('tenant_id', context.tenantId).eq('venue_id', context.venueId).eq('type', type).abortSignal(controller.signal).maybeSingle()
    if (controller.signal.aborted) return null
    const parsedCustom = custom.data?.is_active ? printTemplateDefinitionSchema.safeParse(custom.data.definition) : null
    if (!custom.error && parsedCustom?.success) {
      return { definition: resolveSafeTemplateDefinition(type, parsedCustom.data), isCustom: true, source: 'custom', type }
    }
    const persistedDefault = await client.from('print_template_defaults').select('definition')
      .eq('type', type).abortSignal(controller.signal).maybeSingle()
    if (controller.signal.aborted) return null
    const parsedDefault = printTemplateDefinitionSchema.safeParse(persistedDefault.data?.definition)
    if (!persistedDefault.error && parsedDefault.success) {
      return { definition: resolveSafeTemplateDefinition(type, parsedDefault.data), isCustom: false, source: 'database-default', type }
    }
    return null
  }
}

export async function savePrintTemplate(
  context: Pick<TenantContext, 'tenantId' | 'venueId'>,
  type: PrintTemplateType,
  definition: PrintTemplateDefinition,
) {
  const validated = printTemplateDefinitionSchema.parse(definition)
  const { error } = await requireSupabase().rpc('save_print_template', {
    p_tenant_id: context.tenantId,
    p_venue_id: context.venueId,
    p_type: type,
    p_definition: resolveSafeTemplateDefinition(type, validated),
  })
  if (error) throw error
  templates.delete(templateKey(context, type))
}

export async function restoreDefaultPrintTemplate(
  context: Pick<TenantContext, 'tenantId' | 'venueId'>,
  type: PrintTemplateType,
) {
  const { error } = await requireSupabase().from('print_templates')
    .delete().eq('tenant_id', context.tenantId).eq('venue_id', context.venueId).eq('type', type)
  if (error) throw error
  templates.delete(templateKey(context, type))
  return resolvePrintTemplate(context, type)
}
