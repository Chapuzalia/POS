import { useEffect, useState } from 'react'
import { getStoredTheme, saveStoredTheme } from '../lib/offlineStore'
import type { ThemeDefinition } from '../types'

export function useThemeTokens(themes: ThemeDefinition[], defaultThemeId: string) {
  const [themeId, setThemeId] = useState(() => getStoredTheme(defaultThemeId))
  const selectedTheme = themes.find((theme) => theme.id === themeId) ?? themes[0]

  useEffect(() => {
    if (!selectedTheme) {
      return
    }

    const root = document.documentElement
    root.dataset.theme = selectedTheme.id
    root.style.colorScheme = selectedTheme.mode
    root.style.setProperty('--radius', selectedTheme.radius)
    root.style.setProperty('--border-width', selectedTheme.borderWidth)
    root.style.setProperty('--shadow', selectedTheme.shadow)

    Object.entries(selectedTheme.tokens).forEach(([key, value]) => {
      root.style.setProperty(`--${key}`, value)
    })
  }, [selectedTheme])

  useEffect(() => {
    saveStoredTheme(themeId)
  }, [themeId])

  return {
    selectedTheme,
    setThemeId,
    themeId,
  }
}
