import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import test from 'node:test'
import { installRandomUuidFallback } from '../src/lib/browserCrypto.ts'

test('conserva el generador UUID nativo cuando está disponible', () => {
  const nativeUuid = () => webcrypto.randomUUID()
  const provider = {
    randomUUID: nativeUuid,
    getRandomValues() { throw new Error('El fallback no debe ejecutarse.') },
  }
  installRandomUuidFallback(provider)
  assert.equal(provider.randomUUID, nativeUuid)
})

test('genera UUID v4 válidos sin randomUUID usando el CSPRNG del navegador', () => {
  let randomCalls = 0
  const provider = {
    getRandomValues(bytes) {
      assert.equal(this, provider)
      randomCalls++
      return webcrypto.getRandomValues(bytes)
    },
  }
  installRandomUuidFallback(provider)
  const ids = new Set(Array.from({ length: 100 }, () => provider.randomUUID()))
  assert.equal(ids.size, 100)
  assert.equal(randomCalls, 100)
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('fija la versión y variante de UUID incluso con bytes extremos', () => {
  for (const [byte, expected] of [
    [0, '00000000-0000-4000-8000-000000000000'],
    [255, 'ffffffff-ffff-4fff-bfff-ffffffffffff'],
  ]) {
    const provider = { getRandomValues: (bytes) => bytes.fill(byte) }
    installRandomUuidFallback(provider)
    assert.equal(provider.randomUUID(), expected)
  }
})

test('propaga un fallo del generador seguro sin sustituirlo por aleatoriedad débil', () => {
  const provider = { getRandomValues() { throw new Error('CSPRNG unavailable') } }
  installRandomUuidFallback(provider)
  assert.throws(() => provider.randomUUID(), /CSPRNG unavailable/)
})
