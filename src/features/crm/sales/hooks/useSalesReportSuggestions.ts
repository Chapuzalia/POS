import { useEffect, useMemo, useState } from 'react'
import type { TenantContext } from '../../../../types'
import { getReadableError } from '../../../../utils/errors'
import { loadCrmSalesReportFilterOptions, type CrmSalesReportFilterOptions, type CrmSalesReportFilters } from '../services/salesReportsService'

export function useSalesReportSuggestions(context: TenantContext, venueId: string, filters: CrmSalesReportFilters, enabled: boolean, revision: number) {
  const { dateFromIso, dateToIso, productQuery, categoryQuery } = filters
  const request = useMemo(() => ({ context, venueId, revision, filters: { dateFromIso, dateToIso, productQuery, categoryQuery } }),
    [context, venueId, revision, dateFromIso, dateToIso, productQuery, categoryQuery])
  const [result, setResult] = useState<{
    request: typeof request
    options: CrmSalesReportFilterOptions | null
    error: string | null
  } | null>(null)

  useEffect(() => {
    if (!enabled || !venueId) return
    const controller = new AbortController()
    void loadCrmSalesReportFilterOptions(context, venueId, request.filters, controller.signal).then(
      (options) => { if (!controller.signal.aborted) setResult({ request, options, error: null }) },
      (error: unknown) => {
        if (controller.signal.aborted) return
        getReadableError(error, { operation: 'crm.sales.suggestions' })
        setResult({ request, options: null, error: 'No se pudieron cargar las sugerencias. Pulsa actualizar para reintentarlo.' })
      },
    )
    return () => controller.abort()
  }, [context, enabled, request, venueId])

  const current = enabled && result?.request === request ? result : null
  return { options: current?.options ?? null, error: current?.error ?? null, isLoading: enabled && !current }
}
