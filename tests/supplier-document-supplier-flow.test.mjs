import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import {
  groundSupplierExtractionInOcr, parseSupplierDocumentExtraction, resolveSupplierCandidate,
  runDeterministicLineParser, supplierExtractionMetadata, supplierSelection,
} from '../supabase/functions/_shared/supplier-documents/core.ts'
import { getSupplierDocumentMockFixture } from '../supabase/functions/_shared/supplier-documents/fixtures.ts'
import { OpenAiSupplierDocumentProvider } from '../supabase/functions/_shared/supplier-documents/providers.ts'
import { PROVISIONAL_SUPPLIER, requiresLineReparseConfirmation, supplierReviewState } from '../src/features/crm/supplier-documents/supplierReview.ts'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migration = await read('supabase/migrations/20260903090000_supplier_document_provisional_flow.sql')
const edge = await read('supabase/functions/process-supplier-document/index.ts')
const page = await read('src/features/crm/supplier-documents/pages/SupplierReceiptsPage.tsx')

function detection(overrides = {}, evidenceOverrides = {}) {
  const fixture = getSupplierDocumentMockFixture('known-supplier')
  const ocr = structuredClone(fixture.ocr)
  ocr.text = 'DISPOCH S.L.\nCIF: B12345678\nTeléfono: 900 246 500\nventas@dispoch.test\nCalle Mayor 12, Madrid'
  ocr.pages[0].text = ocr.text
  ocr.pages[0].words = []
  const raw = {
    ...structuredClone(fixture.extraction), proposedProfile: null,
    supplier: { name: 'DISPOCH S.L.', legalName: null, taxId: 'B12345678', phone: '900 246 500', email: 'ventas@dispoch.test', address: 'Calle Mayor 12, Madrid', ...overrides },
    supplierEvidence: { name: 'DISPOCH S.L.', legalName: null, taxId: 'CIF: B12345678', phone: 'Teléfono: 900 246 500', email: 'ventas@dispoch.test', address: 'Calle Mayor 12, Madrid', ...evidenceOverrides },
  }
  const extraction = parseSupplierDocumentExtraction(groundSupplierExtractionInOcr(raw, ocr))
  return { ocr, raw, extraction, metadata: { supplierExtraction: supplierExtractionMetadata(extraction), supplierSelection: supplierSelection(extraction, resolveSupplierCandidate(extraction.supplier, [])), hasStoredOcr: true } }
}

test('descarta valor y evidencia inventados, aunque el modelo reconozca una marca', () => {
  const { extraction } = detection({ name: 'Coca-Cola Corporation', address: 'San Francisco' }, { name: 'Coca-Cola Corporation', address: 'San Francisco' })
  assert.equal(extraction.supplier.name, null)
  assert.equal(extraction.supplierEvidence.name, null)
  assert.equal(extraction.supplier.address, null)
  assert.equal(supplierSelection(extraction, resolveSupplierCandidate(extraction.supplier, [])).kind, 'unresolved')
})

test('un teléfono inventado no se valida contra una evidencia real distinta', () => {
  const { extraction } = detection({ phone: '(415) 661-1001' })
  assert.equal(extraction.supplier.phone, null)
  assert.equal(extraction.supplierEvidence.phone, null)
})

test('conserva CIF y teléfono normalizados y evidencia literal del OCR', () => {
  const { extraction, metadata } = detection({ taxId: 'B-123.456-78', phone: '900246500' })
  assert.equal(extraction.supplier.taxId, 'B-123.456-78')
  assert.equal(extraction.supplier.phone, '900246500')
  assert.deepEqual(metadata.supplierExtraction.taxId, { value: 'B-123.456-78', evidence: 'CIF: B12345678' })
  assert.ok(metadata.supplierExtraction.identities.every((identity) => identity.evidence))
})

test('no sustituye una cita inventada por otra que sí permitiría el valor', () => {
  const { extraction } = detection({}, { name: 'Proveedor: DISPOCH S.L. (sede)' })
  assert.equal(extraction.supplier.name, null)
})

