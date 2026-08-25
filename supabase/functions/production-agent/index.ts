import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Headers': 'content-type, x-production-agent-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
}

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: corsHeaders, status })
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function randomSecret() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return reply({ error: 'Método no permitido' }, 405)
  try {
    const url = Deno.env.get('SUPABASE_URL')
    const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !serviceRole) return reply({ error: 'Servicio no configurado' }, 503)
    const admin = createClient(url, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } })
    const body = await request.json() as Record<string, unknown>
    const action = String(body.action ?? '')

    if (action === 'pair') {
      const code = String(body.code ?? '').trim().toUpperCase()
      const instanceId = String(body.instanceId ?? '').trim()
      const version = String(body.version ?? '').trim()
      if (!/^[A-Z0-9]{12}$/.test(code) || instanceId.length < 8 || instanceId.length > 200 || !version) {
        return reply({ error: 'Código, instancia o versión no válidos' }, 400)
      }
      const secret = randomSecret()
      const { data, error } = await admin.rpc('exchange_print_agent_pairing', {
        p_code_hash: await sha256(code),
        p_instance_id: instanceId,
        p_secret_hash: await sha256(secret),
        p_version: version,
      })
      if (error) throw error
      return reply({ ...data, secret })
    }

    const rawSecret = request.headers.get('x-production-agent-secret') ?? ''
    if (rawSecret.length < 32) return reply({ error: 'Agente no autenticado' }, 401)
    const { data: agent, error: agentError } = await admin
      .from('production_print_agents')
      .select('id, is_active')
      .eq('secret_hash', await sha256(rawSecret))
      .maybeSingle()
    if (agentError) throw agentError
    if (!agent?.is_active) return reply({ error: 'Agente revocado' }, 401)

    if (action === 'heartbeat') {
      const printers = Array.isArray(body.printers) ? body.printers.slice(0, 50) : []
      const { data, error } = await admin.rpc('heartbeat_print_agent', {
        p_agent_id: agent.id,
        p_version: String(body.version ?? ''),
        p_capability: body.productionCapability === true,
        p_worker_state: String(body.workerState ?? 'error'),
        p_printers: printers,
      })
      if (error) throw error
      return reply(data)
    }

    if (action === 'claim') {
      const leaseToken = String(body.leaseToken ?? crypto.randomUUID())
      const limit = Math.min(Math.max(Number(body.limit ?? 5), 1), 20)
      const { data, error } = await admin.rpc('claim_production_dispatches', {
        p_agent_id: agent.id,
        p_lease_token: leaseToken,
        p_limit: limit,
      })
      if (error) throw error
      return reply({ leaseToken, dispatches: data ?? [] })
    }

    if (action === 'ack') {
      const { data, error } = await admin.rpc('ack_production_dispatch', {
        p_agent_id: agent.id,
        p_dispatch_id: String(body.dispatchId ?? ''),
        p_lease_token: String(body.leaseToken ?? ''),
        p_status: String(body.status ?? ''),
        p_error_code: body.errorCode ? String(body.errorCode) : null,
        p_error_message: body.errorMessage ? String(body.errorMessage) : null,
        p_result: body.result ?? null,
      })
      if (error) throw error
      return reply(data)
    }

    return reply({ error: 'Acción no soportada' }, 404)
  } catch (cause) {
    const error = cause as { message?: string }
    return reply({ error: error.message ?? 'Error interno' }, 400)
  }
})
