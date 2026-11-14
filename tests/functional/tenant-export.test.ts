import { createHash } from 'node:crypto'
import { strFromU8, unzipSync } from 'fflate'
import { beforeEach, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'

const api = vi.hoisted(() => ({ rpc: vi.fn(), download: vi.fn() }))
vi.mock('../../src/services/backendService', () => ({ requireSupabase: () => ({ rpc: api.rpc, storage: { from: () => ({ download: api.download }) } }) }))
const { buildTenantExport } = await import('../../src/features/crm/documentation/tenantExportService')
const image = '00000000-0000-4000-8000-000000000001'
const readAt = '2026-11-13T10:00:00Z'
const manifest = {
  format: 'tickit-tenant-export', schemaVersion: 1, readAt,
  collections: ['tickets','product_images'].map(name => ({ name, columns: [{ name: 'id', type: 'uuid', encoding: 'json' }] })),
}
let brokenCursor = false
beforeEach(() => {
  brokenCursor = false
  api.rpc.mockReset()
  api.download.mockReset()
  api.rpc.mockImplementation(async (_name, args) => {
    if (!args.p_collection) return { data: manifest, error: null }
    if (args.p_after) return { data: { rows: [], next: null, readAt }, error: null }
    return { data: { rows: [`{"id":"${image}","total_cents":1210,"ticket_number":"9007199254740993","customer_snapshot":{"name":"Nombre histórico","precise":1234567890123456789.123456789}}`],
      next: brokenCursor ? null : [image], readAt,
      ...(args.p_collection === 'product_images' ? { files: [{ id: image, bucket: 'product-images', path: 'private/path', mimeType: 'image/webp', sha256: createHash('sha256').update('image-bytes').digest('hex'), internalDiagnostic: 'TRANSPORT_ONLY' }] } : {}),
    }, error: null }
  })
  api.download.mockImplementation(async () => ({ data: new Blob(['image-bytes']), error: null }))
})

it('packages structured data, original bytes, schema and verifiable checksums without private storage references', async () => {
  const progress = vi.fn()
  const blob = await buildTenantExport('tenant',progress)
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  const index = JSON.parse(strFromU8(files['manifest.json']))
  const ticket = JSON.parse(strFromU8(files['data/tickets/1.ndjson']).trim())
  expect(ticket).toMatchObject({ total_cents: 1210, ticket_number: '9007199254740993', customer_snapshot: { name: 'Nombre histórico' } })
  expect(strFromU8(files['data/tickets/1.ndjson'])).toContain('1234567890123456789.123456789')
  expect(strFromU8(files['data/product_images/1.ndjson'])).toContain('1234567890123456789.123456789')
  expect(strFromU8(files[`assets/product_images/${image}.webp`])).toBe('image-bytes')
  expect(JSON.parse(strFromU8(files['data/product_images/1.ndjson'])).attachment).toBe(`assets/product_images/${image}.webp`)
  expect(JSON.parse(strFromU8(files['schema.json']))).toEqual(manifest)
  for (const entry of index.entries) {
    expect(createHash('sha256').update(files[entry.file]).digest('hex')).toBe(entry.sha256)
    expect(files[entry.file].length).toBe(entry.bytes)
  }
  expect(Object.values(files).map(bytes => strFromU8(bytes)).join('')).not.toMatch(/private\/path|TRANSPORT_ONLY/)
  expect(index.consistency).toBe('live-paginated-reads')
  expect(api.rpc.mock.calls).toHaveLength(5)
  expect(api.rpc.mock.calls.every(([, args]) => args.p_tenant_id === 'tenant')).toBe(true)
  expect(progress).toHaveBeenLastCalledWith('Preparando ZIP…')
})

it.each([
  { status: 404, statusCode: '404' },
  { status: 400, statusCode: '404' },
  { status: 400, statusCode: 404 },
  { status: 400, statusCode: 'NoSuchKey' },
])('exports references and documents missing originals without adding nonexistent bytes: %j', async (error) => {
  api.download.mockResolvedValue({ data: null, error })
  const files = unzipSync(new Uint8Array(await (await buildTenantExport('tenant', vi.fn())).arrayBuffer()))
  const file = `assets/product_images/${image}.webp`
  const row = JSON.parse(strFromU8(files['data/product_images/1.ndjson']))
  expect(row.attachment).toBe(file)
  expect(row.id).toBe(image)
  expect(strFromU8(files['data/product_images/1.ndjson'])).toContain('1234567890123456789.123456789')
  expect(files[file]).toBeUndefined()
  const index = JSON.parse(strFromU8(files['manifest.json']))
  expect(index.missingFiles).toEqual([{ collection: 'product_images', id: image, file, reason: 'not_found' }])
  expect(index.entries.some((entry: { file: string }) => entry.file === file)).toBe(false)
  expect(Object.values(files).map(bytes => strFromU8(bytes)).join('')).not.toMatch(/private\/path|TRANSPORT_ONLY/)
  expect(api.rpc.mock.calls).toHaveLength(5)
})

it('handles the real SDK parsing of the preproduction HTTP 400 response containing statusCode 404', async () => {
  const storage = createClient('https://storage.invalid', 'public-test-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async () => new Response(JSON.stringify({ statusCode: '404', error: 'Not found', message: 'The resource was not found' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    }) },
  }).storage
  api.download.mockImplementation((path: string) => storage.from('product-images').download(path))
  const files = unzipSync(new Uint8Array(await (await buildTenantExport('tenant', vi.fn())).arrayBuffer()))
  expect(JSON.parse(strFromU8(files['manifest.json'])).missingFiles).toHaveLength(1)
})

