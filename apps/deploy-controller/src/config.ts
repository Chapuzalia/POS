import { lstatSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { AccessPolicy, Environment } from './auth.ts'

export type EnvironmentConfig = AccessPolicy & { coolify: Record<string, string>; healthUrl: string; retiredAppVersions?: string[] }
export type ControllerConfig = { repositoryId: string; audience: string; environments: Record<Environment, EnvironmentConfig> }
export const installRoot = '/opt/tickit'
export const dataRoot = '/var/lib/tickit-deploy'
export const socketPath = '/run/tickit-deploy/worker.sock'
export function assertRootOwned(path: string) {
  for (let current = resolve(path);; current = dirname(current)) {
    const info = lstatSync(current)
    if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) throw new Error('Trusted path must be root-owned without writable ancestors.')
    if (current === dirname(current)) break
  }
}
export function loadConfig(path = '/etc/tickit-deploy/controller.json'): ControllerConfig {
  assertRootOwned(path)
  if (lstatSync(path).mode & 0o077) throw new Error('Controller configuration must be private (0600).')
  const config = JSON.parse(readFileSync(path, 'utf8')) as ControllerConfig
  if (config.audience !== 'https://deploy.alteilsolutions.com' || !/^[0-9]+$/.test(config.repositoryId)) throw new Error('Invalid controller identity policy.')
  const projects = new Set<string>()
  for (const environment of ['production', 'staging'] as const) {
    const policy = config.environments?.[environment]
    if (!policy || typeof policy.enabled !== 'boolean') throw new Error('Configure both environment activation gates.')
    if (!policy.enabled) continue
    if (!policy.clientId || !/^[0-9a-f]{64}$/.test(policy.clientSecretSha256)) throw new Error('Configure independent Access service credentials.')
    if (policy.retiredAppVersions !== undefined && (!Array.isArray(policy.retiredAppVersions) || policy.retiredAppVersions.some(value => typeof value !== 'string' || !/^(?:[0-9a-f]{40}|development)$/.test(value)))) throw new Error('Invalid explicit PWA retirement policy.')
    const health = new URL(policy.healthUrl)
    if (health.protocol !== 'https:' || health.username || health.password || health.search || health.hash || health.pathname !== '/app-version.json') throw new Error('Health URL must be the HTTPS app-version.json endpoint.')
    const receiverPath = `/etc/tickit-deploy/receiver.${environment}.json`
    assertRootOwned(receiverPath)
    const receiver = JSON.parse(readFileSync(receiverPath, 'utf8')) as Record<string, unknown>
    if (receiver.environment !== environment) throw new Error('Receiver environment differs from controller policy.')
    if (typeof receiver.coolify_project !== 'string' || projects.has(receiver.coolify_project)) throw new Error('Each enabled environment must use its own Supabase project.')
    projects.add(receiver.coolify_project)
    if (environment === 'staging' && (receiver.coolify_project === 'dbdtluvsdqycxl5tecuwljie' || policy.coolify.COOLIFY_APPLICATION_UUID === 'ezpjwb28qiq7uueykidpitdl')) throw new Error('Staging must not select production resources.')
  }
  const { production, staging } = config.environments
  if (production.enabled && staging.enabled && (production.clientId === staging.clientId || production.clientSecretSha256 === staging.clientSecretSha256 || production.coolify.COOLIFY_APPLICATION_UUID === staging.coolify.COOLIFY_APPLICATION_UUID || production.healthUrl === staging.healthUrl)) throw new Error('Production and staging must use independent resources and credentials.')
  return config
}
