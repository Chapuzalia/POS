import { strToU8, zip } from 'fflate'
import { z } from 'zod'
import { requireSupabase } from '../../../services/backendService'
import { UserFacingError } from '../../../utils/UserFacingError'

const collectionName = z.string().regex(/^[a-z][a-z0-9_]*$/)
const manifestSchema = z.object({
  format: z.literal('tickit-tenant-export'), schemaVersion: z.literal(1), readAt: z.string(),
  collections: z.array(z.object({ name: collectionName, columns: z.array(z.object({ name: z.string(), type: z.string(), encoding: z.string() })).min(1), schemaToken: z.string().optional() })).min(1),
  schemaChanges: z.array(z.object({ collection: collectionName, reason: z.enum(['table_unavailable', 'columns_unavailable']), columns: z.array(z.string()).optional() })).optional(),
})
const pageSchema = z.object({
  rows: z.array(z.string()), next: z.array(z.union([z.string(), z.number()])).nullable(), readAt: z.string(),
  schemaToken: z.string().optional(),
  files: z.array(z.object({ id: z.string().uuid(), bucket: z.string().nullable(), path: z.string().nullable(), mimeType: z.string().nullable(), sha256: z.string().nullable() })).optional(),
})

async function hash(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function compress(files: Record<string, Uint8Array>) {
  return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    zip(files, { level: 6 }, (error, bytes) => error ? reject(error) : resolve(bytes as Uint8Array<ArrayBuffer>))
  })
}

