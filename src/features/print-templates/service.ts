import type { TenantContext } from '../../types/index.ts'
import { requireSupabase } from '../crm/shared/services/crmServiceSupport.ts'
import { getSafeDefaultPrintTemplate } from './defaults.ts'
import { printTemplateDefinitionSchema } from './schema.ts'
import type { PrintTemplateDefinition, PrintTemplateType, ResolvedPrintTemplate } from './types.ts'

export async function resolvePrintTemplate(
  context: Pick<TenantContext, 'tenantId' | 'venueId'>,
  type: PrintTemplateType,
): Promise<ResolvedPrintTemplate> {
  const safe = (): ResolvedPrintTemplate => ({ definition: getSafeDefaultPrintTemplate(type), isCustom: false, source: 'safe-default', type })
  try {
    const client = requireSupabase()
    const custom = await client.from('print_templates').select('definition, is_active')
      .eq('tenant_id', context.tenantId).eq('venue_id', context.venueId).eq('type', type).maybeSingle()
    const parsedCustom = custom.data?.is_active ? printTemplateDefinitionSchema.safeParse(custom.data.definition) : null
    if (!custom.error && parsedCustom?.success) return { definition: parsedCustom.data, isCustom: true, source: 'custom', type }
    const persistedDefault = await client.from('print_template_defaults').select('definition')
      .eq('type', type).maybeSingle()
    const parsedDefault = printTemplateDefinitionSchema.safeParse(persistedDefault.data?.definition)
    if (!persistedDefault.error && parsedDefault.success) {
      return { definition: parsedDefault.data, isCustom: false, source: 'database-default', type }
    }
    return safe()
  } catch {
    return safe()
  }
}

export async function savePrintTemplate(
  context: Pick<TenantContext, 'tenantId' | 'venueId'>,
  type: PrintTemplateType,
  definition: PrintTemplateDefinition,
) {
  const validated = printTemplateDefinitionSchema.parse(definition)
  const { error } = await requireSupabase().from('print_templates').upsert({
    tenant_id: context.tenantId,
    venue_id: context.venueId,
    type,
    name: type,
    definition: validated,
    is_active: true,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'tenant_id,venue_id,type' })
  if (error) throw error
}

export async function restoreDefaultPrintTemplate(
  context: Pick<TenantContext, 'tenantId' | 'venueId'>,
  type: PrintTemplateType,
) {
  const { error } = await requireSupabase().from('print_templates')
    .delete().eq('tenant_id', context.tenantId).eq('venue_id', context.venueId).eq('type', type)
  if (error) throw error
  return resolvePrintTemplate(context, type)
}
