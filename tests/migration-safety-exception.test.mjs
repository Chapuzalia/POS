import assert from 'node:assert/strict'
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
