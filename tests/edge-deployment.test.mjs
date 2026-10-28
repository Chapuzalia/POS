import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import test from 'node:test'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'

async function router({ jwt = false, tokenValid = true, failWorker = false } = {}) {
  const commit = 'a'.repeat(40), calls = [], verified = []
  const release = { commit, functions: {
    example: { verify_jwt: jwt, import_map: '/home/deno/functions/deno.json' },
    'verifacti-webhook': { verify_jwt: false, import_map: null },
  } }
  const source = (await readFile(new URL('../scripts/edge-router.ts', import.meta.url), 'utf8'))
    .replace(/^import \* as jose from .*$/m, '')
  const compiled = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext } }).outputText
  let handler
  const Deno = {
    readTextFile: async () => JSON.stringify(release), serve: callback => { handler = callback },
    env: { get: key => ({ JWT_SECRET: 'secret', SUPABASE_JWKS: '{"keys":[]}' })[key], toObject: () => ({ SECRET: 'private' }) },
  }
  const jose = {
    createLocalJWKSet: () => 'public-keys',
    decodeProtectedHeader: token => ({ alg: token }),
    jwtVerify: async (...args) => { verified.push(args); if (!tokenValid) throw new Error('invalid secret JWT') },
  }
  const EdgeRuntime = { userWorkers: { create: async options => {
    calls.push(options)
    if (failWorker) throw new Error('sensitive diagnostic')
    return { fetch: async () => new Response(null, { status: 204 }) }
  } } }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  await new AsyncFunction('Deno', 'EdgeRuntime', 'jose', compiled)(Deno, EdgeRuntime, jose)
  return { handler, calls, verified, commit }
}

test('health exposes the deployed SHA and unknown/private paths never start a worker', async () => {
  const { handler, calls, commit } = await router()
  assert.deepEqual(await (await handler(new Request('http://edge/_pos_health'))).json(), { commit })
  for (const path of ['/main', '/_shared', '/missing', '/constructor', '/toString', '/']) {
    assert.equal((await handler(new Request('http://edge' + path))).status, 404)
  }
  assert.equal(calls.length, 0)
})

test('JWT verification supports the existing signing algorithms and rejects invalid/unsupported tokens', async () => {
  for (const alg of ['HS256', 'ES256', 'RS256']) {
    const { handler, verified } = await router({ jwt: true })
    assert.equal((await handler(new Request('http://edge/example', { headers: { Authorization: `Bearer ${alg}` } }))).status, 204)
    assert.equal(verified.length, 1)
  }
  for (const [token, tokenValid] of [['HS256', false], ['none', true], ['HS512', true]]) {
    const { handler, calls } = await router({ jwt: true, tokenValid })
    assert.equal((await handler(new Request('http://edge/example', { headers: { Authorization: `Bearer ${token}` } }))).status, 401)
    assert.equal(calls.length, 0)
  }
})
