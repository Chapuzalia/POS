import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError, authorize, parseDeployment } from './auth.ts'
import type { AccessPolicy, Environment, GitHubVerifier } from './auth.ts'
import type { DeploymentStore } from './store.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(JSON.stringify(value))
}
export async function body(request: IncomingMessage): Promise<Buffer> {
  if (Number(request.headers['content-length'] ?? 0) > 4096) throw new HttpError(413, 'Request too large.')
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 4096) throw new HttpError(413, 'Request too large.')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}
export function boundedServer(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  // Fixed memory global token bucket; forwarded addresses are never trusted.
  let tokens = 240; let refreshed = Date.now()
  const server = createServer({ maxHeaderSize: 24_576 }, (request, response) => {
    const now = Date.now(); tokens = Math.min(240, tokens + (now - refreshed) / 250); refreshed = now
    if (tokens < 1) { send(response, 429, { error: 'Rate limit exceeded.' }); return }
    tokens--
    void handler(request, response).catch(error => {
      if (!response.headersSent) send(response, error instanceof HttpError ? error.status : 503, { error: error instanceof HttpError ? error.message : 'Deployment service unavailable.' })
      else response.destroy()
    })
  })
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000; server.maxConnections = 64
  server.on('connection', socket => socket.setTimeout(15_000, () => socket.destroy()))
  return server
}
export function workerHandler(store: DeploymentStore, verifier: GitHubVerifier, policies: Partial<Record<Environment, AccessPolicy>>, notify: () => void) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === 'GET' && request.url === '/health') { send(response, 200, { status: 'ok' }); return }
    if (request.method === 'POST' && request.url === '/deploy') {
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new HttpError(415, 'JSON required.')
      let parsed: unknown
      try { parsed = JSON.parse((await body(request)).toString('utf8')) } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid JSON.') }
      const deployment = parseDeployment(parsed)
      const identity = await authorize(request.headers, deployment, policies, verifier)
      const result = store.enqueue(deployment, identity)
      send(response, 202, result); notify(); return
    }
    const match = request.method === 'GET' && /^\/deployments\/([^/?]+)$/.exec(request.url ?? '')
    if (match && uuid.test(match[1])) {
      const row = store.get(match[1])
      if (!row) throw new HttpError(404, 'Deployment not found.')
      const identity = await authorize(request.headers, row, policies, verifier)
      send(response, 200, store.authorizedGet(row.id, identity)); return
    }
    throw new HttpError(404, 'Endpoint not found.')
  }
}
export function gatewayHandler(socketPath: string) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? ''
    if (!((request.method === 'GET' && (path === '/health' || /^\/deployments\/[0-9a-f-]{36}$/.test(path))) || (request.method === 'POST' && path === '/deploy'))) throw new HttpError(404, 'Endpoint not found.')
    const data = await body(request)
    await new Promise<void>((resolve, reject) => {
      const forwarded = httpRequest({ socketPath, method: request.method, path, timeout: 12_000, headers: {
        authorization: request.headers.authorization ?? '', 'cf-access-client-id': request.headers['cf-access-client-id'] ?? '',
        'cf-access-client-secret': request.headers['cf-access-client-secret'] ?? '', 'content-type': request.headers['content-type'] ?? '', 'content-length': data.length,
      } }, upstream => {
        let size = 0; const chunks: Buffer[] = []
        upstream.on('data', chunk => { size += chunk.length; if (size > 16_384) upstream.destroy(new Error('Oversized worker response.')); else chunks.push(chunk) })
        upstream.on('error', reject)
        upstream.on('end', () => {
          try { send(response, upstream.statusCode ?? 503, JSON.parse(Buffer.concat(chunks).toString())); resolve() } catch { reject(new Error('Invalid worker response.')) }
        })
      })
      forwarded.on('timeout', () => forwarded.destroy(new Error('Worker unavailable.')))
      forwarded.on('error', reject); forwarded.end(data)
    })
  }
}
