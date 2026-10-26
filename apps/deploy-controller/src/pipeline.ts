import { spawn } from 'node:child_process'
import { appendFileSync, createReadStream, mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { dataRoot, installRoot } from './config.ts'
import type { EnvironmentConfig } from './config.ts'
import type { Deployment, State } from './store.ts'

type CommandOptions = { env?: NodeJS.ProcessEnv; stdinFile?: string; timeoutMs?: number }
export type Command = (bin: string, args: string[], options?: CommandOptions) => Promise<string>
export const safeEnv: NodeJS.ProcessEnv = {
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', LANG: 'C.UTF-8',
  GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: '/usr/bin/ssh -i /etc/tickit-deploy/repository_ed25519 -oIdentitiesOnly=yes -oBatchMode=yes -oStrictHostKeyChecking=yes -oUserKnownHostsFile=/etc/tickit-deploy/github_known_hosts',
}
export function commandRunner(log: (line: string) => void, phase: (state: State) => void): Command {
  return (bin, args, { env = safeEnv, stdinFile, timeoutMs = 25 * 60_000 } = {}) => new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    let size = 0, output = '', lines = '', stopped = false
    const stop = () => {
      stopped = true
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { /* Already exited. */ }
    }
    const timeout = setTimeout(stop, timeoutMs)
    let source: ReturnType<typeof createReadStream> | undefined
    if (stdinFile) { source = createReadStream(stdinFile); source.on('error', stop); source.pipe(child.stdin) } else child.stdin.end()
    child.stdin.on('error', () => { /* Process exit determines result, including interrupted pipe. */ })
    const consume = (chunk: Buffer, stdout: boolean) => {
      size += chunk.length
      if (size > 8 * 1024 * 1024) { stop(); return }
      const text = chunk.toString('utf8'); log(text)
      if (stdout) {
        output += text; lines += text
        const split = lines.split('\n'); lines = split.pop() ?? ''
        for (const line of split) {
          const match = /^POS_PHASE:(preflight|backing_up|migrating|deploying_edge)$/.exec(line.trim())
          if (match) phase(match[1] as State)
        }
      }
    }
    child.stdout.on('data', chunk => consume(chunk, true)); child.stderr.on('data', chunk => consume(chunk, false))
    child.on('error', () => { clearTimeout(timeout); source?.destroy(); reject(new Error('Deployment tool could not start.')) })
    child.on('close', code => {
      clearTimeout(timeout); source?.destroy()
      if (code !== 0 || stopped) reject(new Error('Deployment tool failed or timed out; inspect the private log.'))
      else resolve(output.trim())
    })
  })
}
export async function probeApplication(url: string, commit: string) {
  const target = new URL(url); target.searchParams.set('deployment', `${commit}-${Date.now()}`)
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'Cache-Control': 'no-cache' } })
      if (!response.ok) throw new Error()
      const text = await response.text()
      if (text.length > 16_384) throw new Error()
      const version = JSON.parse(text) as { currentVersion?: string; supportedVersions?: unknown }
      if (version.currentVersion === commit && Array.isArray(version.supportedVersions) && version.supportedVersions.includes(commit)) return
    } catch { /* Bounded readiness retries; never retry deployment mutation. */ }
    if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 5000))
  }
  throw new Error('Application health failed to confirm the requested SHA.')
}
export async function runRelease(deployment: Deployment, config: EnvironmentConfig, phase: (state: State) => void,
  options: { command?: Command; probe?: typeof probeApplication; workspace?: string } = {}) {
  if (!config.enabled) throw new Error('Deployment environment is disabled; no queued operation may start.')
  const logDirectory = join(options.workspace ?? dataRoot, 'logs'); mkdirSync(logDirectory, { recursive: true, mode: 0o700 })
  const secrets = Object.entries(config.coolify).filter(([key]) => /TOKEN|SECRET|PASSWORD/.test(key)).map(([, value]) => value).filter(Boolean)
  const log = (line: string) => {
    for (const secret of secrets) line = line.replaceAll(secret, '[REDACTED]')
    appendFileSync(join(logDirectory, `${deployment.id}.log`), line, { mode: 0o600 })
  }
  const command = options.command ?? commandRunner(log, phase)
  const workspaceRoot = options.workspace ?? dataRoot
  const mirror = join(workspaceRoot, 'repository.git')
  const work = await mkdtemp(join(workspaceRoot, 'release-'))
  try {
    phase('preflight')
    const git = ['--git-dir', mirror]
    const remote = await command('/usr/bin/git', [...git, 'remote', 'get-url', 'origin'])
    if (!['git@github.com:Chapuzalia/POS.git', 'https://github.com/Chapuzalia/POS.git'].includes(remote)) throw new Error('Unexpected source repository.')
    await command('/usr/bin/git', ['-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true', ...git, 'fetch', '--no-tags', 'origin', deployment.commit])
    const fetched = await command('/usr/bin/git', [...git, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
    if (fetched !== deployment.commit) throw new Error('Fetched commit does not match the authorized SHA.')
    const receiverPath = `/etc/tickit-deploy/receiver.${deployment.environment}.json`
    const packagePath = join(work, 'release.tar.gz')
    await command('/usr/bin/python3', [join(installRoot, 'scripts/controller-package.py'), mirror, deployment.commit, work, receiverPath, packagePath])
    const coolifyEnv = { ...safeEnv,
      COOLIFY_URL: config.coolify.COOLIFY_URL, COOLIFY_APPLICATION_UUID: config.coolify.COOLIFY_APPLICATION_UUID,
      COOLIFY_API_TOKEN: config.coolify.COOLIFY_API_TOKEN, SUPPORTED_APP_VERSIONS: config.coolify.SUPPORTED_APP_VERSIONS,
      APP_VERSION: deployment.commit, DEPLOY_BRANCH: deployment.environment === 'production' ? 'main' : 'Staging',
    }
    await command('/usr/bin/node', [join(installRoot, 'scripts/deploy-coolify.mjs'), '--check'], { env: coolifyEnv })
    await command('/usr/bin/python3', [join(installRoot, 'scripts/deploy-pos.py'), '--config', receiverPath], { stdinFile: packagePath })
    phase('deploying_application')
    await command('/usr/bin/node', [join(installRoot, 'scripts/deploy-coolify.mjs')], { env: coolifyEnv })
    phase('verifying')
    await (options.probe ?? probeApplication)(config.healthUrl, deployment.commit)
    log(`\nVerified release ${deployment.commit}.\n`)
  } catch (error) {
    log(`\nSTOPPED: ${error instanceof Error ? error.message : 'Unknown tool error'}\n`)
    throw new Error('Deployment stopped; inspect the private worker log and reconcile before retrying.')
  } finally { await rm(work, { recursive: true, force: true }) }
}

