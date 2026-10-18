import express from 'express'
import type { ErrorRequestHandler } from 'express'
import { rateLimit } from 'express-rate-limit'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { orderSchema, sessionSchema, tableLinkSchema } from './contracts.ts'

export interface Database {
  rpc(
    name: string,
    params: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>
}
export const hash = (value: string) => createHash('sha256').update(value).digest('hex')
class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
export function createApp(db: Database, trustProxyHops = 0, storageBaseUrl?: string) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', trustProxyHops)
  app.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Request-ID': randomUUID(),
    })
    next()
  })
  app.get('/health', (_req, res) => res.json({ status: 'ok', apiVersion: '1' }))
  app.use(
    '/v1',
    rateLimit({ windowMs: 60_000, limit: 3000, standardHeaders: 'draft-8', legacyHeaders: false }),
  )
  app.use('/v1', async (req, res, next) => {
    const bearer = /^Bearer (tk_[a-f0-9]{64})$/.exec(req.get('authorization') ?? '')
    if (!bearer) throw new ApiError(401, 'INTEGRATION_UNAUTHORIZED')
    const { data, error } = await db.rpc('tickit_api_auth', { p_key_hash: hash(bearer[1]) })
    if (error) throw new ApiError(503, 'SERVICE_UNAVAILABLE')
    if (!data || typeof data !== 'object' || !('id' in data))
      throw new ApiError(401, 'INTEGRATION_UNAUTHORIZED')
    res.locals.integrationId = data.id
    next()
  })
  app.use(
    '/v1',
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      keyGenerator: (_req, res) => String(res.locals.integrationId),
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
  )
  app.use('/v1', express.json({ limit: '64kb', strict: true }))
  const rpc = async (name: string, params: Record<string, unknown>) => {
    const { data, error } = await db.rpc(name, params)
    if (error) {
      const code = error.message
      if (code === 'SESSION_UNAVAILABLE') throw new ApiError(409, code)
      if (code === 'IDEMPOTENCY_CONFLICT') throw new ApiError(409, code)
      if (error.code === '42501') throw new ApiError(403, 'INTEGRATION_UNAVAILABLE')
      if (error.code === '22023' || code.startsWith('CATALOG_'))
        throw new ApiError(422, 'ORDER_INVALID')
      throw new ApiError(503, 'SERVICE_UNAVAILABLE')
    }
    return data
  }
  app.get('/v1/capabilities', async (_req, res) =>
    res.json(await rpc('tickit_api_capabilities', { p_integration_id: res.locals.integrationId })),
  )
  app.get('/v1/catalog', async (_req, res) => {
    const catalog = await rpc('tickit_api_catalog', { p_integration_id: res.locals.integrationId })
    if (
      catalog &&
      typeof catalog === 'object' &&
      'images' in catalog &&
      Array.isArray(catalog.images) &&
      storageBaseUrl
    ) {
      catalog.images = catalog.images.map((image: Record<string, unknown>) => ({
        ...image,
        public_url:
          typeof image.storage_path === 'string'
            ? `${storageBaseUrl}/storage/v1/object/public/product-images/${image.storage_path.split('/').map(encodeURIComponent).join('/')}`
            : null,
      }))
    }
    res.json(catalog)
  })
  app.post('/v1/table-links', async (req, res) => {
    const input = tableLinkSchema.safeParse(req.body)
    if (!input.success) throw new ApiError(422, 'INVALID_REQUEST')
    res.json(
      await rpc('tickit_api_table_link', {
        p_integration_id: res.locals.integrationId,
        p_table_id: input.data.tableId,
      }),
    )
  })
  app.post('/v1/sessions', async (req, res) => {
    const input = sessionSchema.safeParse(req.body)
    if (!input.success) throw new ApiError(422, 'INVALID_REQUEST')
    const token = randomBytes(32).toString('hex')
    const data = await rpc('tickit_api_session', {
      p_integration_id: res.locals.integrationId,
      p_table_hash: hash(input.data.tableToken),
      p_token_hash: hash(token),
    })
    res.status(201).json({ ...(data as object), token })
  })
  app.post('/v1/orders', async (req, res) => {
    const input = orderSchema.safeParse(req.body)
    if (!input.success) throw new ApiError(422, 'INVALID_REQUEST')
    const { sessionToken, idempotencyKey, lines } = input.data
    res.json(
      await rpc('tickit_api_submit', {
        p_integration_id: res.locals.integrationId,
        p_token_hash: hash(sessionToken),
        p_request_id: idempotencyKey,
        p_lines: lines,
      }),
    )
  })
  app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }))
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status =
      error instanceof ApiError
        ? error.status
        : error?.type === 'entity.too.large'
          ? 413
          : error instanceof SyntaxError
            ? 400
            : 500
    res.status(status).json({
      error:
        error instanceof ApiError
          ? error.message
          : status < 500
            ? 'INVALID_REQUEST'
            : 'SERVICE_UNAVAILABLE',
    })
  }
  app.use(errors)
  return app
}
