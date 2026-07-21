export const CRM_THEME_STORAGE_KEY = 'pos:crm-theme'
export type CrmTheme = 'light' | 'dark'

export function getInitialCrmTheme(): CrmTheme {
  try {
    const storedTheme = window.localStorage.getItem(CRM_THEME_STORAGE_KEY)
    if (storedTheme === 'light' || storedTheme === 'dark') return storedTheme
  } catch {
    // El almacenamiento puede no estar disponible en navegacion privada.
  }
  return document.documentElement.dataset.theme === 'club-night' ? 'dark' : 'light'
}
