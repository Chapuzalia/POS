// Universal Links (iOS) / App Links (Android): ver public/.well-known y la configuración nativa.
const DEEP_LINK_HOSTS = new Set(['app.tickitpos.com', 'pre.tickitpos.com'])
const DEEP_LINK_PARAM = 'deeplink'
const HANDLED_LAUNCH_KEY = 'tickit:native-launch-url'
const crmPathPattern = /^\/crm(?:\/[A-Za-z0-9/_-]*)?(?:\?[^#]*)?$/

/** Ruta del CRM a abrir para un enlace de la web, o null si el enlace no es nuestro. */
export function deepLinkTarget(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:' || !DEEP_LINK_HOSTS.has(url.hostname)) return null
    const target = `${url.pathname}${url.search}`
    return crmPathPattern.test(target) ? target : null
  } catch {
    return null
  }
}

// La app sirve /crm/ (su index.html) pero no las rutas cliente del CRM: se entra por /crm/
// con la ruta pedida como parámetro y restoreDeepLinkRoute la recupera antes de arrancar.
export function deepLinkEntryUrl(target: string) {
  return `/crm/?${DEEP_LINK_PARAM}=${encodeURIComponent(target)}`
}

export function restoreDeepLinkRoute(location: Pick<Location, 'search'> = window.location, history: Pick<History, 'replaceState'> = window.history) {
  const target = new URLSearchParams(location.search).get(DEEP_LINK_PARAM)
  if (target && crmPathPattern.test(target)) history.replaceState(null, '', target)
}

export async function listenForNativeDeepLinks() {
  const [{ App }, { Browser }] = await Promise.all([import('@capacitor/app'), import('@capacitor/browser')])
  const open = (url: string) => {
    const target = deepLinkTarget(url)
    if (!target) return
    // Cierra el navegador del pago (solo iOS; en Android lo cierra el propio intent).
    void Browser.close().catch(() => undefined)
    window.location.replace(deepLinkEntryUrl(target))
  }
  await App.addListener('appUrlOpen', ({ url }) => open(url))
  // Arranque en frío desde un enlace: getLaunchUrl() lo sigue devolviendo tras recargar, se trata una vez.
  const launch = await App.getLaunchUrl()
  if (!launch?.url) return
  try {
    if (sessionStorage.getItem(HANDLED_LAUNCH_KEY) === launch.url) return
    sessionStorage.setItem(HANDLED_LAUNCH_KEY, launch.url)
  } catch { return /* sin sessionStorage no se puede evitar un bucle de recarga */ }
  open(launch.url)
}
