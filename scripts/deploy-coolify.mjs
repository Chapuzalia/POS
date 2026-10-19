#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

const shaPattern = /^[0-9a-f]{40}$/
const uuidPattern = /^[a-zA-Z0-9_-]+$/
const activeStatuses = new Set(['queued', 'in_progress'])

export function deploymentSettings(env) {
  let origin
  try { origin = new URL(env.COOLIFY_URL) } catch { throw new Error('Configure COOLIFY_URL with the HTTPS origin of your Coolify instance.') }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('COOLIFY_URL must be an HTTPS origin without credentials, path or query.')
  }
  if (!uuidPattern.test(env.COOLIFY_APPLICATION_UUID ?? '') || !env.COOLIFY_API_TOKEN?.trim()) {
    throw new Error('Configure the Coolify application UUID and API token.')
  }
  if (!shaPattern.test(env.APP_VERSION ?? '') || (!shaPattern.test(env.PREVIOUS_APP_VERSION ?? '') && env.PREVIOUS_APP_VERSION !== 'development')) {
    throw new Error('The current version must be a full Git SHA; the previous version must be a full Git SHA or development for the initial rollout.')
  }
  const branch = env.DEPLOY_BRANCH ?? 'main'
  if (branch !== 'main' && branch !== 'Staging') throw new Error('DEPLOY_BRANCH must be main or Staging (case sensitive).')
  return {
    base: `${origin.origin}/api/v1`, token: env.COOLIFY_API_TOKEN,
    uuid: env.COOLIFY_APPLICATION_UUID, sha: env.APP_VERSION, branch,
    supportedVersions: [...new Set([env.PREVIOUS_APP_VERSION, env.APP_VERSION])].join(','),
  }
}

export function apiClient(settings, fetchImpl = fetch) {
  return async (path, method = 'GET', body) => {
    let response
    try {
      response = await fetchImpl(`${settings.base}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      throw new Error(`Coolify ${method} request failed. Inspect Coolify privately before retrying a deployment request.`)
    }
    if (!response.ok) throw new Error(`Coolify ${method} request returned HTTP ${response.status}.`)
    try { return await response.json() } catch { throw new Error('Coolify returned an invalid JSON response.') }
  }
}

export async function checkApplication(api, settings) {
  const app = await api(`/applications/${settings.uuid}`)
  if (app.uuid !== settings.uuid || app.git_branch !== settings.branch || !/^(?:https:\/\/github\.com\/)?Chapuzalia\/POS(?:\.git)?\/?$/i.test(app.git_repository ?? '')) {
    throw new Error(`Coolify application must point to Chapuzalia/POS on ${settings.branch}.`)
  }
  if (app.build_pack !== 'railpack') throw new Error('Expected the inspected Railpack frontend application.')
  const autoDeploy = app.settings?.is_auto_deploy_enabled ?? app.is_auto_deploy_enabled
  if (autoDeploy !== false && autoDeploy !== 0) {
    throw new Error('Disable frontend auto-deploy in Coolify before using this workflow, then wait for existing deployments to finish.')
  }
  if (app.id === undefined || app.id === null) throw new Error('Coolify did not return the application identity.')
  const deployments = await api('/deployments')
  if (!Array.isArray(deployments)) throw new Error('Coolify returned an invalid deployments list.')
  if (deployments.some(item => String(item.application_id) === String(app.id) && activeStatuses.has(item.status))) {
    throw new Error('The frontend already has a queued or running deployment. Wait before retrying.')
  }
}

export async function deployApplication(api, settings, {
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, log = console.log, timeoutMs = 20 * 60_000,
} = {}) {
  // Recheck after migrations: a manual deploy must not race release configuration.
  await checkApplication(api, settings)
  await api(`/applications/${settings.uuid}`, 'PATCH', { git_commit_sha: settings.sha, is_auto_deploy_enabled: false })
  await api(`/applications/${settings.uuid}/envs/bulk`, 'PATCH', {
    data: [
      { key: 'APP_VERSION', value: settings.sha },
      { key: 'SUPPORTED_APP_VERSIONS', value: settings.supportedVersions },
    ].map(item => ({ ...item, is_buildtime: true, is_runtime: false, is_preview: false, is_literal: true })),
  })
  const queued = await api('/deploy', 'POST', { uuid: settings.uuid, force: false })
  const matches = queued.deployments?.filter(item => item.resource_uuid === settings.uuid) ?? []
  if (matches.length !== 1 || !uuidPattern.test(matches[0].deployment_uuid ?? '')) {
    throw new Error('Coolify did not return exactly one deployment for the requested application. Inspect its queue before retrying.')
  }
  const deploymentUuid = matches[0].deployment_uuid
  const deadline = now() + timeoutMs
  let lastStatus
  while (now() < deadline) {
    const deployment = await api(`/deployments/${deploymentUuid}`)
    if (deployment.deployment_uuid !== deploymentUuid) throw new Error('Coolify returned a different deployment identity.')
    if (deployment.status !== lastStatus) {
      // Deliberately never print the API response: it can include logs and configuration.
      log(`Coolify deployment ${deploymentUuid}: ${activeStatuses.has(deployment.status) || deployment.status === 'finished' ? deployment.status : 'stopped'}`)
      lastStatus = deployment.status
    }
    if (deployment.status === 'finished') {
      if (deployment.commit !== settings.sha) throw new Error('Coolify deployed a different Git SHA. Release baseline must not advance.')
      return deploymentUuid
    }
    if (!activeStatuses.has(deployment.status)) throw new Error('Coolify deployment failed, was cancelled or returned an unknown state.')
    await sleep(10_000)
  }
  throw new Error('Timed out waiting for Coolify. Inspect the existing deployment before retrying; it may still be running.')
}

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--check')) throw new Error('Usage: node scripts/deploy-coolify.mjs [--check]')
  const settings = deploymentSettings(process.env)
  const api = apiClient(settings)
  if (process.argv[2] === '--check') {
    await checkApplication(api, settings)
    console.log('Coolify frontend configuration verified.')
  } else {
    await deployApplication(api, settings)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
