const encoder = new TextEncoder()
const decoder = new TextDecoder()

function toBase64(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function encryptionKey(secret: string) {
  if (secret.length < 32) throw new Error('VERIFACTI_ENCRYPTION_KEY debe tener al menos 32 caracteres')
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret))
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encryptSecret(value: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(secret), encoder.encode(value))
  return `v1:${toBase64(iv)}:${toBase64(new Uint8Array(encrypted))}`
}

export async function decryptSecret(value: string, secret: string) {
  const [version, encodedIv, encodedCiphertext] = value.split(':')
  if (version !== 'v1' || !encodedIv || !encodedCiphertext) throw new Error('Secreto cifrado no valido')
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(encodedIv) },
    await encryptionKey(secret),
    fromBase64(encodedCiphertext),
  )
  return decoder.decode(decrypted)
}

export function generateWebhookSecret() {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)))
}

function hex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function webhookSignature(rawBody: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody))))
}

export function constantTimeEqual(left: string, right: string) {
  const leftBytes = encoder.encode(left.toLowerCase())
  const rightBytes = encoder.encode(right.toLowerCase())
  if (leftBytes.length !== rightBytes.length) return false
  let difference = 0
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index]
  return difference === 0
}

