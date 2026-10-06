import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.0'
import { z } from 'zod'

const headers = { 'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { ...headers, 'Content-Type': 'application/json' },
})
const inputSchema = z.object({ documentId: z.uuid(), venueId: z.uuid(), tenantId: z.uuid(),
  reverseStock: z.boolean().nullable() }).strict()
const deletionSchema = z.object({ documentId: z.uuid(), storageBucket: z.string().nullable(),
  storagePath: z.string().nullable(), storageDeleted: z.boolean(), stockReversed: z.boolean() })
const messages: Record<string, string> = {
  SUPPLIER_DOCUMENT_STOCK_CHOICE_REQUIRED: 'El documento ha registrado stock. Actualiza el listado y elige si quieres anularlo antes de eliminar.',
  SUPPLIER_DOCUMENT_NOT_FOUND: 'Documento no encontrado o sin acceso.',
  SUPPLIER_DOCUMENT_FORBIDDEN: 'No tienes permiso para eliminar este documento.',
  SUPPLIER_DOCUMENT_ADDON_DISABLED: 'La gestión de documentos no está disponible.',
  INVENTORY_ITEM_NOT_FOUND: 'No se puede anular el stock porque un artículo ya no está activo. Puedes eliminar el documento conservando el stock.',
  INVENTORY_WAREHOUSE_NOT_FOUND: 'No se puede anular el stock porque un almacén ya no está activo. Puedes eliminar el documento conservando el stock.',
}

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
    const input = inputSchema.safeParse(await request.json())
    if (!input.success) return json({ error: 'Datos de eliminación no válidos.' }, 400)
    const { data, error } = await user.rpc('delete_supplier_document', {
      p_document_id: input.data.documentId, p_venue_id: input.data.venueId,
      p_tenant_id: input.data.tenantId, p_reverse_stock: input.data.reverseStock,
    })
    if (error) return json({ error: messages[error.message] ?? 'No se pudo eliminar el documento.' },
      error.code === '42501' ? 403 : error.code === 'P0002' ? 404 : 409)
    const deletion = deletionSchema.parse(data)
    if (deletion.documentId !== input.data.documentId) throw new Error('INVALID_DELETION_RESULT')
    let storageDeleted = deletion.storageDeleted
    if (!storageDeleted) {
      const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
      const path = deletion.storagePath
      const hasOriginal = deletion.storageBucket !== null && path !== null
      // Paths come from the authorized RPC, and still must name exactly this
      // project's document. No bucket/path supplied by the caller is accepted.
      const validPath = deletion.storageBucket === 'supplier-documents'
        && path?.startsWith(`${input.data.tenantId}/${input.data.venueId}/${deletion.documentId}/`)
      if (!hasOriginal || validPath) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const removal = path && deletion.storageBucket ? await admin.storage.from('supplier-documents').remove([path]) : { error: null }
            if (removal.error) continue
            const finished = await admin.rpc('finish_supplier_document_deletion', { p_document_id: deletion.documentId })
            storageDeleted = !finished.error
            if (storageDeleted) break
          } catch {
            // The document/stock transaction has committed. A file cleanup
            // failure remains retryable and must not report the deletion failed.
          }
        }
      }
    }
    return json({ documentId: deletion.documentId, stockReversed: deletion.stockReversed, storageDeleted })
  } catch {
    return json({ error: 'No se pudo completar la eliminación del documento.' }, 500)
  }
})