it('keeps downloading available files after a missing original', async () => {
  const secondImage = '00000000-0000-4000-8000-000000000002'
  const request = api.rpc.getMockImplementation()
  if (!request) throw new Error('Missing RPC mock')
  api.rpc.mockImplementation(async (name, args) => {
    const response = await request(name, args)
    if (response.data.files) {
      response.data.rows.push(JSON.stringify({ id: secondImage }))
      response.data.files.push({ ...response.data.files[0], id: secondImage, path: 'available/path' })
    }
    return response
  })
  api.download.mockResolvedValueOnce({ data: null, error: { status: 400, statusCode: '404' } })
  const files = unzipSync(new Uint8Array(await (await buildTenantExport('tenant', vi.fn())).arrayBuffer()))
  expect(files[`assets/product_images/${image}.webp`]).toBeUndefined()
  expect(strFromU8(files[`assets/product_images/${secondImage}.webp`])).toBe('image-bytes')
  expect(strFromU8(files['data/product_images/1.ndjson']).trim().split('\n')).toHaveLength(2)
  expect(JSON.parse(strFromU8(files['manifest.json'])).missingFiles).toHaveLength(1)
})

it.each([
  { status: 401, statusCode: '401' },
  { status: 403, statusCode: '403' },
  { status: 400, statusCode: 'InvalidRequest' },
  { status: 500, statusCode: '500' },
  { message: 'Failed to fetch' },
  null,
])('keeps permission, request, server and network failures explicit: %j', async (error) => {
  api.download.mockResolvedValue({ data: null, error })
  await expect(buildTenantExport('tenant', vi.fn())).rejects.toThrow(/No se ha podido descargar un fichero/)
})

it('preserves references even when storage location metadata is missing', async () => {
  const request = api.rpc.getMockImplementation()
  if (!request) throw new Error('Missing RPC mock')
  api.rpc.mockImplementation(async (name, args) => {
    const response = await request(name, args)
    if (response.data.files) response.data.files = response.data.files.map((file: { id: string }) => ({ ...file, path: null }))
    return response
  })
  const files = unzipSync(new Uint8Array(await (await buildTenantExport('tenant', vi.fn())).arrayBuffer()))
  expect(JSON.parse(strFromU8(files['data/product_images/1.ndjson'])).attachment).toBe(`assets/product_images/${image}.webp`)
  expect(JSON.parse(strFromU8(files['manifest.json'])).missingFiles[0].reason).toBe('missing_reference')
  expect(api.download).not.toHaveBeenCalled()
})