/** Reads only. Never changes billing, fiscal records, local queues or business data. */
export async function buildTenantExport(tenantId: string, onProgress: (message: string) => void) {
  const client = requireSupabase()
  async function request(collection: string | null, after: Array<string | number> | null) {
    const { data, error } = await client.rpc('export_tenant_data', { p_tenant_id: tenantId, p_collection: collection, p_after: after })
    if (error) {
      if (error.message === 'EXPORT_SCHEMA_CHANGED' || error.message === 'EXPORT_INVALID_CURSOR') throw new UserFacingError('La estructura de los datos ha cambiado durante la exportación. Vuelve a iniciarla.')
      if (error.message === 'EXPORT_SCHEMA_UNAVAILABLE') throw new UserFacingError('La estructura de los datos no permite una exportación segura. Contacta con Alteil para revisarla.')
      throw new UserFacingError('No se ha podido leer la exportación. Comprueba tu sesión de propietario y que el servidor esté actualizado.')
    }
    return data
  }
  const manifestResult = manifestSchema.safeParse(await request(null, null))
  if (!manifestResult.success) throw new UserFacingError('El servidor ha devuelto un índice de exportación no válido. Comprueba que esté actualizado.')
  const manifest = manifestResult.data
  if (new Set(manifest.collections.map(item => item.name)).size !== manifest.collections.length) throw new UserFacingError('El índice de la exportación no es válido.')
  const files: Record<string, Uint8Array> = {}
  const entries: Array<{ file: string; rows?: number; bytes: number; sha256: string; readAt?: string }> = []
  async function add(file: string, bytes: Uint8Array<ArrayBuffer>, metadata: { rows?: number; readAt?: string } = {}) {
    if (files[file]) throw new UserFacingError('El servidor ha devuelto un fichero duplicado.')
    files[file] = bytes
    entries.push({ file, ...metadata, bytes: bytes.byteLength, sha256: await hash(bytes) })
  }
  for (const [index, collection] of manifest.collections.entries()) {
    onProgress(`Leyendo ${collection.name} (${index + 1}/${manifest.collections.length})`)
    let after: Array<string | number> | null = null
    let pageNumber = 0
    for (;;) {
      const pageResult = pageSchema.safeParse(await request(collection.name, after))
      if (!pageResult.success) throw new UserFacingError('El servidor ha devuelto una página de exportación no válida. Comprueba que esté actualizado.')
      const page = pageResult.data
      if (collection.schemaToken && page.schemaToken !== collection.schemaToken) throw new UserFacingError('La estructura de los datos ha cambiado durante la exportación. Vuelve a iniciarla.')
      if (page.rows.length && (!page.next || JSON.stringify(page.next) === JSON.stringify(after))) throw new UserFacingError('La exportación no ha podido avanzar. Vuelve a intentarlo.')
      const rowIndexes = new Map<unknown, number>()
      page.rows.forEach((text, index) => {
        try {
          const parsed = z.record(z.string(), z.unknown()).parse(JSON.parse(text))
          if (typeof parsed.id === 'string') rowIndexes.set(parsed.id, index)
        } catch {
          // Never send a parser error containing customer/fiscal data to telemetry.
          throw new UserFacingError('Un registro de la exportación no es válido. Contacta con Alteil para revisarlo.')
        }
      })
      for (const attachment of page.files ?? []) {
        if (!attachment.bucket || !attachment.path) throw new UserFacingError('Un documento no tiene su fichero original. Contacta con Alteil para completar la exportación.')
        const { data: blob, error } = await client.storage.from(attachment.bucket).download(attachment.path)
        if (error || !blob) throw new UserFacingError('No se ha podido descargar un fichero. No se ha generado una exportación incompleta; vuelve a intentarlo o contacta con Alteil.')
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const digest = await hash(bytes)
        if (attachment.sha256 && attachment.sha256.toLowerCase() !== digest) throw new UserFacingError('Un fichero ha cambiado o no supera la comprobación de integridad. Repite la exportación o contacta con Alteil.')
        const extension = ({ 'image/webp': '.webp', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/avif': '.avif', 'image/gif': '.gif', 'application/pdf': '.pdf' } as Record<string, string>)[attachment.mimeType ?? ''] ?? '.bin'
        const file = `assets/${collection.name}/${attachment.id}${extension}`
        const rowIndex = rowIndexes.get(attachment.id)
        if (rowIndex === undefined) throw new UserFacingError('Un fichero no corresponde a los datos exportados.')
        // Preserve the server's exact numeric literals, including nested snapshots.
        const row = page.rows[rowIndex].trimEnd()
        page.rows[rowIndex] = `${row.slice(0, -1)},"attachment":${JSON.stringify(file)}}`
        await add(file, bytes)
      }
      pageNumber += 1
      await add(`data/${collection.name}/${pageNumber}.ndjson`, strToU8(page.rows.join('\n') + (page.rows.length ? '\n' : '')), { rows: page.rows.length, readAt: page.readAt })
      if (!page.rows.length) break
      after = page.next
    }
  }
  await add('schema.json', strToU8(JSON.stringify(manifest, null, 2)))
  files['manifest.json'] = strToU8(JSON.stringify({
    format: manifest.format, schemaVersion: manifest.schemaVersion, startedAt: manifest.readAt, completedAt: new Date().toISOString(),
    consistency: 'live-paginated-reads', entries,
    schemaChanges: manifest.schemaChanges ?? [],
    exclusions: ['Credenciales, sesiones, claves, emparejamiento y secretos de seguridad', 'Datos de otras empresas, reglas globales de OCR, diagnóstico e infraestructura de Alteil', 'Colas offline y configuraciones que solo permanecen en los dispositivos'],
    notes: ['Los identificadores mantienen las relaciones entre los datos; no son credenciales.', 'Los importes *cents son céntimos enteros; numeric y bigint se representan como texto decimal para conservar su precisión.', 'La lectura no bloquea las ventas. Puede haber cambios entre páginas; concilia los datos y repite la extracción final al completar la migración.', 'No se incluyen ficheros ya eliminados; sus metadatos conservan la fecha de eliminación.', 'Las imágenes de compras pueden estar normalizadas a WebP. file_hash identifica la entrada anterior a esa conversión; las huellas de este manifiesto identifican los bytes conservados y descargados.'],
  }, null, 2))
  onProgress('Preparando ZIP…')
  return new Blob([await compress(files)], { type: 'application/zip' })
}

export async function downloadTenantExport(tenantId: string, onProgress: (message: string) => void) {
  const blob = await buildTenantExport(tenantId, onProgress)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `tickit-datos-${new Date().toISOString().slice(0, 10)}.zip`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
