import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRelease } from '../../apps/deploy-controller/src/pipeline.ts'
import type { Deployment } from '../../apps/deploy-controller/src/store.ts'
const sha = 'a'.repeat(40)
const deployment = { id: 'run-1', environment: 'staging', commit: sha } as Deployment
const config = { enabled: true, clientId: 'id', clientSecretSha256: 'a'.repeat(64), coolify: { COOLIFY_API_TOKEN: 'private', SUPPORTED_APP_VERSIONS: 'b'.repeat(40) }, healthUrl: 'https://staging.example/app-version.json' }
it('does not run previously queued jobs after an environment is disabled', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tickit-pipeline-'))
  let calls = 0
  try {
    await expect(runRelease(deployment, { ...config, enabled: false }, () => {}, { workspace: directory, command: async () => { calls++; return '' } })).rejects.toThrow()
    expect(calls).toBe(0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
it('runs trusted release stages in order for every request including identical commits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tickit-pipeline-'))
  const calls: string[] = [], phases: string[] = []
  const command = async (_bin: string, args: string[]) => {
    calls.push(args.join(' '))
    if (args.includes('get-url')) return 'git@github.com:Chapuzalia/POS.git'
    if (args.includes('rev-parse')) return sha
    return ''
  }
  try {
    for (let i = 0; i < 2; i++) await runRelease(deployment, config, phase => phases.push(phase), { command, probe: async () => {}, workspace: directory })
    expect(calls.filter(c => c.includes('controller-package.py'))).toHaveLength(2)
    expect(calls.filter(c => c.includes('deploy-pos.py'))).toHaveLength(2)
    expect(calls.filter(c => c.includes('deploy-coolify.mjs') && !c.includes('--check'))).toHaveLength(2)
    expect(phases).toEqual(['preflight', 'deploying_application', 'verifying', 'preflight', 'deploying_application', 'verifying'])
    expect(calls[0]).toContain('get-url')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
it.each(['receiver', 'coolify', 'health', 'commit'])('stops on %s failure and never reports success', async failure => {
  const directory = mkdtempSync(join(tmpdir(), 'tickit-pipeline-')); const calls: string[] = []
  try {
    await expect(runRelease(deployment, config, () => {}, {
      workspace: directory,
      command: async (_bin, args) => {
        const call = args.join(' '); calls.push(call)
        if (args.includes('get-url')) return 'git@github.com:Chapuzalia/POS.git'
        if (args.includes('rev-parse')) return failure === 'commit' ? 'b'.repeat(40) : sha
        if ((failure === 'receiver' && call.includes('deploy-pos.py')) || (failure === 'coolify' && call.includes('deploy-coolify.mjs') && !call.includes('--check'))) throw new Error('boundary failed')
        return ''
      },
      probe: async () => { if (failure === 'health') throw new Error('health failed') },
    })).rejects.toThrow()
    if (failure === 'receiver' || failure === 'commit') expect(calls.some(c => c.includes('deploy-coolify.mjs') && !c.includes('--check'))).toBe(false)
    if (failure === 'commit') expect(calls.some(c => c.includes('controller-package.py'))).toBe(false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