test('CIF exacto selecciona un proveedor existente y una identidad contradictoria no lo fuerza', () => {
  const { extraction } = detection()
  const match = resolveSupplierCandidate(extraction.supplier, [{ supplierId: 'existing', name: 'Poch', taxId: 'B-123.456-78' }])
  assert.equal(match.confidence, 'high')
  assert.deepEqual(supplierSelection(extraction, match), { kind: 'existing', supplierId: 'existing' })
  assert.equal(resolveSupplierCandidate(extraction.supplier, [{ supplierId: 'wrong', name: 'DISPOCH SL', taxId: 'B87654321' }]).supplierId, null)
})

test('DISPOCH claro sin match es provisional y la revisión permite confirmarlo', () => {
  const { metadata } = detection()
  const state = supplierReviewState({ supplierId: null, extractionMetadata: metadata })
  assert.equal(state.detectedName, 'DISPOCH S.L.')
  assert.equal(state.isProvisional, true)
  assert.equal(state.hasSupplier, true)
  assert.equal(state.selectedValue, PROVISIONAL_SUPPLIER)
})

test('email y teléfono exactos resuelven; los aliases no confirmados y señales contradictorias no', () => {
  const { extraction } = detection()
  for (const field of ['email', 'phone']) {
    assert.equal(resolveSupplierCandidate(extraction.supplier, [{
      supplierId: field, name: 'Proveedor registrado', [field]: extraction.supplier[field],
    }]).supplierId, field)
  }
  assert.equal(resolveSupplierCandidate(extraction.supplier, [{
    supplierId: 'unverified', name: 'Otro proveedor',
    identities: [{ type: 'tax_id', value: 'B12345678', source: 'extracted' }],
  }]).supplierId, null)
  assert.equal(resolveSupplierCandidate(extraction.supplier, [
    { supplierId: 'email', name: 'Uno', email: extraction.supplier.email },
    { supplierId: 'phone', name: 'Dos', phone: extraction.supplier.phone },
  ]).supplierId, null)
})

test('el modelo de extracción no recibe candidatos y su evidencia se verifica', async (t) => {
  const { ocr, raw } = detection({ phone: '(415) 661-1001' })
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init.body)
    assert.doesNotMatch(JSON.stringify(request.input), /SECRET_CANDIDATE/)
    assert.ok(request.text.format.schema.required.includes('supplierEvidence'))
    return new Response(JSON.stringify({ output_text: JSON.stringify(raw) }), { status: 200 })
  })
  const result = await new OpenAiSupplierDocumentProvider({ apiKey: 'test', model: 'test' }).interpret({
    ocr, documentType: 'invoice', supplierCandidates: [{ supplierId: 'id', name: 'SECRET_CANDIDATE' }],
  })
  assert.equal(result.supplier.phone, null)
})

test('la extracción de identidad del parser conocido no extrae cabecera ni productos', async (t) => {
  const { ocr, raw } = detection({ phone: '(415) 661-1001' })
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init.body)
    assert.deepEqual(request.text.format.schema.required, ['supplier', 'supplierEvidence'])
    assert.doesNotMatch(JSON.stringify(request.input), /supplierCandidates|globalSupplier/)
    return new Response(JSON.stringify({ output_text: JSON.stringify({ supplier: raw.supplier, supplierEvidence: raw.supplierEvidence }) }))
  })
  const result = await new OpenAiSupplierDocumentProvider({ apiKey: 'test', model: 'test' }).extractSupplier(ocr)
  assert.equal(result.supplier.taxId, 'B12345678')
  assert.equal(result.supplier.phone, null)
  assert.deepEqual(Object.keys(result).sort(), ['supplier', 'supplierEvidence'])
})

