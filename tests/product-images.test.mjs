import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { convertImageFileToWebp, isProductImageWebp, PRODUCT_IMAGE_TYPE } from '../src/lib/productImages.ts'

const scanService = await readFile(new URL('../src/features/crm/supplier-documents/services/supplierDocumentService.ts', import.meta.url), 'utf8')
const archiveService = await readFile(new URL('../src/features/crm/purchases/services/documentArchiveService.ts', import.meta.url), 'utf8')

const webpSignature = new Uint8Array([
  0x52, 0x49, 0x46, 0x46,
  0x04, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50,
])

test('product image validation requires both the WebP MIME and RIFF/WEBP signature', async () => {
  assert.equal(await isProductImageWebp(new Blob([webpSignature], { type: PRODUCT_IMAGE_TYPE })), true)
  assert.equal(await isProductImageWebp(new Blob([webpSignature], { type: 'image/png' })), false)
  assert.equal(await isProductImageWebp(new Blob(['not-webp'], { type: PRODUCT_IMAGE_TYPE })), false)
})

test('document uploads keep PDFs intact and normalize existing WebP images to a .webp File', async () => {
  const pdf = new File(['pdf'], 'factura.pdf', { type: 'application/pdf' })
  assert.equal(await convertImageFileToWebp(pdf), pdf)

  const image = new File([webpSignature], 'albaran.jpeg', {
    lastModified: 123,
    type: PRODUCT_IMAGE_TYPE,
  })
  const converted = await convertImageFileToWebp(image)
  assert.equal(converted.name, 'albaran.webp')
  assert.equal(converted.type, PRODUCT_IMAGE_TYPE)
  assert.equal(converted.lastModified, image.lastModified)
  assert.equal(await isProductImageWebp(converted), true)
})

test('scan and archive uploads reserve and upload the converted document file', () => {
  for (const service of [scanService, archiveService]) {
    assert.match(service, /const uploadFile = await convertImageFileToWebp\(file\)/)
    assert.match(service, /p_original_file_name: uploadFile\.name/)
    assert.match(service, /p_original_mime_type: uploadFile\.type/)
    assert.match(service, /\.upload\(created\.storagePath, uploadFile,/)
  }
})
