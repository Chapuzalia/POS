import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { isApprovedMigrationException } from '../scripts/check-migration-safety-exception.mjs'

const base = 'a'.repeat(40)
const head = 'b'.repeat(40)
const repository = 'Chapuzalia/POS'
function fixture() {
  return {
    approvedBase: base, approvedHead: head, baseline: base, parents: [base, head],
    repository, eventName: 'pull_request',
    event: { pull_request: {
      base: { ref: 'main', sha: base, repo: { full_name: repository } },
      head: { ref: 'Staging', sha: head, repo: { full_name: repository } },
    } },
  }
}

test('accepts only the pinned same-repository Staging PR and matching production merge', () => {
  assert.equal(isApprovedMigrationException(fixture()), true)
  assert.equal(isApprovedMigrationException({ ...fixture(), eventName: 'push',
    event: { ref: 'refs/heads/main', repository: { full_name: repository } },
  }), true)
})

test('defaults to checking and expires when the production baseline advances', () => {
  for (const patch of [
    { approvedBase: undefined }, { approvedHead: undefined }, { approvedHead: 'bad' },
    { approvedHead: base }, { baseline: head }, { parents: [head, base] },
    { parents: [base] }, { parents: [base, head, base] },
    { parents: [base, 'c'.repeat(40)] }, { eventName: 'workflow_dispatch' },
  ]) assert.equal(isApprovedMigrationException({ ...fixture(), ...patch }), false)
})

test('rejects a fork, another branch, or changed PR commits', () => {
  for (const side of ['base', 'head']) {
    for (const patch of [{ ref: 'other' }, { sha: 'c'.repeat(40) },
      { repo: { full_name: 'other/POS' } }]) {
      const input = fixture()
      Object.assign(input.event.pull_request[side], patch)
      assert.equal(isApprovedMigrationException(input), false)
    }
  }
})

test('rejects production events outside this repository main branch', () => {
  for (const event of [
    { ref: 'refs/heads/Staging', repository: { full_name: repository } },
    { ref: 'refs/heads/main', repository: { full_name: 'other/POS' } },
  ]) assert.equal(isApprovedMigrationException({ ...fixture(), eventName: 'push', event }), false)
})

test('allows a pinned recovery merge while keeping the last successful baseline fixed', () => {
  const mergeBase = 'c'.repeat(40)
  const input = fixture()
  input.approvedMergeBase = mergeBase
  input.baselineIsAncestor = true
  input.parents = [mergeBase, head]
  input.event.pull_request.base.sha = mergeBase
  assert.equal(isApprovedMigrationException(input), true)
  assert.equal(isApprovedMigrationException({ ...input, eventName: 'push',
    event: { ref: 'refs/heads/main', repository: { full_name: repository } },
  }), true)
  for (const patch of [
    { approvedMergeBase: undefined }, { approvedMergeBase: 'bad' },
    { approvedMergeBase: head }, { baselineIsAncestor: false },
    { baselineIsAncestor: undefined }, { baseline: mergeBase },
    { parents: [base, head] }, { parents: [mergeBase, 'd'.repeat(40)] },
  ]) assert.equal(isApprovedMigrationException({ ...input, ...patch }), false)
  input.event.pull_request.base.sha = base
  assert.equal(isApprovedMigrationException(input), false)
})

test('CLI verifies recovery ancestry in Git and refuses an unrelated pinned merge base', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'migration-exception-recovery-'))
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()
  const script = fileURLToPath(new URL('../scripts/check-migration-safety-exception.mjs', import.meta.url))
  try {
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Migration Test')
    git('commit', '--allow-empty', '-qm', 'deployed baseline')
    const baseline = git('rev-parse', 'HEAD')
    git('checkout', '-qb', 'Staging')
    git('commit', '--allow-empty', '-qm', 'recovery fix')
    const reviewedHead = git('rev-parse', 'HEAD')
    git('checkout', '-q', 'main')
    git('commit', '--allow-empty', '-qm', 'failed deployment')
    const mergeBase = git('rev-parse', 'HEAD')
    git('merge', '--no-ff', '-qm', 'recovery merge', 'Staging')
    const recoveryMerge = git('rev-parse', 'HEAD')
    const eventPath = join(directory, 'event.json')
    const outputPath = join(directory, 'output.txt')
    await writeFile(eventPath, JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: repository } }))
    const env = { ...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: '', GITHUB_SHA: recoveryMerge, GITHUB_EVENT_NAME: 'push',
      GITHUB_REPOSITORY: repository, BASE_SHA: baseline, APPROVED_BASE_SHA: baseline,
      APPROVED_HEAD_SHA: reviewedHead, APPROVED_MERGE_BASE_SHA: mergeBase }
    execFileSync(process.execPath, [script], { cwd: directory, env })
    assert.equal(await readFile(outputPath, 'utf8'), 'approved=true\n')

    git('checkout', '--orphan', 'unrelated')
    git('commit', '--allow-empty', '-qm', 'unrelated baseline')
    const unrelated = git('rev-parse', 'HEAD')
    await writeFile(outputPath, '')
    execFileSync(process.execPath, [script], { cwd: directory,
      env: { ...env, BASE_SHA: unrelated, APPROVED_BASE_SHA: unrelated } })
    assert.equal(await readFile(outputPath, 'utf8'), 'approved=false\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
