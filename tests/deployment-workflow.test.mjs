import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('producción valida desde el último release correcto y preconstruye antes de migrar', async () => {
  const workflow = await readFile(new URL('../.github/workflows/production.yml', import.meta.url), 'utf8')

  assert.match(workflow, /actions:\s+read/)
  assert.match(workflow, /queue:\s+max/)
  assert.match(workflow, /listWorkflowRuns/)
  assert.match(workflow, /status:\s+'success'/)
  assert.match(workflow, /PRODUCTION_BASE_SHA/)
  assert.match(workflow, /BASE_SHA:\s+\$\{\{ steps\.release\.outputs\.base_sha \}\}/)
  assert.match(workflow, /SUPPORTED_APP_VERSIONS:\s+\$\{\{ steps\.release\.outputs\.supported_versions \}\}/)
  assert.match(workflow, /corepack@0\.36\.0/)
  assert.match(workflow, /pnpm@10\.15\.1/)
  assert.match(workflow, /vercel@59\.16\.0/)

  const prebuild = workflow.indexOf('vercel build --prod')
  const migration = workflow.indexOf('Backup and apply production migrations')
  const deploy = workflow.indexOf('vercel deploy --yes --prebuilt --prod')
  assert.ok(prebuild > -1 && migration > prebuild && deploy > migration)
})

test('el workflow de PR ejecuta el checker y sus regresiones', async () => {
  const workflow = await readFile(new URL('../.github/workflows/migration-safety.yml', import.meta.url), 'utf8')

  assert.match(workflow, /pull_request:/)
  assert.match(workflow, /check-pr-migrations\.sh/)
  assert.match(workflow, /migration-safety\.test\.mjs/)
})
