import { z } from 'zod'
import { supabase } from '../../../lib/supabase.ts'

const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/)
const setupSchema = z.object({
  legalName: z.string().trim().min(1).max(120),
  nif: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{9}$/),
  installations: z.array(z.object({
    installationId: z.uuid().optional(), venueId: z.uuid(), cashRegisterId: z.uuid(), deviceId: z.uuid(),
    installationNumber: z.string().trim().min(1).max(100), venueCode: code, registerCode: code, installationCode: code,
  })).min(1),
})

const installationSchema = z.object({
  id: z.uuid(), tenant_id: z.uuid(), fiscal_subject_id: z.uuid(), venue_id: z.uuid(), cash_register_id: z.uuid(),
  device_id: z.uuid(), installation_number: z.string(), venue_code: z.string(), register_code: z.string(),
  installation_code: z.string(), mode: z.enum(['disabled', 'test', 'production']), retired_at: z.string().nullable(),
})

export type FiscalSifSetup = z.infer<typeof setupSchema>
export type FiscalSifInstallation = z.infer<typeof installationSchema>

export async function loadFiscalSifInstallations(tenantId: string): Promise<FiscalSifInstallation[]> {
  if (!supabase) throw new Error('Supabase no está configurado.')
  const { data, error } = await supabase.from('fiscal_sif_installations')
    .select('id,tenant_id,fiscal_subject_id,venue_id,cash_register_id,device_id,installation_number,venue_code,register_code,installation_code,mode,retired_at')
    .eq('tenant_id', tenantId).is('retired_at', null)
  if (error) throw error
  return z.array(installationSchema).parse(data)
}

export async function saveFiscalSifSetup(tenantId: string, input: FiscalSifSetup): Promise<void> {
  if (!supabase) throw new Error('Supabase no está configurado.')
  const setup = setupSchema.parse(input)
  const { error } = await supabase.rpc('save_fiscal_sif_setup', {
    p_tenant_id: tenantId, p_legal_name: setup.legalName, p_nif: setup.nif,
    p_installations: setup.installations.map(({ installationId, ...installation }) => ({
      ...(installationId ? { installationId } : {}), ...installation,
    })),
  })
  if (error) throw error
}
