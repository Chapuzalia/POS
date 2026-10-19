import assert from 'node:assert/strict'
import test from 'node:test'
import { apiClient, checkApplication, deployApplication, deploymentSettings } from '../scripts/deploy-coolify.mjs'

const env = {
  COOLIFY_URL: 'https://coolify.example.com', COOLIFY_API_TOKEN: 'private-token',
  COOLIFY_APPLICATION_UUID: 'frontend-main', APP_VERSION: 'a'.repeat(40), PREVIOUS_APP_VERSION: 'b'.repeat(40),
}
const settings = deploymentSettings(env)
const app = { id: 17, uuid: settings.uuid, git_branch: 'main', git_repository: 'Chapuzalia/POS', build_pack: 'railpack', settings: { is_auto_deploy_enabled: false } }

function fakeApi({ application = app, running = [], statuses = ['queued', 'in_progress', 'finished'], commit = settings.sha } = {}) {
  const calls = []
  const api = async (path, method = 'GET', body) => {
    calls.push({ path, method, body })
    if (method === 'PATCH') return {}
    if (path === `/applications/${settings.uuid}`) return application
    if (path === '/deployments') return running
    if (path === '/deploy') return { deployments: [{ resource_uuid: settings.uuid, deployment_uuid: 'deploy-main' }] }
    if (path === '/deployments/deploy-main') return { deployment_uuid: 'deploy-main', status: statuses.shift() ?? 'queued', commit }
    throw new Error(`Unexpected call ${path}`)
  }
  return { api, calls }
}

test('requires HTTPS, explicit versions and configuration without embedded credentials', () => {
  for (const COOLIFY_URL of ['http://coolify.example.com', 'https://token@coolify.example.com', 'https://coolify.example.com/api/v1', 'https://coolify.example.com/?token=secret']) {
    assert.throws(() => deploymentSettings({ ...env, COOLIFY_URL }))
  }
  assert.throws(() => deploymentSettings({ ...env, APP_VERSION: 'HEAD' }))
  assert.throws(() => deploymentSettings({ ...env, DEPLOY_BRANCH: 'staging' }))
  assert.equal(settings.supportedVersions, `${env.PREVIOUS_APP_VERSION},${env.APP_VERSION}`)
})

test('the initial rollout preserves development clients while pinning the new release to a Git SHA', () => {
  const bootstrap = deploymentSettings({ ...env, PREVIOUS_APP_VERSION: 'development' })
  assert.equal(bootstrap.supportedVersions, `development,${env.APP_VERSION}`)
  assert.throws(() => deploymentSettings({ ...env, APP_VERSION: 'development' }))
  assert.throws(() => deploymentSettings({ ...env, PREVIOUS_APP_VERSION: 'development,other' }))
})

test('Staging checks accept only its own application branch and preserve the main default', async () => {
  assert.equal(settings.branch, 'main')
  const staging = deploymentSettings({ ...env, DEPLOY_BRANCH: 'Staging', COOLIFY_APPLICATION_UUID: 'frontend-staging' })
  const calls = []
  const api = async (path, method = 'GET') => {
    calls.push({ path, method })
    return path === '/deployments' ? [] : { ...app, uuid: staging.uuid, git_branch: 'Staging' }
  }
  await checkApplication(api, staging)
  assert.ok(calls.every(call => call.method === 'GET'))
  const wrongBranchApi = async () => ({ ...app, uuid: staging.uuid, git_branch: 'main' })
  await assert.rejects(checkApplication(wrongBranchApi, staging), /on Staging/)
  await assert.rejects(checkApplication(api, { ...staging, branch: 'main' }), /on main/)
})

test('preflight refuses auto-deploy, wrong branch/repository and a concurrent deployment without writes', async () => {
  for (const application of [
    { ...app, settings: { is_auto_deploy_enabled: true } }, { ...app, settings: {} },
    { ...app, git_branch: 'Staging' }, { ...app, git_repository: 'another/repository' },
  ]) {
    const { api, calls } = fakeApi({ application })
    await assert.rejects(checkApplication(api, settings))
    assert.ok(calls.every(call => call.method === 'GET'))
  }
  const { api } = fakeApi({ running: [{ application_id: 17, status: 'queued' }] })
  await assert.rejects(checkApplication(api, settings), /queued or running/)
})

test('pins the exact SHA and build variables before queueing, then waits for finished', async () => {
  const { api, calls } = fakeApi()
  const log = []
  await deployApplication(api, settings, { sleep: async () => {}, log: value => log.push(value) })
  const writes = calls.filter(call => call.method !== 'GET')
  assert.deepEqual(writes.map(call => call.method), ['PATCH', 'PATCH', 'POST'])
  assert.deepEqual(writes[0].body, { git_commit_sha: settings.sha, is_auto_deploy_enabled: false })
  assert.equal(writes[1].body.data[0].key, 'APP_VERSION')
  assert.equal(writes[1].body.data[0].value, settings.sha)
  assert.equal(writes[1].body.data[1].value, settings.supportedVersions)
  assert.ok(writes[1].body.data.every(item => item.is_buildtime && !item.is_runtime && !item.is_preview))
  assert.deepEqual(writes[2].body, { uuid: settings.uuid, force: false })
  assert.equal(log.length, 3)
  assert.match(log.at(-1), /finished/)
})

test('rejects wrong commit, failed/cancelled/unknown states, and a deployment timeout', async () => {
  for (const options of [
    { statuses: ['finished'], commit: 'c'.repeat(40) }, { statuses: ['failed'] },
    { statuses: ['cancelled-by-user'] }, { statuses: ['unexpected'] },
  ]) {
    const { api } = fakeApi(options)
    await assert.rejects(deployApplication(api, settings, { sleep: async () => {}, log: () => {} }))
  }
  const { api, calls } = fakeApi({ statuses: ['queued'] })
  let time = 0
  await assert.rejects(deployApplication(api, settings, {
    timeoutMs: 20, now: () => time, sleep: async () => { time += 30 }, log: () => {},
  }), /Timed out/)
  assert.equal(calls.filter(call => call.path === '/deploy').length, 1)
})

test('API does not follow redirects or expose response bodies and credentials in errors', async () => {
  const api = apiClient(settings, async (_url, options) => {
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, `Bearer ${env.COOLIFY_API_TOKEN}`)
    return { ok: false, status: 403, json: async () => ({ token: 'private-token' }) }
  })
  await assert.rejects(api('/deploy', 'POST', {}), error => error.message.includes('403') && !error.message.includes('private-token'))
})
