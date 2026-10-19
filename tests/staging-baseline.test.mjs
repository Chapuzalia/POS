import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveStagingBaseline } from '../scripts/resolve-staging-baseline.mjs'

const current = 'a'.repeat(40)
const deployed = 'b'.repeat(40)
const checked = 'c'.repeat(40)
function client(runs, jobsByRun = {}) {
  const calls = []
  const github = {
    rest: { actions: { listWorkflowRuns: 'runs', listJobsForWorkflowRun: 'jobs' } },
    paginate: async (method, args) => {
      calls.push({ method, args })
      return method === 'runs' ? runs : jobsByRun[args.run_id] ?? []
    },
  }
  return { github, calls }
}

test('only a completed deploy advances staging; checks and skipped jobs do not', async () => {
  const { github, calls } = client([
    { id: 4, head_sha: current }, { id: 3, head_sha: checked }, { id: 2, head_sha: deployed },
  ], {
    3: [{ name: 'Verify staging without deploying', conclusion: 'success' }, { name: 'Deploy staging release', conclusion: 'skipped' }],
    2: [{ name: 'Deploy staging release', conclusion: 'success' }],
  })
  const result = await resolveStagingBaseline({ github, owner: 'Chapuzalia', repo: 'POS', sha: current, configuredBaseline: checked })
  assert.deepEqual(result, { baseline: deployed, previousAppVersion: deployed, bootstrap: false })
  assert.equal(calls[0].args.branch, 'Staging')
  assert.equal(calls[0].args.status, 'success')
  assert.equal(calls[0].args.workflow_id, 'staging.yml')
  assert.deepEqual(calls.filter(call => call.method === 'jobs').map(call => call.args.run_id), [3, 2])
})

test('first deploy requires an explicit verified baseline even after successful checks', async () => {
  const { github } = client([{ id: 1, head_sha: checked }], { 1: [{ name: 'Deploy staging release', conclusion: 'skipped' }] })
  const args = { github, owner: 'Chapuzalia', repo: 'POS', sha: current }
  await assert.rejects(resolveStagingBaseline(args), /STAGING_BASE_SHA/)
  await assert.rejects(resolveStagingBaseline({ ...args, configuredBaseline: 'HEAD' }), /STAGING_BASE_SHA/)
  await assert.rejects(resolveStagingBaseline({ ...args, configuredBaseline: deployed }), /STAGING_PREVIOUS_APP_VERSION/)
  assert.deepEqual(await resolveStagingBaseline({ ...args, configuredBaseline: deployed, configuredPreviousAppVersion: checked }), {
    baseline: deployed, previousAppVersion: checked, bootstrap: true,
  })
})

test('bootstrap keeps the database baseline separate from the published frontend version', async () => {
  const { github } = client([])
  const args = { github, owner: 'Chapuzalia', repo: 'POS', sha: current, configuredBaseline: deployed }
  assert.deepEqual(await resolveStagingBaseline({ ...args, configuredPreviousAppVersion: 'development' }), {
    baseline: deployed, previousAppVersion: 'development', bootstrap: true,
  })
  for (const version of ['HEAD', 'development,other', '']) {
    await assert.rejects(resolveStagingBaseline({ ...args, configuredPreviousAppVersion: version }), /STAGING_PREVIOUS_APP_VERSION/)
  }
})
