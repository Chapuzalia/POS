import assert from 'node:assert/strict'
import test from 'node:test'
import { requestDeployment, requestSettings } from '../scripts/request-deployment.mjs'

const sha = 'a'.repeat(40)
const id = '12345678-1234-4234-8234-123456789012'
const env = {
  DEPLOY_ENVIRONMENT: 'production', GITHUB_REPOSITORY: 'Chapuzalia/POS',
  GITHUB_SHA: sha, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push',
  GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2',
  GITHUB_WORKFLOW_REF: 'Chapuzalia/POS/.github/workflows/production.yml@refs/heads/main',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/idtoken?api-version=2.0',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'github-secret',
  CF_ACCESS_CLIENT_ID: 'access-id', CF_ACCESS_CLIENT_SECRET: 'access-secret',
}

function controller(statuses = ['queued', 'preflight', 'success']) {
  const calls = []
  let tokenNumber = 0, statusIndex = 0
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), ...init })
    if (new URL(url).hostname === 'pipelines.actions.githubusercontent.com') {
      assert.equal(new URL(url).searchParams.get('audience'), 'https://deploy.alteilsolutions.com')
      assert.equal(init.headers.Authorization, 'Bearer github-secret')
      return Response.json({ value: `oidc-${++tokenNumber}` })
    }
    assert.equal(init.headers.Authorization, `Bearer oidc-${tokenNumber}`)
    assert.equal(init.headers['CF-Access-Client-Id'], 'access-id')
    assert.equal(init.headers['CF-Access-Client-Secret'], 'access-secret')
    assert.equal(init.headers['X-Tickit-Deploy-Client-Id'], 'access-id')
    assert.equal(init.headers['X-Tickit-Deploy-Client-Secret'], 'access-secret')
    return Response.json({ id, status: statuses[statusIndex++], environment: 'production', commit: sha, request_id: 'production-42-2' })
  }
  return { calls, fetchImpl }
}

test('requester sends only the release identity and refreshes OIDC for every poll', async () => {
  const { calls, fetchImpl } = controller()
  const result = await requestDeployment(requestSettings(env), { fetchImpl, sleep: async () => {}, log: () => {} })
  assert.equal(result.status, 'success')
  const requests = calls.filter(call => call.url.startsWith('https://deploy.alteilsolutions.com'))
  assert.deepEqual(requests.map(call => [call.url, call.method]), [
    ['https://deploy.alteilsolutions.com/deploy', 'POST'],
    [`https://deploy.alteilsolutions.com/deployments/${id}`, 'GET'],
    [`https://deploy.alteilsolutions.com/deployments/${id}`, 'GET'],
  ])
  assert.deepEqual(JSON.parse(requests[0].body), { environment: 'production', commit: sha, request_id: 'production-42-2' })
  assert.equal(calls.length, 6)
  assert.ok(calls.every(call => call.redirect === 'error'))
})

test('rerunning the same SHA changes identity by run attempt, never a previous SHA', () => {
  assert.equal(requestSettings(env).requestId, 'production-42-2')
  assert.equal(requestSettings({ ...env, GITHUB_RUN_ATTEMPT: '3' }).requestId, 'production-42-3')
  assert.equal(requestSettings({ ...env, DEPLOY_ENVIRONMENT: 'staging', GITHUB_REF: 'refs/heads/Staging',
    GITHUB_WORKFLOW_REF: 'Chapuzalia/POS/.github/workflows/staging.yml@refs/heads/Staging', GITHUB_EVENT_NAME: 'workflow_dispatch' }).environment, 'staging')
})

test('requester follows every private deployment phase with refreshed credentials', async () => {
  const phases = ['queued', 'preflight', 'awaiting_approval', 'backing_up', 'migrating', 'deploying_edge', 'deploying_application', 'verifying', 'success']
  const { calls, fetchImpl } = controller(phases)
  const logs = []
  await requestDeployment(requestSettings(env), { fetchImpl, sleep: async () => {}, log: value => logs.push(value) })
  assert.deepEqual(logs, phases.map(phase => `Deployment ${id}: ${phase}`))
  assert.equal(calls.length, phases.length * 2)
})

