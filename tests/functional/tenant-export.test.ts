import { createHash } from 'node:crypto'
import { strFromU8, unzipSync } from 'fflate'
import { beforeEach, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ rpc: vi.fn(), download: vi.fn() }))
vi.mock('../../src/services/backendService', () => ({ requireSupabase: () => ({ rpc: api.rpc, storage: { from: () => ({ download: api.download }) } }) }))
const { buildTenantExport } = await import('../../src/features/crm/documentation/tenantExportService')
const image = '00000000-0000-4000-8000-000000000001'
const readAt = '2026-11-13T10:00:00Z'
const manifest = {
  format: 'tickit-tenant-export', schemaVersion: 1, readAt,
  collections: ['tickets','product_images'].map(name => ({ name, columns: [{ name: 'id', type: 'uuid', encoding: 'json' }] })),
}
let missing = false
let brokenCursor = false
beforeEach(() => {
  missing = false
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
  api.download.mockImplementation(async () => missing ? { data: null, error: { code: '404' } } : { data: new Blob(['image-bytes']), error: null })
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

it('fails the export on missing originals instead of producing an incomplete ZIP', async () => {
  missing = true
  await expect(buildTenantExport('tenant',vi.fn())).rejects.toThrow(/No se ha generado una exportación incompleta/)
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
