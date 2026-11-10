import { useState } from 'react'

export const CRM_THEME_STORAGE_KEY = 'pos:crm-theme'
export type CrmTheme = 'light' | 'dark'

export function getInitialCrmTheme(): CrmTheme {
  try {
    const storedTheme = window.localStorage.getItem(CRM_THEME_STORAGE_KEY)
    if (storedTheme === 'light' || storedTheme === 'dark') return storedTheme
  } catch {
    // El almacenamiento puede no estar disponible en navegación privada.
  }
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export function useCrmTheme() {
  const [theme, setTheme] = useState<CrmTheme>(getInitialCrmTheme)
  function toggleTheme() {
    const nextTheme: CrmTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(nextTheme)
    try {
      window.localStorage.setItem(CRM_THEME_STORAGE_KEY, nextTheme)
    } catch {
      // El cambio sigue activo durante la sesión aunque no pueda persistirse.
    }
  }
  return [theme, toggleTheme] as const
}
