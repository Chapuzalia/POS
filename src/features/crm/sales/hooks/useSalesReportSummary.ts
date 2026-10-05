import { useEffect, useMemo, useState } from 'react'
import type { TenantContext } from '../../../../types'
import { getReadableError } from '../../../../utils/errors'
import { loadCrmSalesReportSummary, type CrmSalesReportFilters, type CrmSalesReportSummary } from '../services/salesReportsService'

export function useSalesReportSummary(context: TenantContext, venueId: string, filters: CrmSalesReportFilters, revision: number, enabled = true) {
  const request = useMemo(() => ({ context, venueId, filters, revision }), [context, venueId, filters, revision])
  const [result, setResult] = useState<{
    request: typeof request
    summary: CrmSalesReportSummary | null
    error: string | null
  } | null>(null)

  useEffect(() => {
    if (!enabled || !venueId) return
    const controller = new AbortController()
    void loadCrmSalesReportSummary(request.context, request.venueId, request.filters, controller.signal).then(
      (summary) => { if (!controller.signal.aborted) setResult({ request, summary, error: null }) },
      (error: unknown) => {
        if (controller.signal.aborted) return
        getReadableError(error, { operation: 'crm.sales.summary' })
        setResult({ request, summary: null, error: 'No se pudo cargar el resumen. Pulsa actualizar para reintentarlo.' })
      },
    )
    return () => { controller.abort() }
  }, [enabled, request, venueId])

  const current = result?.request === request ? result : null
  return { summary: current?.summary ?? null, error: current?.error ?? null, isLoading: !enabled || !current }
}
