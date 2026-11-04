#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const statuses = new Set([
  'queued', 'preflight', 'awaiting_approval', 'backing_up', 'migrating', 'deploying_edge',
  'deploying_application', 'verifying', 'success', 'failed', 'interrupted', 'cancelled',
])

export function requestSettings(env) {
  const url = new URL(env.DEPLOY_CONTROLLER_URL)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Configure DEPLOY_CONTROLLER_URL as a plain HTTPS origin.')
  const origin = url.origin
  const project = env.DEPLOY_PROJECT
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(project ?? '')) throw new Error('Configure DEPLOY_PROJECT.')
  const environment = env.DEPLOY_ENVIRONMENT
  if (environment !== 'production' && environment !== 'staging') throw new Error('DEPLOY_ENVIRONMENT must be production or staging.')
  const branch = env.DEPLOY_BRANCH, workflow = env.DEPLOY_WORKFLOW, repository = env.DEPLOY_REPOSITORY
  const events = (env.DEPLOY_ALLOWED_EVENTS ?? 'push').split(',')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') ||
      !/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/.test(branch ?? '') || branch.includes('..') ||
      !/^[A-Za-z0-9_-]+\.ya?ml$/.test(workflow ?? '') || events.some(event => !['push', 'workflow_dispatch'].includes(event)) ||
      env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== `refs/heads/${branch}` ||
      env.GITHUB_WORKFLOW_REF !== `${repository}/.github/workflows/${workflow}@refs/heads/${branch}` || !events.includes(env.GITHUB_EVENT_NAME)) {
    throw new Error('Deployment requests must come from the authorized repository, workflow, branch and event.')
  }
  if (!/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') ||
      !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) {
    throw new Error('A full commit SHA, GitHub run ID and run attempt are required.')
  }
  let oidcUrl
  try { oidcUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL) } catch { throw new Error('GitHub OIDC is unavailable.') }
  if (oidcUrl.protocol !== 'https:' || oidcUrl.username || oidcUrl.password || oidcUrl.hash ||
      !(oidcUrl.hostname === 'actions.githubusercontent.com' || oidcUrl.hostname.endsWith('.actions.githubusercontent.com'))) {
    throw new Error('Invalid GitHub OIDC token endpoint.')
  }
  oidcUrl.searchParams.set('audience', origin)
  for (const key of ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'CF_ACCESS_CLIENT_ID', 'CF_ACCESS_CLIENT_SECRET']) {
    if (!env[key]?.trim()) throw new Error(`Configure ${key}.`)
  }
  return {
    origin, project, environment, commit: env.GITHUB_SHA,
    requestId: `${environment}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    oidcUrl: oidcUrl.href, oidcRequestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    accessId: env.CF_ACCESS_CLIENT_ID, accessSecret: env.CF_ACCESS_CLIENT_SECRET,
  }
}

async function fetchJson(fetchImpl, url, options, label) {
  let response
  try {
    response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) })
  } catch { throw new Error(`${label} request failed. Inspect the private controller before retrying.`) }
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`)
  try {
    const body = await response.text()
    if (body.length > 65_536) throw new Error('oversized')
    return JSON.parse(body)
  } catch { throw new Error(`${label} returned an invalid JSON response.`) }
}

export async function requestDeployment(settings, {
  fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, log = console.log, timeoutMs = 75 * 60_000,
} = {}) {
  async function controllerRequest(path, method, body) {
    // GitHub OIDC tokens are short-lived. Each poll obtains a fresh token;
    // authorization on the host binds it to the same run and run attempt.
    const token = await fetchJson(fetchImpl, settings.oidcUrl, {
      method: 'GET', headers: { Authorization: `Bearer ${settings.oidcRequestToken}`, Accept: 'application/json' },
    }, 'GitHub OIDC')
    if (typeof token?.value !== 'string' || !token.value.trim()) throw new Error('GitHub OIDC returned no token.')
    return fetchJson(fetchImpl, `${settings.origin}${path}`, {
      method, headers: {
        Authorization: `Bearer ${token.value}`, 'CF-Access-Client-Id': settings.accessId,
        'CF-Access-Client-Secret': settings.accessSecret,
        'X-Deploy-Client-Id': settings.accessId, 'X-Deploy-Client-Secret': settings.accessSecret,
        Accept: 'application/json', 'Content-Type': 'application/json',
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, 'Deployment controller')
  }

  const deadline = now() + timeoutMs
  let deployment = await controllerRequest('/deploy', 'POST', {
    project: settings.project, environment: settings.environment, commit: settings.commit, request_id: settings.requestId,
  })
  const id = deployment?.id
  if (!uuidPattern.test(id ?? '')) throw new Error('Controller returned an invalid deployment ID.')
  let lastStatus
  while (now() < deadline) {
    if (deployment.id !== id || deployment.project !== settings.project || deployment.environment !== settings.environment || deployment.commit !== settings.commit ||
        (deployment.request_id !== undefined && deployment.request_id !== settings.requestId) || !statuses.has(deployment.status)) {
      throw new Error('Controller returned an invalid deployment identity or status.')
    }
    if (deployment.status !== lastStatus) {
      // Do not print arbitrary response fields, controller errors or diagnostics.
      log(`Deployment ${id}: ${deployment.status}`)
      lastStatus = deployment.status
    }
    if (deployment.status === 'success') return deployment
    if (deployment.status === 'cancelled') throw new Error(`Deployment ${id} cancelled before applying SQL.`)
    if (deployment.status === 'failed') throw new Error(`Deployment ${id} failed. Inspect private controller events.`)
    if (deployment.status === 'interrupted') throw new Error(`Deployment ${id} interrupted. Manual reconciliation is required before retrying.`)
    await sleep(10_000)
    deployment = await controllerRequest(`/deployments/${id}`, 'GET')
  }
  throw new Error(`Timed out waiting for deployment ${id}. It may still be running; inspect the controller before retrying.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve().then(() => {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/request-deployment.mjs')
    return requestDeployment(requestSettings(process.env))
  }).catch(error => { console.error(error.message); process.exitCode = 1 })
}
