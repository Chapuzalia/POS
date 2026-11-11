import { describe, expect, it, vi } from 'vitest'
import { deepLinkEntryUrl, deepLinkTarget, restoreDeepLinkRoute } from '../../src/app/nativeDeepLinks'

describe('enlaces profundos de la app nativa', () => {
  it('acepta solo retornos https del CRM en los dominios de Tickit', () => {
    expect(deepLinkTarget('https://app.tickitpos.com/crm?billing=success')).toBe('/crm?billing=success')
    expect(deepLinkTarget('https://pre.tickitpos.com/crm/plan?billing=return')).toBe('/crm/plan?billing=return')
    expect(deepLinkTarget('https://evil.example.com/crm?billing=success')).toBeNull()
    expect(deepLinkTarget('http://app.tickitpos.com/crm')).toBeNull()
    expect(deepLinkTarget('https://app.tickitpos.com/superadmin')).toBeNull()
    expect(deepLinkTarget('no es una url')).toBeNull()
  })

  it('entra por /crm/ y restaura la ruta pedida antes de arrancar', () => {
    const entry = new URL(deepLinkEntryUrl('/crm/plan?billing=return'), 'capacitor://localhost')
    expect(entry.pathname).toBe('/crm/')
    const history = { replaceState: vi.fn() }
    restoreDeepLinkRoute({ search: entry.search }, history)
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/crm/plan?billing=return')
  })

  it('ignora rutas restauradas que no son del CRM', () => {
    const history = { replaceState: vi.fn() }
    restoreDeepLinkRoute({ search: `?deeplink=${encodeURIComponent('//evil.example.com')}` }, history)
    restoreDeepLinkRoute({ search: `?deeplink=${encodeURIComponent('/superadmin')}` }, history)
    expect(history.replaceState).not.toHaveBeenCalled()
  })
})
