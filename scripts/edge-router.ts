// Self-hosted router for the inspected Edge Runtime v1.76.2.
// Configuration is generated from config.toml by the root-owned SSH receiver.
import * as jose from 'jsr:@panva/jose@6'

interface FunctionConfig { verify_jwt: boolean; import_map: string | null }
interface Release { commit: string; functions: Record<string, FunctionConfig> }
const release: Release = JSON.parse(await Deno.readTextFile('/home/deno/functions/pos-release.json'))
const secret = Deno.env.get('JWT_SECRET')
function localPublicKeys() {
  try {
    const jwks = JSON.parse(Deno.env.get('SUPABASE_JWKS') ?? 'null')
    return Array.isArray(jwks?.keys) ? jose.createLocalJWKSet(jwks) : null
  } catch { return null }
}
const publicKeys = localPublicKeys()

async function validToken(request: Request): Promise<boolean> {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '')
  if (!match) return false
  try {
    const { alg } = jose.decodeProtectedHeader(match[1])
    if (alg === 'HS256' && secret) {
      await jose.jwtVerify(match[1], new TextEncoder().encode(secret), { algorithms: ['HS256'] })
    } else if ((alg === 'ES256' || alg === 'RS256') && publicKeys) {
      await jose.jwtVerify(match[1], publicKeys, { algorithms: ['ES256', 'RS256'] })
    } else return false
    return true
  } catch { return false }
}

Deno.serve(async (request: Request) => {
  const name = new URL(request.url).pathname.split('/')[1]
  if (name === '_pos_health' && request.method === 'GET') {
    return Response.json({ commit: release.commit })
  }
  const config = Object.hasOwn(release.functions, name) ? release.functions[name] : undefined
  if (!config) return Response.json({ msg: 'Function not found' }, { status: 404 })
  if (request.method !== 'OPTIONS' && config.verify_jwt && !await validToken(request)) {
    return Response.json({ msg: 'Invalid JWT' }, { status: 401 })
  }
  try {
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath: `/home/deno/functions/${name}`,
      memoryLimitMb: 150,
      workerTimeoutMs: 60_000,
      noModuleCache: false,
      importMapPath: config.import_map,
      envVars: Object.entries(Deno.env.toObject()),
    })
    const response = await worker.fetch(request)
    const headers = new Headers(response.headers)
    headers.set('x-pos-edge-release', release.commit)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  } catch {
    // Never send request bodies, credentials or runtime diagnostics to callers.
    return Response.json({ msg: 'Function unavailable' }, { status: 503 })
  }
})