test('requester rejects invalid identities and credentials before requesting deployment', () => {
  for (const patch of [
    { DEPLOY_ENVIRONMENT: 'other' }, { GITHUB_REPOSITORY: 'other/POS' }, { GITHUB_SHA: 'HEAD' },
    { GITHUB_REF: 'refs/heads/Staging' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_RUN_ID: '' }, { GITHUB_RUN_ATTEMPT: '0' },
    { GITHUB_WORKFLOW_REF: 'Chapuzalia/POS/.github/workflows/other.yml@refs/heads/main' },
    { CF_ACCESS_CLIENT_SECRET: '' }, { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.test/token' },
  ]) assert.throws(() => requestSettings({ ...env, ...patch }))
})

test('failed and interrupted deployments fail CI without printing private controller results', async () => {
  for (const status of ['failed', 'interrupted', 'cancelled']) {
    const { fetchImpl } = controller(['queued', status])
    const logs = []
    await assert.rejects(requestDeployment(requestSettings(env), { fetchImpl, sleep: async () => {}, log: value => logs.push(value) }), /failed|interrupted|cancelled/)
    assert.ok(logs.every(value => !value.includes('secret') && !value.includes('oidc')))
  }
})

test('requester never logs credentials or reflects private authentication failures', async () => {
  for (const status of [401, 403]) {
    const logs = []
    const fetchImpl = async url => new URL(url).hostname === 'pipelines.actions.githubusercontent.com'
      ? Response.json({ value: 'private-oidc-token' })
      : Response.json({ error: 'access-id access-secret github-secret private-oidc-token' }, { status })
    await assert.rejects(requestDeployment(requestSettings(env), { fetchImpl, log: value => logs.push(value) }),
      { message: `Deployment controller returned HTTP ${status}.` })
    assert.deepEqual(logs, [])
  }
})

test('requester fails closed for mismatched identities, malformed status and HTTP errors', async () => {
  for (const result of [
    { id, status: 'success', commit: 'b'.repeat(40), environment: 'production' },
    { id, status: 'success', commit: sha, environment: 'staging' },
    { id, status: 'unexpected', commit: sha, environment: 'production' },
    { id: '../private', status: 'queued', commit: sha, environment: 'production' },
  ]) {
    const fetchImpl = async url => new URL(url).hostname === 'pipelines.actions.githubusercontent.com'
      ? Response.json({ value: 'oidc' }) : Response.json(result)
    await assert.rejects(requestDeployment(requestSettings(env), { fetchImpl, log: () => {} }))
  }
  const fetchImpl = async url => new URL(url).hostname === 'pipelines.actions.githubusercontent.com'
    ? Response.json({ value: 'oidc' }) : new Response('private diagnostics', { status: 502 })
  await assert.rejects(requestDeployment(requestSettings(env), { fetchImpl, log: () => {} }), error => !error.message.includes('private diagnostics'))
})

test('ambiguous network errors and polling timeouts never issue a second deployment POST', async () => {
  let posts = 0
  const failingFetch = async url => {
    if (new URL(url).hostname === 'pipelines.actions.githubusercontent.com') return Response.json({ value: 'oidc' })
    posts++
    throw new Error('private transport details with secrets')
  }
  await assert.rejects(requestDeployment(requestSettings(env), { fetchImpl: failingFetch, log: () => {} }), /request failed/)
  assert.equal(posts, 1)

  const { calls, fetchImpl } = controller(['queued', 'preflight'])
  let time = 0
  await assert.rejects(requestDeployment(requestSettings(env), {
    fetchImpl, log: () => {}, now: () => time, timeoutMs: 1,
    sleep: async () => { time = 2 },
  }), /may still be running/)
  assert.equal(calls.filter(call => call.method === 'POST').length, 1)
})

test('polling rejects a deployment ID substituted after an accepted POST', async () => {
  let request = 0
  const fetchImpl = async url => {
    if (new URL(url).hostname === 'pipelines.actions.githubusercontent.com') return Response.json({ value: 'oidc' })
    request++
    return Response.json({ id: request === 1 ? id : '22345678-1234-4234-8234-123456789012',
      status: request === 1 ? 'queued' : 'success', environment: 'production', commit: sha })
  }
  await assert.rejects(requestDeployment(requestSettings(env), { fetchImpl, sleep: async () => {}, log: () => {} }), /invalid deployment identity/)
})
