import { getAppRoute } from '../app/app-routes'

if (getAppRoute() === 'crm') {
  const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
  if (manifest) manifest.href = '/crm.webmanifest'

  for (const name of ['application-name', 'apple-mobile-web-app-title']) {
    const meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
    if (meta) meta.content = 'Tickit CRM'
  }
}
