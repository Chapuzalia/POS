import assert from 'node:assert/strict'
import test from 'node:test'
import { checkApplication, deployApplication, deploymentSettings } from '../scripts/deploy-coolify.mjs'

const sha = 'a'.repeat(40)
const older = 'b'.repeat(40)
const env = {
  COOLIFY_URL: 'https://coolify.example.test', COOLIFY_APPLICATION_UUID: 'app-1',
  COOLIFY_API_TOKEN: 'private', APP_VERSION: sha, SUPPORTED_APP_VERSIONS: older,
}

function applicationApi({ history = [], commit = sha, app = {} } = {}) {
  const calls = []
  const api = async (path, method = 'GET', body) => {
    calls.push({ path, method, body })
    if (method !== 'GET') return path === '/deploy'
      ? { deployments: [{ resource_uuid: 'app-1', deployment_uuid: 'deployment-1' }] } : {}
    if (path === '/applications/app-1') return {
      uuid: 'app-1', git_branch: 'main', git_repository: 'Chapuzalia/POS',
      build_pack: 'railpack', settings: { is_auto_deploy_enabled: false }, ...app,
    }
    if (path.startsWith('/deployments/applications/')) return { count: history.length, deployments: history }
    if (path === '/deployments/deployment-1') return { deployment_uuid: 'deployment-1', status: 'finished', commit }
    throw new Error(`Unexpected path ${path}`)
  }
  return { api, calls }
}

test('Coolify requires an explicit compatibility policy without a previous release', () => {
  assert.equal(deploymentSettings(env).supportedVersions, `${older},${sha}`)
  assert.equal(deploymentSettings({ ...env, SUPPORTED_APP_VERSIONS: `${sha},${sha}` }).supportedVersions, sha)
  for (const value of [undefined, '', ' ', 'HEAD', 'a'.repeat(39), `${older},invalid`]) {
    assert.throws(() => deploymentSettings({ ...env, SUPPORTED_APP_VERSIONS: value }), /SUPPORTED_APP_VERSIONS/)
  }
  assert.equal(deploymentSettings({ ...env, SUPPORTED_APP_VERSIONS: 'development' }).supportedVersions, `development,${sha}`)
})

test('same-SHA deployment forces a build and verifies the actual resulting SHA', async () => {
  const { api, calls } = applicationApi()
  const settings = deploymentSettings(env)
  assert.equal(await deployApplication(api, settings, { log: () => {} }), 'deployment-1')
  assert.deepEqual(calls.find(call => call.path === '/deploy').body, { uuid: 'app-1', force: true })
  assert.equal(calls.find(call => call.path === '/applications/app-1' && call.method === 'PATCH').body.git_commit_sha, sha)
  assert.equal(calls.find(call => call.path.endsWith('/envs/bulk')).body.data[1].value, `${older},${sha}`)
  await assert.rejects(deployApplication(applicationApi({ commit: older }).api, settings, { log: () => {} }), /different Git SHA/)
})

test('Coolify preflight retains repository, branch, build pack, auto-deploy and queue protections', async () => {
  const settings = deploymentSettings(env)
  for (const app of [
    { uuid: 'other' }, { git_repository: 'other/POS' }, { git_branch: 'other' },
    { build_pack: 'dockerfile' }, { settings: { is_auto_deploy_enabled: true } },
  ]) await assert.rejects(checkApplication(applicationApi({ app }).api, settings))
  for (const status of ['queued', 'in_progress', 'unknown']) {
    await assert.rejects(checkApplication(applicationApi({ history: [{ status }] }).api, settings))
  }
})
