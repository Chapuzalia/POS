import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Repository variables must pin the final reviewed PR head, including this workflow change.
// A successful release advances the baseline and makes the exception ineligible.
export function isApprovedMigrationException({
  approvedBase, approvedHead, approvedMergeBase, baseline, baselineIsAncestor = false,
  parents, eventName, event, repository,
}) {
  const shaPattern = /^[0-9a-f]{40}$/
  const mergeBase = approvedMergeBase || approvedBase
  if (!shaPattern.test(approvedBase ?? '') || !shaPattern.test(approvedHead ?? '')) return false
  if (!shaPattern.test(mergeBase ?? '') || mergeBase === approvedHead) return false
  if (approvedBase === approvedHead || baseline !== approvedBase) return false
  if (mergeBase !== approvedBase && !baselineIsAncestor) return false
  if (parents.length !== 2 || parents[0] !== mergeBase || parents[1] !== approvedHead) return false
  if (eventName === 'push') {
    return event.ref === 'refs/heads/main' && event.repository?.full_name === repository
  }
  if (eventName !== 'pull_request') return false
  const pr = event.pull_request
  return pr?.base?.ref === 'main'
    && pr.base.sha === mergeBase
    && pr.base.repo?.full_name === repository
    && pr.head?.ref === 'Staging'
    && pr.head.sha === approvedHead
    && pr.head.repo?.full_name === repository
}

function isGitAncestor(base, descendant) {
  const shaPattern = /^[0-9a-f]{40}$/
  if (!shaPattern.test(base ?? '') || !shaPattern.test(descendant ?? '')) return false
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', base, descendant], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const parents = execFileSync('git', ['show', '-s', '--format=%P', process.env.GITHUB_SHA], {
    encoding: 'utf8',
  }).trim().split(/\s+/)
  const approved = isApprovedMigrationException({
    approvedBase: process.env.APPROVED_BASE_SHA,
    approvedHead: process.env.APPROVED_HEAD_SHA,
    approvedMergeBase: process.env.APPROVED_MERGE_BASE_SHA,
    baseline: process.env.BASE_SHA,
    baselineIsAncestor: isGitAncestor(
      process.env.BASE_SHA,
      process.env.APPROVED_MERGE_BASE_SHA || process.env.APPROVED_BASE_SHA,
    ),
    parents,
    eventName: process.env.GITHUB_EVENT_NAME,
    event,
    repository: process.env.GITHUB_REPOSITORY,
  })
  appendFileSync(process.env.GITHUB_OUTPUT, `approved=${approved}\n`)
  if (approved) {
    const message = `Migration checker waived for reviewed merge ${parents[0]} + ${parents[1]}. All other deployment checks remain enabled.`
    console.log(`::warning::${message}`)
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`)
  } else {
    console.log('No matching migration exception. Migration checker remains required.')
    console.log(JSON.stringify({
      baseline: process.env.BASE_SHA,
      approvedBaseline: process.env.APPROVED_BASE_SHA,
      approvedMergeBase: process.env.APPROVED_MERGE_BASE_SHA || process.env.APPROVED_BASE_SHA,
      approvedHead: process.env.APPROVED_HEAD_SHA,
      actualParents: parents,
    }))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
