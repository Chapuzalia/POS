import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto'
import type { JsonWebKey } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

export type Environment = 'production' | 'staging'
export type DeploymentRequest = { environment: Environment; commit: string; request_id: string }
export type Identity = { environment: Environment; commit: string; run: string; jti: string; expires: number }
export type AccessPolicy = { enabled: boolean; clientId: string; clientSecretSha256: string }
export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
export const shaPattern = /^[0-9a-f]{40}$/
export function parseDeployment(value: unknown): DeploymentRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Invalid deployment request.')
  const fields = value as Record<string, unknown>
  if (Object.keys(fields).sort().join(',') !== 'commit,environment,request_id' ||
    !['production', 'staging'].includes(String(fields.environment)) || typeof fields.commit !== 'string' || !shaPattern.test(fields.commit) ||
    typeof fields.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(fields.request_id)) throw new HttpError(400, 'Invalid deployment request.')
  return fields as DeploymentRequest
}
type Claims = Record<string, unknown>
type SigningKey = JsonWebKey & { kid?: string; alg?: string; use?: string }
type KeySet = { keys: SigningKey[] }
const issuer = 'https://token.actions.githubusercontent.com'

export async function githubKeys(): Promise<KeySet> {
  const response = await fetch(`${issuer}/.well-known/jwks`, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new HttpError(503, 'Identity verification unavailable.')
  const body = await response.text()
  if (body.length > 128_000) throw new HttpError(503, 'Identity verification unavailable.')
  return JSON.parse(body) as KeySet
}
export class GitHubVerifier {
  private cached?: { expires: number; keys: SigningKey[] }
  readonly audience: string
  readonly repositoryId: string
  private readonly loadKeys: () => Promise<KeySet>
  private readonly now: () => number
  constructor(audience: string, repositoryId: string, loadKeys = githubKeys, now = () => Math.floor(Date.now() / 1000)) {
    this.audience = audience; this.repositoryId = repositoryId; this.loadKeys = loadKeys; this.now = now
  }
  async verify(token: string, request: Pick<DeploymentRequest, 'environment' | 'commit'>): Promise<Identity> {
    try {
      if (token.length > 16_384) throw new Error()
      const parts = token.split('.')
      if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error()
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as Claims
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Claims
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined) throw new Error()
      const now = this.now()
      if (!this.cached || this.cached.expires <= now) {
        const keys = await this.loadKeys()
        if (!Array.isArray(keys.keys) || keys.keys.length > 100) throw new Error()
        this.cached = { expires: now + 300, keys: keys.keys }
      }
      const matches = this.cached.keys.filter(k => k.kid === header.kid && k.kty === 'RSA' && (!k.alg || k.alg === 'RS256') && (!k.use || k.use === 'sig'))
      if (matches.length !== 1 || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: matches[0], format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new Error()
      if (claims.iss !== issuer || claims.aud !== this.audience || typeof claims.exp !== 'number' || claims.exp <= now ||
        typeof claims.iat !== 'number' || claims.iat > now || now - claims.iat > 600 || claims.exp - claims.iat > 600 ||
        typeof claims.nbf !== 'number' || claims.nbf > now ||
        claims.repository !== 'Chapuzalia/POS' || claims.repository_id !== this.repositoryId ||
        claims.sha !== request.commit || !shaPattern.test(request.commit) || claims.workflow_sha !== request.commit ||
        typeof claims.jti !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(claims.jti) ||
        typeof claims.run_id !== 'string' || !/^[0-9]+$/.test(claims.run_id) ||
        typeof claims.run_attempt !== 'string' || !/^[0-9]+$/.test(claims.run_attempt)) throw new Error()
      const production = request.environment === 'production'
      const branch = production ? 'main' : 'Staging'
      const file = production ? 'production.yml' : 'staging.yml'
      if (claims.ref !== `refs/heads/${branch}` || claims.workflow_ref !== `Chapuzalia/POS/.github/workflows/${file}@refs/heads/${branch}` ||
        !['push', ...(production ? [] : ['workflow_dispatch'])].includes(String(claims.event_name))) throw new Error()
      return { environment: request.environment, commit: request.commit, run: `${claims.run_id}:${claims.run_attempt}`, jti: claims.jti, expires: claims.exp }
    } catch { throw new HttpError(403, 'Deployment identity rejected.') }
  }
}
export async function authorize(headers: IncomingHttpHeaders, request: Pick<DeploymentRequest, 'environment' | 'commit'>,
  policies: Partial<Record<Environment, AccessPolicy>>, verifier: GitHubVerifier): Promise<Identity> {
  const policy = policies[request.environment]
  const secret = headers['cf-access-client-secret']
  if (!policy?.enabled || headers['cf-access-client-id'] !== policy.clientId || typeof secret !== 'string' || secret.length > 1024 ||
    !/^[0-9a-f]{64}$/.test(policy.clientSecretSha256) ||
    !timingSafeEqual(createHash('sha256').update(secret).digest(), Buffer.from(policy.clientSecretSha256, 'hex'))) throw new HttpError(403, 'Deployment access rejected.')
  const authorization = headers.authorization
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) throw new HttpError(401, 'Authentication required.')
  return verifier.verify(authorization.slice(7), request)
}
