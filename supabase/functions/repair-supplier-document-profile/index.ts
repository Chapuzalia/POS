import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.0'
import { OpenAiSupplierDocumentProvider, type SupplierAiTrace } from '../_shared/supplier-documents/providers.ts'
import { proposeConfirmedProfileRepair } from '../_shared/supplier-documents/profileRepair.ts'

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }
const headers = { 'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { ...headers, 'Content-Type': 'application/json' },
})

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return json({ error: 'Método no permitido' }, 405)
  try {
    const authorization = request.headers.get('Authorization')
    if (!authorization) return json({ error: 'Autorización requerida' }, 401)
    const url = Deno.env.get('SUPABASE_URL')!
    const user = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authorization } }, auth: { persistSession: false },
    })
    const { data: auth, error: authError } = await user.auth.getUser()
    if (authError || !auth.user) return json({ error: 'Sesión no válida' }, 401)
    const { documentId } = await request.json()
    if (typeof documentId !== 'string') return json({ error: 'documentId es obligatorio' }, 400)
    const { data: accessible, error: accessError } = await user.from('supplier_documents')
      .select('id').eq('id', documentId).maybeSingle()
    if (accessError || !accessible) return json({ error: 'Documento no encontrado o sin acceso' }, 404)
    const { error: featureError } = await user.rpc('assert_supplier_document_scanning', { p_document_id: documentId })
    if (featureError) return json({ error: 'Escaneo no disponible' }, 403)
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
    const { data: claim, error: claimError } = await admin.rpc('claim_supplier_profile_repair', { p_document_id: documentId })
    if (claimError) throw claimError
    if (!claim) return json({ status: 'not_pending' })
    EdgeRuntime.waitUntil((async () => {
      const traces: SupplierAiTrace[] = []
      let rules = null
      let failure: string | null = null
      try {
        const provider = new OpenAiSupplierDocumentProvider({
          apiKey: Deno.env.get('OPENAI_API_KEY') ?? '', model: Deno.env.get('OPENAI_SUPPLIER_DOCUMENT_MODEL') ?? '',
          onResponse: async (trace) => { traces.push(trace) },
        })
        rules = await proposeConfirmedProfileRepair({ ...claim, propose: (input) => provider.proposeProfile(input) })
      } catch (error) {
        failure = error instanceof Error ? error.message : 'PROFILE_REPAIR_FAILED'
      }
      const { error } = await admin.rpc('finish_supplier_profile_repair', {
        p_document_id: documentId, p_token: claim.token, p_rules: rules, p_error: failure, p_traces: traces,
      })
      if (error) console.error('Could not persist supplier profile repair', error)
    })())
    return json({ status: 'processing' }, 202)
  } catch (error) {
    console.error('Could not start supplier profile repair', error)
    return json({ error: 'No se pudo iniciar la reparación del perfil' }, 500)
  }
})
