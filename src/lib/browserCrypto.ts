// HTTP development hosts do not expose randomUUID, but still offer getRandomValues.
// Install before the app loads so existing UUID callers keep the same v4 contract.
export function installRandomUuidFallback(cryptoProvider: Crypto = globalThis.crypto) {
  if (!cryptoProvider || typeof cryptoProvider.randomUUID === 'function') return

  cryptoProvider.randomUUID = () => {
    const bytes = cryptoProvider.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
}

installRandomUuidFallback()
