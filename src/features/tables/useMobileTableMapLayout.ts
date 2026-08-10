import { useSyncExternalStore } from 'react'

export const MOBILE_TABLE_MAP_QUERY = '(max-width: 767px), (max-width: 950px) and (max-height: 500px)'

function subscribe(onChange: () => void) {
  const media = window.matchMedia(MOBILE_TABLE_MAP_QUERY)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

function getSnapshot() {
  return window.matchMedia(MOBILE_TABLE_MAP_QUERY).matches
}

export function useMobileTableMapLayout() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
