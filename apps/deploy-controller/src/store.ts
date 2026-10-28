import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { HttpError, shaPattern } from './auth.ts'
import type { DeploymentRequest, Identity, Environment } from './auth.ts'

export type State = 'queued' | 'preflight' | 'awaiting_approval' | 'backing_up' | 'migrating' | 'deploying_edge' | 'deploying_application' | 'verifying' | 'success' | 'failed' | 'interrupted' | 'cancelled'
export type Deployment = DeploymentRequest & { id: string; status: State; run: string; created_at: number; updated_at: number; started_at: number | null; finished_at: number | null; duration_ms: number | null; error: string | null }
const terminal = new Set<State>(['success', 'failed', 'interrupted', 'cancelled'])
export class DeploymentStore {
  readonly path: string
  private readonly db: DatabaseSync
  constructor(path: string) {
    this.path = path; this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY, environment TEXT NOT NULL, commit_sha TEXT NOT NULL, request_id TEXT NOT NULL,
        run TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        started_at INTEGER, finished_at INTEGER, error TEXT, reconciled INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS queue ON deployments(status,created_at);
      CREATE INDEX IF NOT EXISTS requests ON deployments(environment,request_id,created_at);
      CREATE TABLE IF NOT EXISTS tokens (jti TEXT PRIMARY KEY, binding TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS compatible_versions (environment TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(environment,version));`)
  }
  close() { this.db.close() }
  admitVersions(environment: Environment, configured: string, target: string, retired: string[] = []): string {
    const seeds = configured?.split(',').map(value => value.trim()).filter(Boolean) ?? []
    const valid = (version: string) => shaPattern.test(version) || version === 'development'
    if (!seeds.length || !shaPattern.test(target) || [...seeds, ...retired].some(value => !valid(value)) || retired.includes(target) || seeds.some(value => retired.includes(value))) throw new Error('Invalid or conflicting PWA compatibility policy.')
    return this.transaction(() => {
      // Admission is conservative and independent of release success or history.
      // A failed/uncertain build may have served clients; never forget it silently.
      for (const version of [...seeds, target]) this.db.prepare('INSERT OR IGNORE INTO compatible_versions(environment,version) VALUES(?,?)').run(environment, version)
      for (const version of retired) this.db.prepare('DELETE FROM compatible_versions WHERE environment=? AND version=?').run(environment, version)
      return this.db.prepare('SELECT version FROM compatible_versions WHERE environment=? ORDER BY version').all(environment).map(row => String(row.version)).join(',')
    })
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = operation(); this.db.exec('COMMIT'); return result } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private decode(row: Record<string, unknown> | undefined): Deployment | undefined {
    if (!row) return undefined
    const { commit_sha, reconciled: _reconciled, ...fields } = row
    return { ...fields, commit: commit_sha, duration_ms: typeof fields.finished_at === 'number' && typeof fields.started_at === 'number' ? fields.finished_at - fields.started_at : null } as Deployment
  }
  get(id: string) { return this.decode(this.db.prepare('SELECT * FROM deployments WHERE id=?').get(id)) }
  authorizedGet(id: string, identity: Identity): Deployment {
    const row = this.get(id)
    if (!row || row.environment !== identity.environment || row.commit !== identity.commit || row.run !== identity.run) throw new HttpError(404, 'Deployment not found.')
    return row
  }
  enqueue(request: DeploymentRequest, identity: Identity): Deployment {
    return this.transaction(() => {
      const now = Date.now()
      this.db.prepare('DELETE FROM tokens WHERE expires < ?').run(Math.floor(now / 1000))
      const binding = JSON.stringify([request.environment, request.commit, request.request_id, identity.run])
      const token = this.db.prepare('SELECT binding FROM tokens WHERE jti=?').get(identity.jti)
      if (token && token.binding !== binding) throw new HttpError(409, 'Identity token already used for another request.')
      this.db.prepare('INSERT OR IGNORE INTO tokens(jti,binding,expires) VALUES(?,?,?)').run(identity.jti, binding, identity.expires)
      const previous = this.decode(this.db.prepare('SELECT * FROM deployments WHERE environment=? AND request_id=? AND created_at>? ORDER BY created_at DESC LIMIT 1').get(request.environment, request.request_id, now - 86400_000))
      if (previous) {
        if (previous.commit !== request.commit || previous.run !== identity.run) throw new HttpError(409, 'Conflicting request retry.')
        return previous
      }
      const queued = this.db.prepare("SELECT count(*) AS count FROM deployments WHERE status='queued'").get()
      if (Number(queued?.count) >= 20) throw new HttpError(429, 'Deployment queue is full.')
      const id = randomUUID()
      this.db.prepare("INSERT INTO deployments(id,environment,commit_sha,request_id,run,status,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)")
        .run(id, request.environment, request.commit, request.request_id, identity.run, now, now)
      return this.get(id) as Deployment
    })
  }
  claim(): Deployment | undefined {
    return this.transaction(() => {
      const active = this.db.prepare("SELECT id FROM deployments WHERE status NOT IN ('queued','success','failed','interrupted','cancelled') LIMIT 1").get()
      if (active) return undefined
      const row = this.decode(this.db.prepare(`SELECT * FROM deployments q WHERE status='queued' AND NOT EXISTS (
        SELECT 1 FROM deployments b WHERE b.environment=q.environment AND b.status IN ('failed','interrupted') AND b.reconciled=0)
        ORDER BY created_at,rowid LIMIT 1`).get())
      if (!row) return undefined
      this.transition(row.id, 'preflight')
      return this.get(row.id)
    })
  }
  transition(id: string, status: State, error: string | null = null) {
    const now = Date.now()
    this.db.prepare('UPDATE deployments SET status=?,updated_at=?,started_at=COALESCE(started_at,?),finished_at=?,error=? WHERE id=?')
      .run(status, now, now, terminal.has(status) ? now : null, error, id)
  }
  recover() {
    this.db.prepare("UPDATE deployments SET status='interrupted', updated_at=?, finished_at=?, error='Worker interrupted; operator reconciliation required.' WHERE status NOT IN ('queued','success','failed','interrupted','cancelled')").run(Date.now(), Date.now())
  }
  reconcile(id: string) {
    const row = this.get(id)
    if (!row || !['failed', 'interrupted'].includes(row.status)) throw new HttpError(409, 'Only failed or interrupted operations can be reconciled.')
    this.db.prepare('UPDATE deployments SET reconciled=1 WHERE id=?').run(id)
  }
}
