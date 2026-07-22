import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { extname } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { assertValidCatalog, validateCatalog } from './contract.mjs'
import { stableJson } from './conversion.mjs'

const MIME_EXTENSIONS = new Map([
  ['image/webp', 'webp'], ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'],
  ['image/avif', 'avif'], ['image/svg+xml', 'svg'],
])

export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

export function detectImageType(bytes, declaredType = null, sourcePath = '') {
  const b = Buffer.from(bytes)
  let mimeType = null
  if (b.subarray(0, 12).toString('ascii', 0, 4) === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') mimeType = 'image/webp'
  else if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mimeType = 'image/png'
  else if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) mimeType = 'image/jpeg'
  else if (b.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) mimeType = 'image/gif'
  else if (b.subarray(4, 12).toString('ascii').includes('ftypavif')) mimeType = 'image/avif'
  else if (b.subarray(0, 512).toString('utf8').trimStart().match(/^<\?xml|^<svg/i)) mimeType = 'image/svg+xml'
  if (!mimeType && declaredType && MIME_EXTENSIONS.has(declaredType.split(';')[0].trim())) mimeType = declaredType.split(';')[0].trim()
  if (!mimeType) {
    const ext = extname(sourcePath).slice(1).toLowerCase().replace('jpeg', 'jpg')
    mimeType = [...MIME_EXTENSIONS].find(([, candidate]) => candidate === ext)?.[0] ?? null
  }
  if (!mimeType) throw new Error(`Tipo de imagen no reconocido para ${sourcePath || '<binario>'}`)
  return { mimeType, extension: MIME_EXTENSIONS.get(mimeType) }
}

export async function createCatalogArchive(document, { loadImage, conversionReport = '', createdAt = new Date().toISOString() } = {}) {
  const output = structuredClone(document)
  const files = {}
  const manifestImages = []
  const warnings = []
  const fileByChecksum = new Map()
  for (const entry of output.catalog.images) {
    let loaded = null
    try { loaded = await loadImage?.(entry) }
    catch (error) { warnings.push({ level: 'WARNING', code: 'MISSING_IMAGE', ref: entry.ref, productRef: entry.productRef, message: error.message }) }
    if (!loaded?.bytes?.length) {
      entry.file = null; entry.mimeType = null; entry.sizeBytes = null; entry.sha256 = null; entry.missing = true
      if (!warnings.some((item) => item.ref === entry.ref)) warnings.push({ level: 'WARNING', code: 'MISSING_IMAGE', ref: entry.ref, productRef: entry.productRef, message: 'No se pudo descargar el binario.' })
      manifestImages.push({ ref: entry.ref, productRef: entry.productRef, file: null, mimeType: null, sizeBytes: null, sha256: null, missing: true })
      continue
    }
    const bytes = new Uint8Array(loaded.bytes)
    const digest = sha256(bytes)
    const type = detectImageType(bytes, loaded.mimeType, entry.source?.path)
    const priorFile = fileByChecksum.get(digest)
    const file = priorFile ?? `images/${entry.ref}.${type.extension}`
    if (!priorFile) { files[file] = bytes; fileByChecksum.set(digest, file) }
    entry.file = file; entry.mimeType = type.mimeType; entry.sizeBytes = bytes.byteLength; entry.sha256 = digest; entry.missing = false
    manifestImages.push({ ref: entry.ref, productRef: entry.productRef, file, mimeType: type.mimeType, sizeBytes: bytes.byteLength, sha256: digest, missing: false, deduplicated: Boolean(priorFile) })
  }
  output.metadata.counts.images = output.catalog.images.length
  const validation = assertValidCatalog(output)
  const manifest = {
    format: 'club-pos-catalog-archive', schemaVersion: output.schemaVersion, createdAt,
    catalogSha256: sha256(strToU8(stableJson(output))), images: manifestImages, warnings,
    validation: { counts: validation.counts },
  }
  files['catalog.json'] = strToU8(stableJson(output))
  files['conversion-report.md'] = strToU8(conversionReport)
  files['manifest.json'] = strToU8(stableJson(manifest))
  return { bytes: zipSync(files, { level: 9 }), document: output, manifest, warnings }
}

export function writeCatalogArchive(file, archive) { writeFileSync(file, archive.bytes) }

function parseJson(files, name) {
  if (!files[name]) throw new Error(`ZIP incompleto: falta ${name}`)
  try { return JSON.parse(strFromU8(files[name])) } catch (error) { throw new Error(`${name} no contiene JSON válido: ${error.message}`) }
}

export function readCatalogArchive(fileOrBytes) {
  let files
  try { files = unzipSync(typeof fileOrBytes === 'string' ? new Uint8Array(readFileSync(fileOrBytes)) : fileOrBytes) }
  catch (error) { throw new Error(`ZIP corrupto: ${error.message}`) }
  for (const name of Object.keys(files)) if (name.startsWith('/') || name.includes('..') || name.includes('\\')) throw new Error(`Ruta insegura en ZIP: ${name}`)
  const document = parseJson(files, 'catalog.json')
  const manifest = parseJson(files, 'manifest.json')
  if (!files['conversion-report.md']) throw new Error('ZIP incompleto: falta conversion-report.md')
  assertValidCatalog(document)
  const catalogDigest = sha256(files['catalog.json'])
  if (catalogDigest !== manifest.catalogSha256) throw new Error('Checksum incorrecto de catalog.json')
  for (const image of manifest.images ?? []) {
    const contractImage = document.catalog.images.find((item) => item.ref === image.ref)
    if (!contractImage) throw new Error(`Imagen ${image.ref} no existe en catalog.json`)
    if (image.missing) continue
    if (!image.file || !files[image.file]) throw new Error(`Imagen ausente del ZIP: ${image.ref}`)
    if (sha256(files[image.file]) !== image.sha256 || image.sha256 !== contractImage.sha256) throw new Error(`Checksum incorrecto de imagen: ${image.ref}`)
    if (files[image.file].byteLength !== image.sizeBytes || image.sizeBytes !== contractImage.sizeBytes) throw new Error(`Tamaño incorrecto de imagen: ${image.ref}`)
  }
  return { document, manifest, files, conversionReport: strFromU8(files['conversion-report.md']), validation: validateCatalog(document) }
}
