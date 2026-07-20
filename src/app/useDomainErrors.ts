import { useCallback, useMemo, useState } from 'react'

type ErrorDomain = 'session' | 'cash' | 'sale' | 'restaurant' | 'general'
type DomainErrors = Record<ErrorDomain, string | null>

const emptyErrors: DomainErrors = {
  session: null,
  cash: null,
  sale: null,
  restaurant: null,
  general: null,
}

export function useDomainErrors() {
  const [errors, setErrors] = useState<DomainErrors>(emptyErrors)
  const set = useCallback((domain: ErrorDomain, message: string | null) => {
    setErrors(message ? { ...emptyErrors, [domain]: message } : emptyErrors)
  }, [])
  const clear = useCallback(() => setErrors(emptyErrors), [])
  const setCashError = useCallback((message: string | null) => set('cash', message), [set])
  const setGeneralError = useCallback((message: string | null) => set('general', message), [set])
  const setRestaurantError = useCallback((message: string | null) => set('restaurant', message), [set])
  const setSaleError = useCallback((message: string | null) => set('sale', message), [set])
  const setSessionError = useCallback((message: string | null) => set('session', message), [set])
  return {
    clear,
    error: useMemo(
      () => errors.session ?? errors.cash ?? errors.sale ?? errors.restaurant ?? errors.general,
      [errors],
    ),
    setCashError,
    setGeneralError,
    setRestaurantError,
    setSaleError,
    setSessionError,
  }
}
