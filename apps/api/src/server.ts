import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { createApp } from './app.ts'

const env = z
  .object({
    SUPABASE_URL: z.url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  })
  .safeParse(process.env)
if (!env.success)
  throw new Error(
    'Configura SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, HOST, PORT y TRUST_PROXY_HOPS en el servidor.',
  )
const config = env.data
const db = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }) },
})
const server = createApp(
  db,
  config.TRUST_PROXY_HOPS,
  config.SUPABASE_URL.replace(/\/$/, ''),
).listen(config.PORT, config.HOST, () => {
  console.info(`Tickit API v1 listening on ${config.HOST}:${config.PORT}`)
})
server.requestTimeout = 20_000
server.headersTimeout = 10_000
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => {
      server.closeAllConnections()
      process.exit(1)
    }, 10_000).unref()
  })