test('cambiar proveedor no dispara OCR ni reemplaza las líneas desde la UI', () => {
  const change = page.match(/async function changeSupplier[\s\S]*?\n  }/)?.[0] ?? ''
  assert.match(change, /updateSupplierDocumentSupplier/)
  assert.doesNotMatch(change, /reparseSupplierDocumentLines|retrySupplierDocumentProcessing|setDetail\(\{.*lines/)
  assert.match(change, /\.\.\.current,[\s\S]*document:/)
})

test('reparsear usa OCR almacenado y únicamente el parser de líneas', () => {
  const fixture = getSupplierDocumentMockFixture('multi-row-product')
  const lines = runDeterministicLineParser(fixture.knownProfile, fixture.ocr)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].lineTotal, 99.94)
  const reparse = edge.match(/async function reparseLinesWithSelectedSupplier[\s\S]*?\n}/)?.[0] ?? ''
  assert.match(reparse, /ocrDocumentSchema\.parse\(document\.ocr_snapshot\)/)
  assert.match(reparse, /runDeterministicLineParser/)
  assert.doesNotMatch(reparse, /\.analyze\(|\.interpret\(|extractSupplier\(|loadBinary\(/)
  assert.match(reparse, /replace_supplier_document_lines_from_ocr/)
})

test('solo pide confirmación de reparseo si hay correcciones guardadas o un editor abierto', () => {
  assert.equal(requiresLineReparseConfirmation([{ wasCorrected: false }]), false)
  assert.equal(requiresLineReparseConfirmation([{ wasCorrected: true }]), true)
  assert.equal(requiresLineReparseConfirmation([{ wasCorrected: false, referenceCostDecided: true }]), true)
  assert.equal(requiresLineReparseConfirmation([{ wasCorrected: false }], true), true)
  assert.match(page, /requiresLineReparseConfirmation[\s\S]*setReparseConfirmation\(true\)[\s\S]*return/)
})

// An isolated PostgreSQL engine. The legacy confirmation body is a test double:
// these tests exercise the NEW supplier transaction boundary, not stock/cost code.
const bootstrap = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;
create function public.user_is_tenant_admin(uuid) returns boolean language sql as $$ select $1 = '00000000-0000-0000-0000-000000000010'::uuid $$;
create function public.user_has_venue_access(uuid, uuid) returns boolean language sql as $$ select false $$;
create table public.suppliers (id uuid primary key default gen_random_uuid(), tenant_id uuid, venue_id uuid, global_supplier_id uuid, name text not null, tax_id text, updated_at timestamptz default now());
create table public.supplier_documents (id uuid primary key default gen_random_uuid(), tenant_id uuid, venue_id uuid, supplier_id uuid, global_supplier_id uuid, global_profile_id uuid, document_type text default 'invoice', document_number text, document_date date, status text default 'review', extraction_metadata jsonb default '{}', confirmed_at timestamptz, affects_stock boolean, updated_at timestamptz default now());
create table public.global_supplier_document_profiles (id uuid primary key, global_supplier_id uuid, document_type text);
create table public.supplier_identity_aliases (tenant_id uuid, venue_id uuid, supplier_id uuid, identity_type text, normalized_value text, source text, confirmed_by uuid, updated_at timestamptz default now(), unique(tenant_id, venue_id, identity_type, normalized_value));
create table public.supplier_document_lines (
  id uuid primary key default gen_random_uuid(), supplier_document_id uuid, tenant_id uuid, venue_id uuid, line_number integer,
  supplier_reference text, description_raw text check (description_raw <> ''), description_normalized text, barcode text,
  quantity numeric, purchase_unit text, package_count numeric, package_unit_quantity numeric, package_unit_symbol text,
  unit_price numeric, discount_amount numeric, charges_amount numeric, gross_cost numeric, net_cost numeric, line_total numeric,
  tax_rate numeric, inventory_item_id uuid, warehouse_id uuid, base_quantity numeric, normalized_unit_cost numeric,
  match_status text, extraction_confidence numeric, raw_extraction_metadata jsonb,
  was_corrected boolean default false, reference_cost_decided boolean default false,
  update_reference_cost boolean default false, updated_at timestamptz default now()
);
create function public.confirm_supplier_document(uuid, date, boolean, uuid[] default '{}') returns jsonb language plpgsql as $$
begin
  if exists(select 1 from public.supplier_documents where id = $1 and document_number = 'FAIL') then raise exception 'LEGACY_CONFIRMATION_FAILED'; end if;
  if exists(select 1 from public.supplier_documents where id = $1 and supplier_id is null) then raise exception 'SUPPLIER_REQUIRED'; end if;
  update public.supplier_documents set status = 'confirmed', document_date = $2, affects_stock = $3, confirmed_at = now() where id = $1;
  return jsonb_build_object('documentId', $1);
end; $$;
`
const tenant = '00000000-0000-0000-0000-000000000010'
const venue = '00000000-0000-0000-0000-000000000020'

test('transacciones de proveedor y reemplazo de líneas en PostgreSQL aislado', async (t) => {
  const db = new PGlite()
  await db.exec(bootstrap)
  await db.exec(migration)
  t.after(() => db.close())
  const query = async (sql, args = []) => (await db.query(sql, args)).rows
  const reset = () => db.exec('truncate supplier_documents, supplier_document_lines, supplier_identity_aliases, suppliers')
  const addDocument = async (number = 'DOC') => {
    const { metadata, ocr } = detection()
    return (await query('insert into supplier_documents(tenant_id, venue_id, document_number, extraction_metadata, ocr_snapshot, document_date) values($1,$2,$3,$4,$5,$6) returning id', [tenant, venue, number, JSON.stringify(metadata), JSON.stringify(ocr), '2026-09-01']))[0].id
  }
  const confirm = (id) => query("select confirm_supplier_document($1, '2026-09-03', false, '{}')", [id])
  const addExisting = async (taxId = 'B12345678') => (await query('insert into suppliers(tenant_id, venue_id, name, tax_id) values($1,$2,$3,$4) returning id', [tenant, venue, 'Distribuciones Poch', taxId]))[0].id

  await t.test('confirmar provisional crea, asocia y aprende identidades para la siguiente factura', async () => {
    await reset()
    const id = await addDocument()
    assert.equal((await query('select * from suppliers')).length, 0)
    await confirm(id)
    const [supplier] = await query('select * from suppliers')
    assert.equal(supplier.name, 'DISPOCH S.L.')
    assert.equal(supplier.tax_id, 'B12345678')
    assert.equal(supplier.phone, '900 246 500')
    const [document] = await query('select * from supplier_documents where id=$1', [id])
    assert.equal(document.supplier_id, supplier.id)
    const identities = await query('select * from supplier_identity_aliases')
    assert.ok(identities.some((identity) => identity.identity_type === 'tax_id' && identity.source === 'user_confirmed'))
    const future = resolveSupplierCandidate(detection().extraction.supplier, [{
      supplierId: supplier.id, name: supplier.name, taxId: supplier.tax_id,
      identities: identities.map((identity) => ({ type: identity.identity_type, value: identity.normalized_value, source: identity.source })),
    }])
    assert.equal(future.supplierId, supplier.id)
    assert.equal(future.confidence, 'high')
    await confirm(id)
    assert.equal((await query('select * from suppliers')).length, 1)
  })

  await t.test('selección manual conserva las líneas y no crea el provisional', async () => {
    await reset()
    const id = await addDocument()
    const supplierId = await addExisting('B99999999')
    await query("insert into supplier_document_lines(supplier_document_id, description_raw, was_corrected) values($1,'Mi corrección',true)", [id])
    const before = await query('select * from supplier_document_lines')
    await query('select update_supplier_document_supplier($1,$2)', [id, supplierId])
    assert.deepEqual(await query('select * from supplier_document_lines'), before)
    assert.equal((await query('select * from supplier_identity_aliases')).length, 0)
    await confirm(id)
    assert.equal((await query('select * from suppliers')).length, 1)
    assert.equal((await query('select supplier_id from supplier_documents where id=$1', [id]))[0].supplier_id, supplierId)
    assert.equal((await query('select * from supplier_identity_aliases')).length, 0, 'no aprende el CIF contradictorio')
  })

  await t.test('reutiliza mismo CIF con puntuación creado después del OCR', async () => {
    await reset()
    const first = await addDocument('ONE')
    const second = await addDocument('TWO')
    const supplierId = await addExisting('B-123.456-78')
    await confirm(first)
    await confirm(second)
    assert.equal((await query('select * from suppliers')).length, 1)
    assert.ok((await query('select supplier_id from supplier_documents')).every((row) => row.supplier_id === supplierId))
  })

  await t.test('un fallo de confirmación revierte proveedor y asociación', async () => {
    await reset()
    const id = await addDocument('FAIL')
    await assert.rejects(confirm(id), /LEGACY_CONFIRMATION_FAILED/)
    assert.equal((await query('select * from suppliers')).length, 0)
    assert.equal((await query('select supplier_id from supplier_documents where id=$1', [id]))[0].supplier_id, null)
  })

  await t.test('no utiliza proveedores de otro local ni permite documentos de otro tenant', async () => {
    await reset()
    const id = await addDocument()
    const otherSupplier = await addExisting()
    await query("update suppliers set venue_id='00000000-0000-0000-0000-000000000099' where id=$1", [otherSupplier])
    await assert.rejects(query('select update_supplier_document_supplier($1,$2)', [id, otherSupplier]), /SUPPLIER_INVALID/)
    await confirm(id)
    const [document] = await query('select * from supplier_documents where id=$1', [id])
    assert.notEqual(document.supplier_id, otherSupplier)
    assert.equal((await query('select * from suppliers')).length, 2)
    const forbidden = await addDocument('FORBIDDEN')
    await query("update supplier_documents set tenant_id='00000000-0000-0000-0000-000000000099' where id=$1", [forbidden])
    await assert.rejects(confirm(forbidden), /FORBIDDEN/)
  })

  await t.test('una evidencia inexistente impide el alta y un CIF ambiguo no crea un tercero', async () => {
    await reset()
    const id = await addDocument()
    await query("update supplier_documents set ocr_snapshot='{}' where id=$1", [id])
    await assert.rejects(confirm(id), /PROVISIONAL_INVALID/)
    assert.equal((await query('select * from suppliers')).length, 0)
    const ambiguous = await addDocument('AMBIGUOUS')
    await addExisting()
    await addExisting('B-123.456-78')
    await assert.rejects(confirm(ambiguous), /SUPPLIER_AMBIGUOUS/)
    assert.equal((await query('select * from suppliers')).length, 2)
  })

  await t.test('el reparseo respeta correcciones, sustituye solo líneas y detecta cambios concurrentes', async () => {
    await reset()
    const id = await addDocument()
    const supplierId = await addExisting()
    await query('select update_supplier_document_supplier($1,$2)', [id, supplierId])
    await query("insert into supplier_document_lines(supplier_document_id, description_raw, was_corrected) values($1,'Corregido',true)", [id])
    const snapshot = await query('select id, updated_at, was_corrected from supplier_document_lines order by id')
    const before = (await query('select * from supplier_documents where id=$1', [id]))[0]
    const replacement = [{ line_number: 1, description_raw: 'Nueva línea', description_normalized: 'nueva linea', quantity: 2, match_status: 'needs_review' }]
    const reparse = (allow, expected = snapshot) => query('select replace_supplier_document_lines_from_ocr($1,$2,$3,$4,$5,null,$6)', [id, supplierId, JSON.stringify(expected), allow, JSON.stringify(replacement), '{}'])
    await assert.rejects(reparse(false), /REPARSE_CONFIRMATION_REQUIRED/)
    await query('update supplier_document_lines set was_corrected=false, reference_cost_decided=true')
    await assert.rejects(reparse(false), /REPARSE_CONFIRMATION_REQUIRED/)
    await query("update supplier_document_lines set updated_at=now()+interval '1 second'")
    await assert.rejects(reparse(true), /REPARSE_STALE/)
    assert.equal((await query('select description_raw from supplier_document_lines'))[0].description_raw, 'Corregido')
    await reparse(true, await query('select id, updated_at, was_corrected from supplier_document_lines order by id'))
    const after = (await query('select * from supplier_documents where id=$1', [id]))[0]
    assert.deepEqual(after.document_date, before.document_date)
    assert.deepEqual(after.extraction_metadata.supplierExtraction, before.extraction_metadata.supplierExtraction)
    assert.deepEqual(after.ocr_snapshot, before.ocr_snapshot)
    assert.equal(after.extraction_metadata.profileParsedLineCount, 1)
    assert.equal((await query('select description_raw from supplier_document_lines'))[0].description_raw, 'Nueva línea')
  })

  await t.test('los internos no pueden invocarse directamente por authenticated', async () => {
    const rows = await query("select has_function_privilege('authenticated', 'confirm_supplier_document_existing(uuid,date,boolean,uuid[])', 'execute') legacy, has_function_privilege('authenticated', 'replace_supplier_document_lines_from_ocr(uuid,uuid,jsonb,boolean,jsonb,uuid,jsonb)', 'execute') reparse")
    assert.equal(rows[0].legacy, false)
    assert.equal(rows[0].reparse, false)
  })
})
