import { chmodSync, mkdirSync, unlinkSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { GitHubVerifier } from './auth.ts'
import { assertRootOwned, dataRoot, installRoot, loadConfig, socketPath } from './config.ts'
import { boundedServer, workerHandler } from './http.ts'
import { DeploymentCancelled, runRelease } from './pipeline.ts'
import { DeploymentStore } from './store.ts'

async function main() {
  if (process.getuid?.() !== 0) throw new Error('The internal worker requires controlled deployment privileges.')
  process.umask(0o077)
  assertRootOwned(installRoot)
  for (const name of ['auth.ts', 'config.ts', 'gateway.ts', 'http.ts', 'pipeline.ts', 'store.ts', 'worker.ts']) assertRootOwned(`${installRoot}/apps/deploy-controller/src/${name}`)
  for (const name of ['controller-package.py', 'deploy-coolify.mjs', 'deploy-pos.py', 'telegram_migration_approval.py', 'prepare-edge-functions.mjs', 'prepare-production-migrations.mjs', 'edge-router.ts', 'pending-migration-safety.mjs', 'check-migrations.mjs']) assertRootOwned(`${installRoot}/scripts/${name}`)
  const config = loadConfig(process.env.TICKIT_DEPLOY_CONFIG)
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 }); assertRootOwned(dataRoot)
  const store = new DeploymentStore(`${dataRoot}/state.sqlite`)
  if (process.argv[2] === 'reconcile' && process.argv.length === 4) {
    store.reconcile(process.argv[3]); store.close(); console.log('Operation reconciled by operator. Submit a request to continue the queue.'); return
  }
  if (process.argv.length !== 2) throw new Error('Usage: worker.ts [reconcile UUID]')
  store.recover()
  const verifier = new GitHubVerifier(config.audience, config.repositoryId)
  let pumping = false, stopping = false
  const pump = async () => {
    if (pumping || stopping) return
    pumping = true
    try {
      let deployment
      while (!stopping && (deployment = store.claim())) {
        const id = deployment.id
        try {
          const environment = config.environments[deployment.environment]
          if (!environment.enabled) throw new Error('Environment disabled.')
          const supported = store.admitVersions(deployment.environment, environment.coolify.SUPPORTED_APP_VERSIONS, deployment.commit, environment.retiredAppVersions)
          await runRelease(deployment, { ...environment, coolify: { ...environment.coolify, SUPPORTED_APP_VERSIONS: supported } }, state => store.transition(id, state))
          store.transition(id, 'success')
        } catch (error) {
          if (error instanceof DeploymentCancelled) store.transition(id, 'cancelled', 'Telegram approval was cancelled or expired; SQL was not applied.')
          else store.transition(id, 'failed', 'Deployment stopped; private logs and operator reconciliation required.')
        }
      }
    } finally { pumping = false }
  }
  const server = boundedServer(workerHandler(store, verifier, config.environments, () => { void pump() }))
  mkdirSync('/run/tickit-deploy', { recursive: true, mode: 0o750 })
  try { unlinkSync(socketPath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  server.listen(socketPath, () => { chmodSync(socketPath, 0o660); void pump() })
  // Container shutdown kills remaining deployment children. The next startup
  // blocks the environment rather than retrying an uncertain mutation.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stopping = true; server.close(); process.exit(0) })
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Worker startup failed; inspect private configuration and permissions.'); process.exitCode = 1 })
}
