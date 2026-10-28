import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function workflow(name) {
  return readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8')
}

test('automatic deployments only request the private controller after complete verification', async () => {
  for (const name of ['production', 'staging']) {
    const source = await workflow(name)
    for (const check of ['python3 -B -m unittest', 'pnpm lint', 'pnpm test', 'pnpm build']) assert.ok(source.includes(check))
    assert.match(source, /needs: verify/)
    assert.match(source, /id-token: write/)
    assert.match(source, /node scripts\/request-deployment\.mjs/)
    assert.doesNotMatch(source, /tailscale|SSH_|COOLIFY_API_TOKEN|send-pos-migrations|deploy-coolify|BASE_SHA|PREVIOUS_APP_VERSION|listWorkflowRuns|actions: read/)
  }
  assert.match(await workflow('production'), /if: vars\.PRIVATE_DEPLOY_PRODUCTION_ENABLED == 'true'/)
  assert.match(await workflow('staging'), /if: vars\.PRIVATE_DEPLOY_STAGING_ENABLED == 'true' && vars\.STAGING_DEPLOY_ENABLED == 'true'/)
})

test('PR migration review compares the PR base without deployed-history lookup or global bypass', async () => {
  const source = await workflow('migration-safety')
  assert.match(source, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/)
  assert.match(source, /HEAD_SHA: \$\{\{ github\.sha \}\}/)
  assert.match(source, /check-pr-migrations\.sh/)
  assert.doesNotMatch(source, /listWorkflowRuns|PRODUCTION_BASE_SHA|MIGRATION_SAFETY_EXCEPTION|actions: read/)
})
