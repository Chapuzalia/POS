import { useEffect, useMemo, useState } from 'react'
import type { TenantContext } from '../../../../types'
import { getReadableError } from '../../../../utils/errors'
import { loadCrmSalesReportSummary, type CrmSalesReportFilters, type CrmSalesReportSummary } from '../services/salesReportsService'

export function useSalesReportSummary(context: TenantContext, venueId: string, filters: CrmSalesReportFilters, revision: number) {
  const request = useMemo(() => ({ context, venueId, filters, revision }), [context, venueId, filters, revision])
  const [result, setResult] = useState<{
    request: typeof request
    summary: CrmSalesReportSummary | null
    error: string | null
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadCrmSalesReportSummary(request.context, request.venueId, request.filters).then(
      (summary) => { if (!cancelled) setResult({ request, summary, error: null }) },
      (error: unknown) => {
        if (cancelled) return
        getReadableError(error, { operation: 'crm.sales.summary' })
        setResult({ request, summary: null, error: 'No se pudo cargar el resumen. Pulsa actualizar para reintentarlo.' })
      },
    )
    return () => { cancelled = true }
  }, [request])

  const current = result?.request === request ? result : null
  return { summary: current?.summary ?? null, error: current?.error ?? null, isLoading: !current }
}
