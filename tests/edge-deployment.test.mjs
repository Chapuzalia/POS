import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import { prepareEdgeFunctions } from '../scripts/prepare-edge-functions.mjs'

test('packages the real functions, shared helpers and reviewed router without editing sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'edge-package-'))
  try {
    const source = new URL('../supabase/functions/', import.meta.url)
    await prepareEdgeFunctions(fileURLToPath(source), join(directory, 'functions'))
    assert.equal(await readFile(join(directory, 'functions/main/index.ts'), 'utf8'),
      await readFile(new URL('../scripts/edge-router.ts', import.meta.url), 'utf8'))
    for (const file of ['production-agent/index.ts', 'manage-pos-users/index.ts', '_shared/supplier-documents/core.ts', 'deno.json', 'deno.lock']) {
      assert.equal(await readFile(join(directory, 'functions', file), 'utf8'), await readFile(new URL(file, source), 'utf8'))
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('rejects environment files, reserved routers and unexpected artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'edge-rejected-'))
  try {
    for (const [index, file] of ['.env', 'secret.pem', 'pos-release.json', 'main', 'node_modules'].entries()) {
      const source = join(directory, `source-${index}`)
      await mkdir(source)
      await writeFile(join(source, file), 'must not deploy')
      await assert.rejects(prepareEdgeFunctions(source, join(directory, `output-${index}`)), /Unsupported|reserved/)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

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

test('config applies per-function JWT checks and import maps; OPTIONS compiles without POSTs', async () => {
  const { handler, calls, commit } = await router({ jwt: true })
  assert.equal((await handler(new Request('http://edge/example'))).status, 401)
  assert.equal(calls.length, 0)
  const response = await handler(new Request('http://edge/example', { method: 'OPTIONS' }))
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('x-pos-edge-release'), commit)
  assert.equal(calls[0].importMapPath, '/home/deno/functions/deno.json')
  assert.equal(calls[0].servicePath, '/home/deno/functions/example')
  assert.deepEqual(calls[0].envVars, [['SECRET', 'private']])
  assert.equal((await handler(new Request('http://edge/verifacti-webhook', { method: 'OPTIONS' }))).status, 204)
  assert.equal(calls[1].importMapPath, null)
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

test('worker boot failures cannot pass release checks or expose private errors', async () => {
  const { handler } = await router({ failWorker: true })
  const response = await handler(new Request('http://edge/example', { method: 'OPTIONS' }))
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('x-pos-edge-release'), null)
  assert.deepEqual(await response.json(), { msg: 'Function unavailable' })
})

test('main and Staging use the same checked protocol-4 transport before the frontend', async () => {
  for (const name of ['production', 'staging']) {
    const workflow = await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8')
    const apply = workflow.indexOf('DEPLOY_OPERATION: apply')
    assert.ok(workflow.indexOf('DEPLOY_OPERATION: check') < apply)
    assert.ok(apply < workflow.lastIndexOf('run: node scripts/deploy-coolify.mjs'))
    assert.match(workflow, /run: bash scripts\/send-pos-migrations.sh/)
  }
  const transport = await readFile(new URL('../scripts/send-pos-migrations.sh', import.meta.url), 'utf8')
  assert.match(transport, /protocol: 4/)
  assert.match(transport, /deployment.json migrations functions config.toml/)
})
