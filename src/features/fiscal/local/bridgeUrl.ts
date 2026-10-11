/** Public origins only; plain HTTP is reserved for the local development machine. */
export function isFiscalBridgeOrigin(value: string): boolean {
  if (value.length > 255 || /\s/.test(value)) return false
  const https = /^https:\/\/[^/?#@]+\/?$/.test(value)
  const loopback = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?\/?$/.test(value)
  if (!https && !loopback) return false
  try {
    const url = new URL(value)
    return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
  } catch {
    return false
  }
}
