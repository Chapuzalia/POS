import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.115.0'
import { z } from 'npm:zod@4.4.3'
import { MollieRequestError } from './billing/mollie.ts'
import type { MollieGateway, MollieSubscription } from './billing/mollie.ts'

// cus_ rows are legacy Stripe sandbox links: there is no Mollie resource to remove.
const jobSchema = z.object({
  tenant_id: z.uuid(), request_id: z.uuid(), stripe_customer_id: z.string().regex(/^(cst|cus)_[a-zA-Z0-9]+$/).nullable(),
  stripe_subscription_id: z.string().regex(/^sub_[a-zA-Z0-9]+$/).nullable(), user_ids: z.array(z.uuid()), database_purged: z.boolean(),
})
const objectsSchema = z.array(z.object({ bucket_id: z.string().min(1), name: z.string().min(1) })).max(200)

export class TenantDeletionError extends Error {
  readonly status: number
  constructor(message: string, status = 503) { super(message); this.status = status }
}

const missingProviderResource = (error: unknown) => error instanceof MollieRequestError && [404, 410].includes(error.diagnostic.status)

/** Every phase is retryable. Keep the inactive tenant/job until all cleanup succeeds. */
export async function deletePlatformTenantData(
  db: SupabaseClient, tenantId: string, actorId: string, mollie: () => MollieGateway,
) {
  if (!z.uuid().safeParse(tenantId).success) throw new TenantDeletionError('Negocio no válido.', 400)
  const params = { p_tenant_id: tenantId, p_actor_id: actorId }
  const prepared = await db.rpc('prepare_platform_tenant_deletion', params)
  if (prepared.error) {
    if (prepared.error.message === 'TENANT_DELETION_BILLING_BUSY') {
      throw new TenantDeletionError('Hay una operación de facturación en curso. Espera a que termine y vuelve a eliminar el negocio.', 409)
    }
    throw new TenantDeletionError('No se pudo preparar la eliminación del negocio. Puedes volver a intentarlo.')
  }
  // Also acknowledges a retry after the final successful response was lost.
  if (!prepared.data) return
  const job = jobSchema.parse(prepared.data)
  if (job.tenant_id !== tenantId) throw new TenantDeletionError('No se pudo verificar el negocio que se va a eliminar.')

  if (!job.database_purged) {
    try {
      const customerId = job.stripe_customer_id
      if (customerId?.startsWith('cst_')) {
        const gateway = mollie()
        const customer = await gateway.request<{ id: string; metadata?: Record<string, string> | null }>('GET', `/customers/${customerId}`)
        if (customer.id !== customerId || customer.metadata?.tickit_tenant_id !== tenantId) throw new Error('TENANT_DELETION_PROVIDER_MISMATCH')
        // Stop every future charge explicitly before removing the customer.
        const subscriptions = await gateway.list<MollieSubscription>(`/customers/${customerId}/subscriptions`, 'subscriptions')
        for (const subscription of subscriptions.filter(row => ['active', 'pending', 'suspended'].includes(row.status))) {
          await gateway.request('DELETE', `/customers/${customerId}/subscriptions/${subscription.id}`, undefined, `tenant-purge:${job.request_id}:${subscription.id}`)
        }
        await gateway.request('DELETE', `/customers/${customerId}`, undefined, `tenant-purge:${job.request_id}:customer`)
      }
    } catch (error) {
      if (!missingProviderResource(error)) throw new TenantDeletionError('No se pudo confirmar la baja en Mollie. El negocio queda desactivado; vuelve a eliminarlo para continuar.')
    }

    // Use the Storage API to remove physical files, including abandoned uploads.
    // Re-read the first page after each batch; offsets would skip deleted objects.
    let previousPage = ''
    for (let batch = 0; ; batch++) {
      const result = await db.rpc('list_platform_tenant_deletion_objects', { p_tenant_id: tenantId })
      if (result.error) throw new TenantDeletionError('No se pudieron consultar los archivos del negocio. Vuelve a eliminarlo para continuar.')
      const objects = objectsSchema.parse(result.data)
      if (!objects.length) break
      const page = JSON.stringify(objects)
      if (batch === 50 || page === previousPage) throw new TenantDeletionError('Quedan archivos por eliminar. Vuelve a eliminar el negocio para continuar.')
      previousPage = page
      const buckets = new Map<string, string[]>()
      for (const object of objects) {
        if (!object.name.startsWith(`${tenantId}/`)) throw new TenantDeletionError('No se pudo verificar la pertenencia de un archivo al negocio.')
        const paths = buckets.get(object.bucket_id) ?? []
        paths.push(object.name)
        buckets.set(object.bucket_id, paths)
      }
      for (const [bucket, paths] of buckets) {
        const removed = await db.storage.from(bucket).remove(paths)
        if (removed.error) throw new TenantDeletionError('No se pudieron eliminar todos los archivos. El negocio queda desactivado; vuelve a eliminarlo para continuar.')
      }
    }
    const purged = await db.rpc('purge_platform_tenant_data', params)
    if (purged.error) throw new TenantDeletionError('No se pudieron eliminar todos los registros. El negocio queda desactivado; vuelve a eliminarlo para continuar.')
  }

  for (const userId of job.user_ids.slice(0, 25)) {
    // Preparation reserves these exclusive identities against reassignment.
    // Recheck before hard deletion; any lookup failure must stop completion.
    const [membership, profile] = await Promise.all([
      db.from('tenant_memberships').select('id').eq('user_id', userId).limit(1).maybeSingle(),
      db.from('profiles').select('is_superadmin').eq('id', userId).maybeSingle(),
    ])
    if (membership.error || profile.error || membership.data || profile.data?.is_superadmin === true || userId === actorId) {
      throw new TenantDeletionError('No se pudo verificar la eliminación de los usuarios exclusivos. Vuelve a eliminar el negocio para continuar.')
    }
    const removed = await db.auth.admin.deleteUser(userId)
    if (removed.error && removed.error.code !== 'user_not_found') {
      throw new TenantDeletionError('No se pudieron eliminar todos los usuarios exclusivos. Vuelve a eliminar el negocio para continuar.')
    }
    const acknowledged = await db.rpc('ack_platform_tenant_deleted_user', { p_tenant_id: tenantId, p_user_id: userId })
    if (acknowledged.error) throw new TenantDeletionError('No se pudo confirmar la eliminación de un usuario. Vuelve a eliminar el negocio para continuar.')
  }
  if (job.user_ids.length > 25) throw new TenantDeletionError('Quedan usuarios por eliminar. Vuelve a eliminar el negocio para continuar.')
  const finished = await db.rpc('finish_platform_tenant_deletion', params)
  if (finished.error) throw new TenantDeletionError('La eliminación todavía no se ha completado. Vuelve a eliminar el negocio para continuar.')
}
