import { useCallback, useEffect, useState } from 'react'
import { Save, ShieldCheck } from 'lucide-react'
import { sileo } from 'sileo'
import { Button as UiButton } from '../../../../components/ui/Button'
import { Input as UiInput } from '../../../../components/ui/Input'
import type { TenantContext } from '../../../../types'
import { supabase } from '../../../../lib/supabase.ts'
import { loadFiscalSifInstallations, saveFiscalPwaSetup, type FiscalSifInstallation } from '../../../fiscal/local/setup.ts'
import { Field } from '../../shared/components/Field'
import type { RunAction } from '../../shared/types'

type Venue = { id: string; name: string; fiscal_code: string | null; legal_name: string | null; tax_id: string | null }
type Register = { id: string; venue_id: string; name: string; fiscal_code: string | null }
type Props = { tenantContext: TenantContext; disabled: boolean; runAction: RunAction }
const inputClass = '!h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none focus:!border-[var(--crm-blue)]'

export function FiscalSifSetup({ tenantContext, disabled, runAction }: Props) {
  const canEdit = tenantContext.role === 'owner'
  const [legalName, setLegalName] = useState('')
  const [nif, setNif] = useState('')
  const [venues, setVenues] = useState<Venue[]>([])
  const [registers, setRegisters] = useState<Register[]>([])
  const [installations, setInstallations] = useState<FiscalSifInstallation[]>([])
  const [venueCodes, setVenueCodes] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    if (!supabase) throw new Error('Supabase no está configurado.')
    const [venueResult, registerResult, subjectResult, active] = await Promise.all([
      supabase.from('venues').select('id,name,fiscal_code,legal_name,tax_id').eq('tenant_id', tenantContext.tenantId).eq('is_active', true).order('name'),
      supabase.from('cash_registers').select('id,venue_id,name,fiscal_code').eq('tenant_id', tenantContext.tenantId).eq('is_active', true).order('name'),
      supabase.from('fiscal_subjects').select('legal_name,nif').eq('tenant_id', tenantContext.tenantId).maybeSingle(),
      loadFiscalSifInstallations(tenantContext.tenantId),
    ])
    if (venueResult.error) throw venueResult.error
    if (registerResult.error) throw registerResult.error
    if (subjectResult.error) throw subjectResult.error
    const nextVenues = venueResult.data as Venue[]
    setVenues(nextVenues); setRegisters(registerResult.data as Register[]); setInstallations(active)
    setLegalName(subjectResult.data?.legal_name ?? nextVenues[0]?.legal_name ?? '')
    setNif(subjectResult.data?.nif ?? nextVenues[0]?.tax_id ?? '')
    setVenueCodes(Object.fromEntries(nextVenues.map(venue => [venue.id, venue.fiscal_code ?? ''])))
  }, [tenantContext.tenantId])

  useEffect(() => { void runAction(refresh) }, [refresh, runAction])

  async function submit() {
    await runAction(async () => {
      await saveFiscalPwaSetup(tenantContext.tenantId, { legalName, nif,
        venues: venues.map(venue => ({ venueId: venue.id, venueCode: venueCodes[venue.id] ?? '' })),
      })
      await refresh()
      sileo.success({ title: 'Configuración fiscal guardada', description: 'Activa cada instalación desde su PWA al abrir la caja.' })
    })
  }

  return <section className="!grid !gap-4 !rounded-2xl !bg-[var(--crm-surface)] !p-5 !text-[var(--crm-text)] !shadow-[var(--crm-shadow-card)]">
    <div><h2 className="!m-0 !text-base !font-bold">Titular y cajas fiscales</h2><p className="!mt-1 !mb-0 !text-xs !text-[var(--crm-text-muted)]">El CRM prepara la caja lógica. Cada PWA confirma su propia instalación y conserva su identidad local.</p></div>
    <div className="!grid !gap-3 sm:!grid-cols-2">
      <Field label="Razón social del titular"><UiInput className={inputClass} disabled={disabled || !canEdit} value={legalName} onChange={event => setLegalName(event.target.value)} maxLength={120} /></Field>
      <Field label="NIF del titular"><UiInput className={inputClass} disabled={disabled || !canEdit} value={nif} onChange={event => setNif(event.target.value.toUpperCase())} maxLength={9} /></Field>
    </div>
    {venues.map(venue => <div className="!grid !gap-3 !rounded-xl !bg-[var(--crm-surface-soft)] !p-4" key={venue.id}>
      <div className="!font-semibold">{venue.name}</div>
      <Field label="Código local"><UiInput className={inputClass} disabled={disabled || !canEdit || Boolean(venue.fiscal_code)} value={venueCodes[venue.id] ?? ''} onChange={event => setVenueCodes(current => ({ ...current, [venue.id]: event.target.value.toUpperCase() }))} maxLength={8} /></Field>
      {registers.filter(register => register.venue_id === venue.id).map(register => {
        const installation = installations.find(item => item.cash_register_id === register.id)
        return <p className="!m-0 !text-sm" key={register.id}>{register.name} · {register.fiscal_code ?? 'Código de caja pendiente de asignar'} · {installation ? `Instalación activa: ${installation.installation_number}` : 'Pendiente de activar desde la PWA'}</p>
      })}
    </div>)}
    <p className="!m-0 !flex !items-start !gap-2 !text-xs !text-[var(--crm-text-muted)]"><ShieldCheck className="!mt-0.5 !size-4 !shrink-0" />Los números de instalación se asignan automáticamente por caja, incluidas las retiradas. Sustituir o reinstalar una PWA requiere confirmar otra instalación desde el dispositivo.</p>
    {canEdit ? <footer className="!flex !justify-end"><UiButton className="!inline-flex !min-h-10 !items-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" disabled={disabled || !venues.length} onClick={() => void submit()} type="button"><Save className="!size-4" />Guardar titular y cajas</UiButton></footer> : null}
  </section>
}
