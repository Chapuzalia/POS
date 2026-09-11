/** Preserve connection credentials for every configured terminal, including inactive ones. */
export function clearLocalStorageExceptPrintCredentials(storage: Storage) {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
  const retained = new Map<string, string>()

  // Validate all configurations before deleting anything. Never silently lose credentials.
  for (const key of keys) {
    if (!key || !/^clubpos:v1:print-agent-config:[^:]+:[^:]+:[^:]+$/.test(key)) continue
    const config: unknown = JSON.parse(storage.getItem(key) ?? 'null')
    if (!config || typeof config !== 'object') throw new Error('Configuración de impresión ilegible')
    const { baseUrl, token } = config as Record<string, unknown>
    if (typeof baseUrl !== 'string' || (token != null && typeof token !== 'string')) {
      throw new Error('Configuración de impresión inválida')
    }
    retained.set(key, JSON.stringify({ baseUrl, token: token ?? null }))
  }

  // Rewrite in place so credentials are never removed, even if storage fails.
  for (const [key, value] of retained) storage.setItem(key, value)
  for (const key of keys) {
    if (key && !retained.has(key)) storage.removeItem(key)
  }
}

export async function clearLocalCache() {
  if ('caches' in window) {
    const names = await window.caches.keys()
    await Promise.all(names.map((name) => window.caches.delete(name)))
  }
  window.sessionStorage.clear()
  clearLocalStorageExceptPrintCredentials(window.localStorage)
  window.location.reload()
}
