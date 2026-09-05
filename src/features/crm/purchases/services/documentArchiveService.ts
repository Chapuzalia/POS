import { requireSupabase } from '../../shared/services/crmServiceSupport'
import type { SupplierDocumentType } from '../../supplier-documents/types'

export type ArchiveMetadata = { supplierId: string | null; documentDate: string; documentNumber: string }

export async function saveDocumentArchive(documentId: string, metadata: ArchiveMetadata) {
  const { error } = await requireSupabase().rpc('save_supplier_document_archive', {
    p_document_id: documentId, p_supplier_id: metadata.supplierId,
    p_document_date: metadata.documentDate, p_document_number: metadata.documentNumber,
  })
  if (error) throw error
}

export async function uploadDocumentArchive(venueId: string, documentType: SupplierDocumentType, file: File, metadata: ArchiveMetadata) {
  const client = requireSupabase()
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
  const { data, error } = await client.rpc('create_supplier_document_archive', {
    p_venue_id: venueId, p_document_type: documentType, p_original_file_name: file.name,
    p_original_mime_type: file.type || 'application/octet-stream', p_file_hash: hash,
  })
  if (error) throw error
  const created = data as { documentId: string; storageBucket: string; storagePath: string; duplicate: boolean }
  const storage = client.storage.from(created.storageBucket)
  // A previous upload may have failed after reserving the document row.
  const existing = created.duplicate ? await storage.download(created.storagePath) : null
  if (!existing?.data) {
    const { error: uploadError } = await storage.upload(created.storagePath, file, { contentType: file.type || undefined, upsert: false })
    if (uploadError) throw uploadError
  }
  await saveDocumentArchive(created.documentId, metadata)
  return created.documentId
}
