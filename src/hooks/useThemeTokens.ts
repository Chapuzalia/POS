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
    root.dataset.theme = selectedTheme.mode
    root.dataset.posTheme = selectedTheme.id
    root.style.colorScheme = selectedTheme.mode
    root.style.setProperty('--radius', selectedTheme.radius)
    root.style.setProperty('--field-radius', selectedTheme.radius)
    root.style.setProperty('--border-width', selectedTheme.borderWidth)
    root.style.setProperty('--field-border-width', selectedTheme.borderWidth)
    root.style.setProperty('--surface-shadow', selectedTheme.shadow)
    root.style.setProperty('--overlay-shadow', selectedTheme.shadow)
    root.style.setProperty('--field-shadow', selectedTheme.shadow)

    Object.entries(selectedTheme.tokens).forEach(([key, value]) => {
      root.style.setProperty(`--${key}`, value)
    })

    const tokens = selectedTheme.tokens
    root.style.setProperty('--surface-foreground', tokens.foreground)
    root.style.setProperty('--overlay', tokens.surface)
    root.style.setProperty('--overlay-foreground', tokens.foreground)
    root.style.setProperty('--default', tokens.surfaceSecondary)
    root.style.setProperty('--default-foreground', tokens.foreground)
    root.style.setProperty('--field-background', tokens.field)
    root.style.setProperty('--field-foreground', tokens.foreground)
    root.style.setProperty('--field-placeholder', tokens.muted)
    root.style.setProperty('--field-border', tokens.separator)
    root.style.setProperty('--border', tokens.separator)
    root.style.setProperty('--focus', tokens.accent)
    root.style.setProperty('--link', tokens.accent)
    root.style.setProperty('--segment', tokens.surface)
    root.style.setProperty('--segment-foreground', tokens.foreground)
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
