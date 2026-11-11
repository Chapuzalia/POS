import { createClient } from 'npm:@supabase/supabase-js@2.115.0'
import { forwardPersonalActivation } from '../_shared/personal-activation.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  const reply = (error: string, status: number) => Response.json({ error }, { status, headers: cors })
  if (request.method !== 'POST') return reply('Método no permitido.', 405)
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_ANON_KEY')
  const authorization = request.headers.get('authorization') ?? ''
  if (!url || !key) return reply('La activación de Personal todavía no está configurada.', 503)
  if (!authorization.startsWith('Bearer ')) return reply('Inicia sesión en el POS.', 401)
  try {
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authorization } },
    })
    const identity = await client.auth.getUser()
    if (identity.error || !identity.data.user) return reply('Inicia sesión en el POS.', 401)
    const response = await forwardPersonalActivation(request, {
      url: Deno.env.get('PERSONAL_SUPABASE_URL') ?? '',
      anonKey: Deno.env.get('PERSONAL_SUPABASE_ANON_KEY') ?? '',
    })
    const headers = new Headers(response.headers)
    for (const [name, value] of Object.entries(cors)) headers.set(name, value)
    return new Response(response.body, { status: response.status, headers })
  } catch { return reply('No se pudo activar Personal. Reintenta la operación.', 502) }
})
