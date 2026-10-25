// Successful check-only runs must never become the migration baseline.
export async function resolveStagingBaseline({ github, owner, repo, sha, configuredBaseline, configuredPreviousAppVersion }) {
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    owner, repo, workflow_id: 'staging.yml', branch: 'Staging', status: 'success', per_page: 100,
  })
  let previous
  for (const run of runs) {
    if (run.head_sha === sha) continue
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      owner, repo, run_id: run.id, filter: 'latest', per_page: 100,
    })
    if (jobs.some(job => job.name === 'Deploy staging release' && job.conclusion === 'success')) {
      previous = run
      break
    }
  }
  const baseline = previous?.head_sha ?? configuredBaseline?.trim()
  if (!baseline || !/^[0-9a-f]{40}$/i.test(baseline)) {
    throw new Error('Set STAGING_BASE_SHA to the verified staging database/release baseline. A Git branch HEAD alone is not evidence of deployment.')
  }
  // The copied database can match an older Git ancestor while the frontend
  // already runs a newer release, or still identifies itself as development.
  const previousAppVersion = previous?.head_sha ?? configuredPreviousAppVersion?.trim()
  if (!previousAppVersion || (!/^[0-9a-f]{40}$/.test(previousAppVersion) && previousAppVersion !== 'development')) {
    throw new Error('Set STAGING_PREVIOUS_APP_VERSION to the version served by the current frontend (a full Git SHA or development). This is separate from the migration baseline.')
  }
  return { baseline, previousAppVersion, bootstrap: !previous }
}