it('detects file corruption against the recorded fingerprint', async () => {
  api.download.mockResolvedValue({ data: new Blob(['wrong-bytes']), error: null })
  await expect(buildTenantExport('tenant',vi.fn())).rejects.toThrow(/integridad/)
})

it('stops on permission or network failures without turning them into empty data', async () => {
  api.rpc.mockResolvedValue({ data: null, error: { code: '42501' } })
  await expect(buildTenantExport('tenant',vi.fn())).rejects.toThrow(/sesión de propietario/)
  expect(api.download).not.toHaveBeenCalled()
})

it('rejects broken cursors and archive traversal names', async () => {
  brokenCursor = true
  await expect(buildTenantExport('tenant',vi.fn())).rejects.toThrow(/avanzar/)
  api.rpc.mockResolvedValue({ data: { ...manifest, collections: [{ ...manifest.collections[0], name: '../../secret' }] }, error: null })
  await expect(buildTenantExport('tenant',vi.fn())).rejects.toThrow()
})

it('does not expose customer content through JSON parser diagnostics', async () => {
  api.rpc.mockImplementation(async (_name, args) => ({ data: !args.p_collection ? manifest : {
    rows: ['{"customer":"PRIVATE_CUSTOMER_DATA" broken'], next: [image], readAt,
  }, error: null }))
  await expect(buildTenantExport('tenant',vi.fn())).rejects.toThrow('Un registro de la exportación no es válido.')
})

it('records unavailable schema elements in the archive and exports the current schema', async () => {
  const changes = [{ collection: 'retired_table', reason: 'table_unavailable' }, { collection: 'tickets', reason: 'columns_unavailable', columns: ['retired_field'] }]
  const request = api.rpc.getMockImplementation()
  if (!request) throw new Error('Missing RPC mock')
  api.rpc.mockImplementation(async (name, args) => args.p_collection ? request(name, args) : { data: { ...manifest, schemaChanges: changes }, error: null })
  const files = unzipSync(new Uint8Array(await (await buildTenantExport('tenant', vi.fn())).arrayBuffer()))
  expect(JSON.parse(strFromU8(files['manifest.json'])).schemaChanges).toEqual(changes)
  expect(JSON.parse(strFromU8(files['schema.json'])).schemaChanges).toEqual(changes)
})

it.each(['different', undefined])('rejects pages whose schema no longer matches the manifest: %s', async (token) => {
  const request = api.rpc.getMockImplementation()
  if (!request) throw new Error('Missing RPC mock')
  api.rpc.mockImplementation(async (name, args) => {
    const response = await request(name, args)
    return { data: args.p_collection ? { ...response.data, schemaToken: token } : {
      ...manifest, collections: manifest.collections.map(collection => ({ ...collection, schemaToken: 'initial' })),
    }, error: null }
  })
  await expect(buildTenantExport('tenant', vi.fn())).rejects.toThrow(/ha cambiado.*Vuelve a iniciarla/)
})

it.each([
  ['EXPORT_SCHEMA_CHANGED', /ha cambiado.*Vuelve a iniciarla/],
  ['EXPORT_INVALID_CURSOR', /ha cambiado.*Vuelve a iniciarla/],
  ['EXPORT_SCHEMA_UNAVAILABLE', /no permite una exportación segura/],
])('reports actionable schema errors without blaming the owner session: %s', async (message, expected) => {
  api.rpc.mockResolvedValue({ data: null, error: { code: '55000', message } })
  await expect(buildTenantExport('tenant', vi.fn())).rejects.toThrow(expected)
})
