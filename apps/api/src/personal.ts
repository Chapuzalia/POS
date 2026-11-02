import { Router, json } from 'express'
import { rateLimit } from 'express-rate-limit'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { Database } from './app.ts'
import { staffSnapshotSchema } from './personal-contracts.ts'

const linkSchema = z.object({ contract_version: z.literal(1), connection_id: z.uuid(), organization_id: z.uuid(), external_organization_id: z.uuid(), challenge: z.uuid() }).strict()
const eventSchema = z.object({ contract_version: z.literal(1), event_id: z.uuid(), event_type: z.enum(['staff.created', 'staff.updated', 'staff.deactivated']), occurred_at: z.iso.datetime({ offset: true }), organization_id: z.uuid(), target_organization_id: z.uuid(), payload: staffSnapshotSchema }).strict()

export function personalRouter(db: Database) {
  const router = Router()
  const rawBodies = new WeakMap<object, string>()
  router.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }))
  router.use(json({ limit: '128kb', verify: (req, _res, buffer) => { rawBodies.set(req, buffer.toString('utf8')) } }))
  router.use(async (req, res, next) => {
    const connection = z.uuid().safeParse(req.get('x-tickit-connection'))
    const timestamp = req.get('x-tickit-timestamp') ?? ''
    const signature = req.get('x-tickit-signature') ?? ''
    if (!connection.success || !/^\d{10}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
      res.status(401).json({ error: 'PERSONAL_UNAUTHORIZED' }); return
    }
    const { data, error } = await db.rpc('tickit_personal_credentials', { p_connection_id: connection.data })
    if (error) { res.status(503).json({ error: 'PERSONAL_UNAVAILABLE' }); return }
    const credentials = z.object({ secret: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(data)
    if (!credentials.success) { res.status(401).json({ error: 'PERSONAL_UNAUTHORIZED' }); return }
    const expected = createHmac('sha256', credentials.data.secret).update(`${timestamp}.${rawBodies.get(req) ?? ''}`).digest()
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) { res.status(401).json({ error: 'PERSONAL_UNAUTHORIZED' }); return }
    res.locals.personalConnection = connection.data
    res.locals.personalSecret = credentials.data.secret
    next()
  })
  router.post('/link', async (req, res) => {
    const input = linkSchema.safeParse(req.body)
    if (!input.success || input.data.connection_id !== res.locals.personalConnection) { res.status(422).json({ error: 'PERSONAL_INVALID_LINK' }); return }
    const { data, error } = await db.rpc('tickit_personal_ingest', { p_connection_id: res.locals.personalConnection, p_kind: 'link', p_event: input.data })
    if (error) { res.status(error.code === '42501' ? 403 : 503).json({ error: 'PERSONAL_LINK_FAILED' }); return }
    const timestamp = String(Math.floor(Date.now() / 1000))
    const raw = JSON.stringify({ contract_version: 1, challenge: input.data.challenge, organization_id: data, capabilities: ['staff.snapshot.v1', 'staff.pin.pbkdf2.v1'] })
    res.set({ 'x-tickit-timestamp': timestamp, 'x-tickit-signature': createHmac('sha256', res.locals.personalSecret).update(`${timestamp}.${raw}`).digest('hex'), 'content-type': 'application/json' }).send(raw)
  })
  router.post('/events', async (req, res) => {
    const input = eventSchema.safeParse(req.body)
    if (!input.success) { res.status(422).json({ error: 'PERSONAL_INVALID_EVENT' }); return }
    const { error } = await db.rpc('tickit_personal_ingest', { p_connection_id: res.locals.personalConnection, p_kind: 'event', p_event: input.data })
    if (error) { res.status(error.code === '42501' ? 403 : error.code === '22023' ? 409 : 503).json({ error: 'PERSONAL_EVENT_FAILED' }); return }
    res.json({ event_id: input.data.event_id })
  })
  return router
}
