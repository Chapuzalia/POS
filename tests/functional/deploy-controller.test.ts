import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authorize, GitHubVerifier, HttpError, parseDeployment } from '../../apps/deploy-controller/src/auth.ts'
import { DeploymentStore } from '../../apps/deploy-controller/src/store.ts'
import { boundedServer, workerHandler } from '../../apps/deploy-controller/src/http.ts'

const sha = 'a'.repeat(40)
const secret = 'test-service-secret'
const policy = {
  enabled: true, clientId: 'stage-id', clientSecretSha256: createHash('sha256').update(secret).digest('hex'),
}
const identity = { environment: 'staging' as const, commit: sha, run: '42:1', jti: 'token-id', expires: Math.floor(Date.now() / 1000) + 600 }
const payload = { environment: 'staging' as const, commit: sha, request_id: 'request-1' }
const directories: string[] = []
const stores: DeploymentStore[] = []
afterEach(() => { stores.forEach(s => s.close()); stores.length = 0; directories.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })) })
function store() {
  const dir = mkdtempSync(join(tmpdir(), 'tickit-controller-')); directories.push(dir)
  const result = new DeploymentStore(join(dir, 'state.sqlite')); stores.push(result); return result
}
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
function jwt(overrides: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({
    iss: 'https://token.actions.githubusercontent.com', aud: 'https://deploy.alteilsolutions.com',
    iat: 990, nbf: 990, exp: 1300, jti: 'test-jti', repository: 'Chapuzalia/POS', repository_id: '123',
    ref: 'refs/heads/Staging', sha, workflow_sha: sha,
    workflow_ref: 'Chapuzalia/POS/.github/workflows/staging.yml@refs/heads/Staging',
    event_name: 'push', run_id: '42', run_attempt: '1', ...overrides,
  })).toString('base64url')
  return `${header}.${body}.${sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url')}`
}
function verifier() {
  return new GitHubVerifier('https://deploy.alteilsolutions.com', '123', async () => ({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' }] }), () => 1000)
}
describe('deployment identity', () => {
  it('verifies signed GitHub identity and environment service credentials', async () => {
    const result = await authorize({ authorization: `Bearer ${jwt()}`, 'cf-access-client-id': policy.clientId, 'cf-access-client-secret': secret }, payload, { staging: policy }, verifier())
    expect(result).toMatchObject({ environment: 'staging', commit: sha, run: '42:1' })
  })
  it.each([
    { iss: 'https://attacker' }, { aud: 'other' }, { exp: 999 }, { nbf: 1001 },
    { repository: 'fork/POS' }, { repository_id: '456' }, { event_name: 'pull_request' },
    { ref: 'refs/heads/main' }, { workflow_ref: 'Chapuzalia/POS/.github/workflows/evil.yml@refs/heads/Staging' },
    { workflow_sha: 'b'.repeat(40) }, { sha: 'invalid' },
  ])('fails closed on untrusted claims %j', async overrides => {
    await expect(verifier().verify(jwt(overrides), payload)).rejects.toBeInstanceOf(HttpError)
  })
  it('rejects tampering, missing credentials, disabled environment and cross-environment identity', async () => {
    await expect(verifier().verify(jwt().slice(0, -8) + 'aaaaaaaa', payload)).rejects.toBeInstanceOf(HttpError)
    for (const headers of [{}, { authorization: `Bearer ${jwt()}`, 'cf-access-client-id': policy.clientId, 'cf-access-client-secret': 'wrong' }]) {
      await expect(authorize(headers, payload, { staging: policy }, verifier())).rejects.toBeInstanceOf(HttpError)
    }
    await expect(verifier().verify(jwt(), { ...payload, environment: 'production' })).rejects.toBeInstanceOf(HttpError)
    await expect(authorize({ authorization: `Bearer ${jwt()}`, 'cf-access-client-id': policy.clientId, 'cf-access-client-secret': secret }, payload, { staging: { ...policy, enabled: false } }, verifier())).rejects.toBeInstanceOf(HttpError)
  })
  it('rejects unknown fields, malformed SHAs, oversized IDs and invalid environments', () => {
    for (const value of [{ ...payload, command: 'id' }, { ...payload, commit: '-x' }, { ...payload, request_id: 'x'.repeat(129) }, { ...payload, environment: 'preview' }]) expect(() => parseDeployment(value)).toThrow(HttpError)
  })
})
it('serves authenticated deployment API with strict paths, payload limits and run-scoped polling', async () => {
  const db = store()
  const server = boundedServer(workerHandler(db, verifier(), { staging: policy }, () => {}))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const headers = { authorization: `Bearer ${jwt()}`, 'cf-access-client-id': policy.clientId, 'cf-access-client-secret': secret, 'content-type': 'application/json' }
  try {
    expect((await fetch(`${base}/health`)).status).toBe(200)
    expect((await fetch(`${base}/deploy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).status).toBe(403)
    const posted = await fetch(`${base}/deploy`, { method: 'POST', headers, body: JSON.stringify(payload) })
    expect(posted.status).toBe(202)
    const result = await posted.json() as { id: string }
    expect((await fetch(`${base}/deployments/${result.id}`)).status).toBe(403)
    const resultResponse = await fetch(`${base}/deployments/${result.id}`, { headers })
    expect(resultResponse.status).toBe(200)
    expect(await resultResponse.json()).toMatchObject({ commit: sha, status: 'queued' })
    expect((await fetch(`${base}/deployments/${result.id}`, { headers: { ...headers, authorization: `Bearer ${jwt({ run_id: '43' })}` } })).status).toBe(404)
    expect((await fetch(`${base}/deploy`, { method: 'POST', headers, body: 'x'.repeat(4097) })).status).toBe(413)
    expect((await fetch(`${base}/deploy?command=sh`, { method: 'POST', headers, body: '{}' })).status).toBe(404)
    expect((await fetch(`${base}/deploy`, { method: 'POST', headers, body: '{' })).status).toBe(400)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
describe('durable deployments', () => {
  it('retains admitted PWA versions across A to B to C until explicit retirement', () => {
    const db = store(), a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40)
    expect(db.admitVersions('staging', a, b)).toBe(`${a},${b}`)
    expect(db.admitVersions('staging', a, c)).toBe(`${a},${b},${c}`)
    expect(db.admitVersions('staging', a, c, [b])).toBe(`${a},${c}`)
    expect(() => db.admitVersions('staging', a, b, [b])).toThrow()
  })
  it('creates independent releases for same SHA and deduplicates only exact request retries', () => {
    const db = store()
    const first = db.enqueue(payload, identity)
    expect(db.enqueue(payload, identity).id).toBe(first.id)
    const second = db.enqueue({ ...payload, request_id: 'request-2' }, { ...identity, jti: 'token-2' })
    expect(second.id).not.toBe(first.id)
    expect(db.claim()?.id).toBe(first.id)
    expect(db.claim()).toBeUndefined()
    db.transition(first.id, 'success')
    expect(db.claim()?.id).toBe(second.id)
  })
  it('rejects token replay for another mutation and conflicting retry payloads', () => {
    const db = store(); db.enqueue(payload, identity)
    expect(() => db.enqueue({ ...payload, request_id: 'other' }, identity)).toThrow(HttpError)
    expect(() => db.enqueue({ ...payload, commit: 'b'.repeat(40) }, { ...identity, commit: 'b'.repeat(40), jti: 'other' })).toThrow(HttpError)
  })
  it('recovers interrupted execution, blocks its environment and requires explicit reconciliation', () => {
    const db = store(); const first = db.enqueue(payload, identity); db.claim()
    db.enqueue({ ...payload, request_id: 'request-2' }, { ...identity, jti: 'token-2' })
    db.recover()
    expect(db.get(first.id)?.status).toBe('interrupted')
    expect(db.claim()).toBeUndefined()
    db.reconcile(first.id)
    expect(db.claim()?.request_id).toBe('request-2')
  })
  it('persists queue across connections and scopes status access to authenticated run', () => {
    const db = store(); const first = db.enqueue(payload, identity)
    expect(db.authorizedGet(first.id, identity).id).toBe(first.id)
    expect(() => db.authorizedGet(first.id, { ...identity, run: '43:1' })).toThrow(HttpError)
    const other = new DeploymentStore(db.path); stores.push(other)
    expect(other.get(first.id)?.status).toBe('queued')
  })
})
