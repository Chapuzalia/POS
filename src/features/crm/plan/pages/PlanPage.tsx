import { Building2, MonitorSmartphone, RefreshCw } from 'lucide-react'
import { type CrmPlan, loadCrmPlan } from '../services/planService'
import { type RunAction } from '../../shared/types'
import { type TenantContext } from '../../../../types'
import { useCallback, useEffect, useState } from 'react'

export type PlanCrmProps = {
  disabled: boolean
  runAction: RunAction
  tenantContext: TenantContext
}

export function PlanCrm({ disabled, runAction, tenantContext }: PlanCrmProps) {
  const [plan, setPlan] = useState<CrmPlan | null>(null)

  const refresh = useCallback(async () => {
    setPlan(await loadCrmPlan(tenantContext))
  }, [tenantContext])

  useEffect(() => {
    void runAction(refresh)
  }, [refresh, runAction])

  const resources = plan ? [
    { icon: Building2, label: 'Locales', limit: plan.limits.venues, usage: plan.usage.venues },
    { icon: MonitorSmartphone, label: 'Dispositivos', limit: plan.limits.devices, usage: plan.usage.devices },
  ] : []

  return (
    <div className="!grid !gap-5">
      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-panel-header !flex !min-h-[72px] !items-center !justify-between !gap-4 !border-0 !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!px-[22px]">
          <div><h2 className="!m-0 !text-lg !font-bold">Mi Plan</h2><p>Consulta los recursos incluidos y el uso actual de tu negocio.</p></div>
          <button aria-label="Actualizar plan" className="crm-icon-button !inline-flex !size-10 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !p-0 !text-[var(--crm-text-muted)]" disabled={disabled} onClick={() => void runAction(refresh)} title="Actualizar" type="button"><RefreshCw className="!size-4" /></button>
        </div>

        {plan ? (
          <div className="!grid !grid-cols-1 !gap-4 !px-[18px] !pb-[22px] md:!grid-cols-2 md:!px-[22px]">
            {resources.map(({ icon: Icon, label, limit, usage }) => {
              const percentage = limit > 0 ? Math.min(100, Math.round((usage / limit) * 100)) : usage > 0 ? 100 : 0
              const remaining = Math.max(0, limit - usage)
              return (
                <article className="!grid !gap-4 !rounded-[14px] !bg-[var(--crm-surface-soft)] !p-5" key={label}>
                  <div className="!flex !items-center !justify-between !gap-3"><div className="!grid !size-10 !place-items-center !rounded-[10px] !bg-[var(--crm-blue-soft)] !text-[var(--crm-blue)]"><Icon className="!size-5" /></div><span className="!text-xs !font-semibold !text-[var(--crm-text-muted)]">{remaining} disponibles</span></div>
                  <div><p className="!m-0 !text-xs !font-semibold !text-[var(--crm-text-muted)]">{label}</p><strong className="!mt-1 !block !text-3xl !font-bold !tracking-tight">{usage} <span className="!text-base !font-medium !text-[var(--crm-text-muted)]">/ {limit}</span></strong></div>
                  <div className="!h-2 !overflow-hidden !rounded-full !bg-[var(--crm-border)]"><i className="!block !h-full !rounded-full !bg-[var(--crm-blue)] !transition-[width] !duration-300" style={{ width: `${percentage}%` }} /></div>
                </article>
              )
            })}
          </div>
        ) : <div className="!grid !min-h-[180px] !place-items-center !px-5 !pb-5 !text-sm !font-medium !text-[var(--crm-text-muted)]">Cargando información del plan...</div>}
      </section>
      <p className="!m-0 !px-1 !text-xs !font-medium !text-[var(--crm-text-muted)]">Si necesitas ampliar alguno de estos límites, contacta con el administrador de la plataforma.</p>
    </div>
  )
}
