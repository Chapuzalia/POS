import { useCallback, useEffect, useRef, useState } from 'react'
import type { CatalogData } from '../../../catalog/domain/types.ts'
import { catalogAdminService } from '../services/catalogAdminService.ts'

export function useCatalogAdmin(venueId: string, enabled: boolean, onError: (error: unknown) => void) {
  const [catalog, setCatalog] = useState<CatalogData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const requestId = useRef(0)

  const refresh = useCallback(async (force = true) => {
    if (!venueId || !enabled) {
      setCatalog(null)
      return null
    }
    const currentRequest = ++requestId.current
    setIsLoading(true)
    try {
      const nextCatalog = await catalogAdminService.load(venueId, force)
      if (requestId.current === currentRequest) setCatalog(nextCatalog)
      return nextCatalog
    } finally {
      if (requestId.current === currentRequest) setIsLoading(false)
    }
  }, [enabled, venueId])

  useEffect(() => {
    setCatalog(null)
    if (enabled && venueId) void refresh(false).catch(onError)
    return () => {
      requestId.current += 1
    }
  }, [enabled, onError, refresh, venueId])

  return { catalog, isLoading, refresh }
}
