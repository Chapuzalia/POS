declare const __APP_VERSION__: string

/** Build identifier, sourced from the Git commit deployed to Vercel. */
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'development'

export type AppVersionStatus = 'compatible' | 'update-required'

type AppVersionPolicy = {
  supportedVersions: string[]
}

const VERSION_CHECK_TIMEOUT_MS = 10_000

function parseAppVersionPolicy(value: unknown): AppVersionPolicy {
  if (
    !value
    || typeof value !== 'object'
    || !('supportedVersions' in value)
    || !Array.isArray(value.supportedVersions)
    || value.supportedVersions.length === 0
    || value.supportedVersions.some((version) => typeof version !== 'string' || !version.trim())
  ) {
    throw new Error('La política de versiones del POS no es válida.')
  }

  return { supportedVersions: value.supportedVersions.map((version) => version.trim()) }
}

export function resolveAppVersionStatus(
  currentVersion: string,
  policy: unknown,
): AppVersionStatus {
  const { supportedVersions } = parseAppVersionPolicy(policy)
  return supportedVersions.includes(currentVersion) ? 'compatible' : 'update-required'
}

export async function loadAppVersionStatus(
  fetcher: typeof fetch = fetch,
  currentVersion = APP_VERSION,
): Promise<AppVersionStatus> {
  if (currentVersion === 'development') return 'compatible'

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), VERSION_CHECK_TIMEOUT_MS)
  try {
    const response = await fetcher('/app-version.json', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`No se pudo comprobar la versión del POS (${response.status}).`)

    return resolveAppVersionStatus(currentVersion, await response.json())
  } finally {
    clearTimeout(timeoutId)
  }
}

let pendingVersionCheck: Promise<AppVersionStatus> | null = null

/** Deduplicate simultaneous focus/visibility checks (and React Strict Mode effects). */
export function checkCurrentAppVersion() {
  if (!pendingVersionCheck) {
    pendingVersionCheck = loadAppVersionStatus()
      .finally(() => { pendingVersionCheck = null })
  }
  return pendingVersionCheck
}
