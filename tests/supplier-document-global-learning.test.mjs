import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import ts from 'typescript'
import * as core from '../supabase/functions/_shared/supplier-documents/core.ts'
import * as providers from '../supabase/functions/_shared/supplier-documents/providers.ts'
import * as fixtures from '../supabase/functions/_shared/supplier-documents/fixtures.ts'
import * as quality from '../supabase/functions/_shared/supplier-documents/ocrQuality.ts'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const migration = await read('supabase/migrations/20260903110000_supplier_document_global_learning.sql')
const localMigration = await read('supabase/migrations/20260903090000_supplier_document_provisional_flow.sql')
const edgeSource = await read('supabase/functions/process-supplier-document/index.ts')
const compiledEdge = ts.transpileModule(edgeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText
const tenant = '00000000-0000-0000-0000-000000000010'
const venue = '00000000-0000-0000-0000-000000000020'
const otherTenant = '00000000-0000-0000-0000-000000000011'
const otherVenue = '00000000-0000-0000-0000-000000000021'

function detection(name = 'DISPOCH S.L.', taxId = 'B12345678') {
  const fixture = structuredClone(fixtures.getSupplierDocumentMockFixture('known-supplier'))
  fixture.ocr.provider = 'mistral'
  fixture.ocr.text = fixture.ocr.text.replaceAll(fixture.extraction.supplier.name, name)
    .replaceAll(fixture.extraction.supplier.taxId, taxId)
  fixture.ocr.pages[0].text = fixture.ocr.text
  fixture.ocr.pages[0].words = []
  fixture.extraction.supplier = { name, legalName: null, taxId, email: null, phone: null, address: null }
  fixture.extraction.proposedProfile.requiredTexts[0] = name
  const extraction = core.parseSupplierDocumentExtraction(core.groundSupplierExtractionInOcr(fixture.extraction, fixture.ocr))
  const validation = core.validateProposedProfile(fixture.ocr, extraction)
  assert.equal(validation.candidate, true)
  return {
    ocr: fixture.ocr, extraction, rules: extraction.proposedProfile,
    metadata: {
      parserMode: 'ai', profileValidation: { candidate: true, reason: null },
      profileParsedLineCount: validation.parsed.lines.length, lineParserProfile: extraction.proposedProfile,
      supplierExtraction: core.supplierExtractionMetadata(extraction),
      supplierSelection: { kind: 'provisional', supplierId: null },
    },
  }
}

// Ephemeral PostgreSQL only. Existing stock/cost confirmation is represented by
// a double; the actual provisional RPC and NEW global-learning SQL run unchanged.
const bootstrap = `
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;
create function public.user_is_tenant_admin(uuid) returns boolean language sql as $$ select $1 in ('${tenant}'::uuid, '${otherTenant}'::uuid) $$;
create function public.user_has_venue_access(uuid, uuid) returns boolean language sql as $$ select false $$;
create table public.global_suppliers (id uuid primary key default gen_random_uuid(), name text not null, tax_id text, created_at timestamptz default now(), updated_at timestamptz default now());
create unique index global_suppliers_tax_id_unique on public.global_suppliers(upper(btrim(tax_id))) where nullif(btrim(tax_id), '') is not null;
create table public.global_supplier_document_profiles (
  id uuid primary key default gen_random_uuid(), global_supplier_id uuid references global_suppliers(id), document_type text,
  fingerprint_json jsonb default '{}', rules_json jsonb not null, status text default 'candidate' check (status in ('candidate','verified','deprecated')),
  success_count integer default 0, correction_count integer default 0, created_at timestamptz default now(), updated_at timestamptz default now()
);
create table public.suppliers (id uuid primary key default gen_random_uuid(), tenant_id uuid, venue_id uuid, global_supplier_id uuid references global_suppliers(id), name text not null, tax_id text, updated_at timestamptz default now());
create table public.supplier_documents (id uuid primary key default gen_random_uuid(), tenant_id uuid, venue_id uuid, supplier_id uuid references suppliers(id), global_supplier_id uuid references global_suppliers(id), global_profile_id uuid references global_supplier_document_profiles(id), document_type text default 'delivery_note', document_number text, document_date date, status text default 'review', extraction_metadata jsonb default '{}', confirmed_at timestamptz, affects_stock boolean, updated_at timestamptz default now());
create table public.supplier_identity_aliases (tenant_id uuid, venue_id uuid, supplier_id uuid, identity_type text, normalized_value text, source text, confirmed_by uuid, updated_at timestamptz default now(), unique(tenant_id, venue_id, identity_type, normalized_value));
create table public.supplier_document_lines (
  id uuid primary key default gen_random_uuid(), supplier_document_id uuid, tenant_id uuid, venue_id uuid, line_number integer,
  supplier_reference text, description_raw text, description_normalized text, barcode text,
  quantity numeric, purchase_unit text, package_count numeric, package_unit_quantity numeric, package_unit_symbol text,
  unit_price numeric, discount_amount numeric, charges_amount numeric, gross_cost numeric, net_cost numeric, line_total numeric,
  tax_rate numeric, inventory_item_id uuid, warehouse_id uuid, base_quantity numeric, normalized_unit_cost numeric,
  match_status text, extraction_confidence numeric, raw_extraction_metadata jsonb,
  was_corrected boolean default false, reference_cost_decided boolean default false,
  update_reference_cost boolean default false, updated_at timestamptz default now()
);
create table public.confirmation_audit(document_id uuid);
create function public.confirm_supplier_document(uuid, date, boolean, uuid[] default '{}') returns jsonb language plpgsql as $$
begin
  if exists(select 1 from public.supplier_documents where id=$1 and status='confirmed') then return jsonb_build_object('duplicate',true); end if;
  if exists(select 1 from public.supplier_documents where id=$1 and document_number='FAIL') then raise exception 'LEGACY_CONFIRMATION_FAILED'; end if;
  if exists(select 1 from public.supplier_documents where id=$1 and supplier_id is null) then raise exception 'SUPPLIER_REQUIRED'; end if;
  if not exists(select 1 from public.supplier_document_lines where supplier_document_id=$1) then raise exception 'LINES_REQUIRED'; end if;
  update public.global_supplier_document_profiles set success_count=success_count+1
    where id=(select global_profile_id from public.supplier_documents where id=$1);
  insert into public.confirmation_audit values($1);
  update public.supplier_documents set status='confirmed', document_date=$2, affects_stock=$3, confirmed_at=now() where id=$1;
  return jsonb_build_object('documentId',$1,'duplicate',false);
end; $$;
`

function dbHelpers(db) {
  const query = async (sql, args = []) => (await db.query(sql, args)).rows
  const reset = () => db.exec('truncate supplier_documents, supplier_document_lines, supplier_identity_aliases, suppliers, global_suppliers, global_supplier_document_profiles, confirmation_audit')
  const addGlobal = async (taxId = 'B12345678', name = 'Global confirmado') => (await query('insert into global_suppliers(name,tax_id) values($1,$2) returning id', [name, taxId]))[0].id
  const addSupplier = async ({ taxId = 'B12345678', name = 'Proveedor local confirmado', globalId = null, tenantId = tenant, venueId = venue, legalName = null } = {}) =>
    (await query('insert into suppliers(tenant_id,venue_id,name,tax_id,global_supplier_id,legal_name) values($1,$2,$3,$4,$5,$6) returning id', [tenantId, venueId, name, taxId, globalId, legalName]))[0].id
  const addProfile = async (globalId, { rules = detection().rules, status = 'candidate', successCount = 0, type = 'delivery_note' } = {}) =>
    (await query('insert into global_supplier_document_profiles(global_supplier_id,document_type,rules_json,fingerprint_json,status,success_count) values($1,$2,$3,$4,$5,$6) returning id', [globalId, type, JSON.stringify(rules), JSON.stringify({ requiredTexts: rules.requiredTexts }), status, successCount]))[0].id
  const addDocument = async ({ supplierId = null, profileId = null, globalId = null, metadata = {}, tenantId = tenant, venueId = venue, number = 'DOC', type = 'delivery_note' } = {}) => {
    const data = detection()
    const id = (await query('insert into supplier_documents(tenant_id,venue_id,supplier_id,global_supplier_id,global_profile_id,document_number,document_type,extraction_metadata,ocr_snapshot) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id', [tenantId, venueId, supplierId, globalId, profileId, number, type, JSON.stringify({ ...data.metadata, ...metadata }), JSON.stringify(data.ocr)]))[0].id
    await query("insert into supplier_document_lines(supplier_document_id,tenant_id,venue_id,line_number,description_raw,quantity,line_total) values($1,$2,$3,1,'Producto confirmado',2,10)", [id, tenantId, venueId])
    return id
  }
  const document = async (id) => (await query('select * from supplier_documents where id=$1', [id]))[0]
  const confirm = (id) => query("select confirm_supplier_document($1,'2026-09-03',false,'{}') result", [id])
  return { query, reset, addGlobal, addSupplier, addProfile, addDocument, document, confirm }
}

test('aprendizaje global en la transacción de confirmación (PostgreSQL efímero)', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(bootstrap)
  await db.exec(localMigration)
  await db.exec(migration)
  const { query, reset, addGlobal, addSupplier, addProfile, addDocument, document, confirm } = dbHelpers(db)

  await t.test('reutiliza el enlace existente, incluso sin CIF, sin duplicar ni promocionar perfiles', async () => {
    await reset()
    const globalId = await addGlobal()
    const supplierId = await addSupplier({ taxId: null, globalId })
    const profileId = await addProfile(globalId, { status: 'verified', successCount: 5 })
    const id = await addDocument({ supplierId, globalId, profileId })
    await query('update supplier_document_lines set was_corrected=true where supplier_document_id=$1', [id])
    await confirm(id)
    const result = await document(id)
    assert.equal(result.global_supplier_id, globalId)
    assert.equal(result.extraction_metadata.globalSupplierResolution.mode, 'existing_link')
    assert.equal(result.global_profile_id, profileId)
    const [profile] = await query('select * from global_supplier_document_profiles')
    assert.equal(profile.status, 'verified')
    assert.equal(profile.success_count, 6)
    assert.equal(profile.correction_count, 1)
    assert.equal((await confirm(id))[0].result.duplicate, true)
    assert.equal((await query('select success_count from global_supplier_document_profiles'))[0].success_count, 6)
    assert.equal((await query('select * from confirmation_audit')).length, 1)
  })

  await t.test('enlaza CIF equivalente por puntuación y mayúsculas sin duplicar globals', async () => {
    await reset()
    const globalId = await addGlobal('b-123.456-78')
    const supplierId = await addSupplier()
    const id = await addDocument({ supplierId })
    await confirm(id)
    assert.equal((await document(id)).extraction_metadata.globalSupplierResolution.mode, 'existing_by_tax_id')
    assert.equal((await query('select global_supplier_id from suppliers where id=$1', [supplierId]))[0].global_supplier_id, globalId)
    assert.equal((await query('select * from global_suppliers')).length, 1)
    await assert.rejects(addGlobal('B12345678'), /GLOBAL_SUPPLIER_TAX_ID_DUPLICATE|duplicate key/)
  })

  await t.test('crea global con datos locales confirmados, no con el nombre/CIF detectado inicialmente', async () => {
    await reset()
    const supplierId = await addSupplier({ name: 'Proveedor elegido B', taxId: 'A-87654321', legalName: 'Razón social confirmada B' })
    const id = await addDocument({ supplierId })
    await confirm(id)
    const [global] = await query('select * from global_suppliers')
    assert.equal(global.name, 'Proveedor elegido B')
    assert.equal(global.tax_id, 'A87654321')
    assert.equal(global.legal_name, 'Razón social confirmada B')
    assert.equal((await document(id)).extraction_metadata.globalSupplierResolution.mode, 'created_by_tax_id')
  })

  await t.test('sin CIF o con un identificador inválido no crea ni enlaza por nombre parecido', async () => {
    await reset()
    await addGlobal('B87654321', 'DISPOCH S.L.')
    for (const taxId of [null, '', '-', 'ABC', 'SINIDENTIFICAR']) {
      const supplierId = await addSupplier({ taxId, name: 'DISPOCH S.L.' })
      const id = await addDocument({ supplierId })
      await confirm(id)
      const result = await document(id)
      assert.equal(result.global_supplier_id, null)
      assert.equal(result.global_profile_id, null)
      assert.equal(result.extraction_metadata.globalSupplierResolution.mode, 'unresolved')
    }
    assert.equal((await query('select * from global_suppliers')).length, 1)
  })

  await t.test('provisional confirmado crea local, global, enlace y perfil candidate válido', async () => {
    await reset()
    const id = await addDocument()
    assert.equal((await query('select * from global_suppliers')).length, 0)
    assert.equal((await query('select * from suppliers')).length, 0)
    await confirm(id)
    const result = await document(id)
    const [local] = await query('select * from suppliers')
    const [global] = await query('select * from global_suppliers')
    const [profile] = await query('select * from global_supplier_document_profiles')
    assert.equal(result.status, 'confirmed')
    assert.equal(local.name, 'DISPOCH S.L.')
    assert.equal(local.global_supplier_id, global.id)
    assert.equal(result.global_supplier_id, global.id)
    assert.equal(result.global_profile_id, profile.id)
    assert.equal(profile.global_supplier_id, global.id)
    assert.equal(profile.status, 'candidate')
    assert.equal(profile.success_count, 1)
    assert.deepEqual(profile.rules_json, detection().rules)
    assert.deepEqual(profile.fingerprint_json, { requiredTexts: detection().rules.requiredTexts })
    assert.equal(result.extraction_metadata.globalProfileResolution.mode, 'created')
  })

  await t.test('cambio manual manda: no crea el provisional ni un global para A; el perfil pertenece a B', async () => {
    await reset()
    const supplierId = await addSupplier({ name: 'Distribuidor B', taxId: 'B87654321' })
    const id = await addDocument()
    await query('select update_supplier_document_supplier($1,$2)', [id, supplierId])
    await confirm(id)
    const result = await document(id)
    const [global] = await query('select * from global_suppliers')
    assert.equal(global.tax_id, 'B87654321')
    assert.equal(global.name, 'Distribuidor B')
    assert.equal((await query('select * from suppliers')).length, 1)
    assert.equal((await query('select global_supplier_id from global_supplier_document_profiles'))[0].global_supplier_id, global.id)
    assert.equal(result.supplier_id, supplierId)
  })

  await t.test('limpia una asociación global inicial incorrecta y no incrementa el perfil de A', async () => {
    await reset()
    const globalA = await addGlobal('B87654321')
    const profileA = await addProfile(globalA, { successCount: 7 })
    const supplierB = await addSupplier()
    const id = await addDocument({ supplierId: supplierB, globalId: globalA, profileId: profileA })
    await confirm(id)
    const result = await document(id)
    assert.notEqual(result.global_supplier_id, globalA)
    assert.notEqual(result.global_profile_id, profileA)
    assert.equal((await query('select success_count from global_supplier_document_profiles where id=$1', [profileA]))[0].success_count, 7)
  })

  await t.test('selección manual tras deterministic conserva reglas válidas y las aprende para el proveedor final', async () => {
    await reset()
    const globalA = await addGlobal('B87654321')
    const profileA = await addProfile(globalA, { successCount: 7 })
    const supplierB = await addSupplier()
    const id = await addDocument({ globalId: globalA, profileId: profileA, metadata: {
      parserMode: 'deterministic', profileValidation: null, profileParsedLineCount: null,
    } })
    await query('select update_supplier_document_supplier($1,$2)', [id, supplierB])
    assert.equal((await document(id)).global_profile_id, null)
    await confirm(id)
    const result = await document(id)
    assert.notEqual(result.global_supplier_id, globalA)
    assert.ok(result.global_profile_id)
    assert.notEqual(result.global_profile_id, profileA)
    assert.equal((await query('select success_count from global_supplier_document_profiles where id=$1', [profileA]))[0].success_count, 7)
  })

  await t.test('perfiles rechazados, ausentes, malformados o sin líneas parseadas no se guardan', async () => {
    await reset()
    const supplierId = await addSupplier()
    for (const metadata of [
      { profileValidation: { candidate: false } },
      { parserMode: 'deterministic', profileValidation: { candidate: false } },
      { lineParserProfile: null },
      { lineParserProfile: { version: 1, requiredTexts: 'malformado' } },
      { profileParsedLineCount: 0 },
      { parserMode: 'deterministic', profileValidation: null, profileParsedLineCount: 0 },
      { profileParsedLineCount: null },
    ]) {
      const id = await addDocument({ supplierId, metadata })
      await confirm(id)
      assert.equal((await document(id)).extraction_metadata.globalProfileResolution.mode, 'none')
    }
    assert.equal((await query('select * from global_supplier_document_profiles')).length, 0)
  })

  await t.test('mismas reglas JSONB reutilizan perfil y acumulan confirmaciones sin duplicarlo', async () => {
    await reset()
    const globalId = await addGlobal()
    const supplierId = await addSupplier({ globalId })
    const rules = detection().rules
    const profileId = await addProfile(globalId, { rules: Object.fromEntries(Object.entries(rules).reverse()) })
    for (let index = 0; index < 3; index++) {
      const id = await addDocument({ supplierId })
      await confirm(id)
      assert.equal((await document(id)).global_profile_id, profileId)
      assert.equal((await document(id)).extraction_metadata.globalProfileResolution.mode, 'existing')
    }
    assert.equal((await query('select * from global_supplier_document_profiles')).length, 1)
    assert.equal((await query('select success_count from global_supplier_document_profiles'))[0].success_count, 3)
  })

  await t.test('no reactiva un perfil deprecated ni reutiliza otro tipo de documento', async () => {
    await reset()
    const globalId = await addGlobal()
    const supplierId = await addSupplier({ globalId })
    await addProfile(globalId, { status: 'deprecated' })
    const note = await addDocument({ supplierId })
    await confirm(note)
    assert.equal((await document(note)).global_profile_id, null)
    const invoice = await addDocument({ supplierId, type: 'invoice' })
    await confirm(invoice)
    assert.equal((await query('select * from global_supplier_document_profiles')).length, 2)
    assert.equal((await query("select status from global_supplier_document_profiles where document_type='delivery_note'"))[0].status, 'deprecated')
  })

  await t.test('locales de tenants distintos comparten solo el global por CIF y mantienen sus suppliers aislados', async () => {
    await reset()
    const first = await addSupplier()
    const second = await addSupplier({ taxId: 'B-12345678', tenantId: otherTenant, venueId: otherVenue })
    await confirm(await addDocument({ supplierId: first }))
    await confirm(await addDocument({ supplierId: second, tenantId: otherTenant, venueId: otherVenue }))
    const suppliers = await query('select * from suppliers')
    assert.equal(suppliers.length, 2)
    assert.equal(suppliers[0].global_supplier_id, suppliers[1].global_supplier_id)
    assert.equal((await query('select * from global_suppliers')).length, 1)
    assert.equal((await query('select * from global_supplier_document_profiles')).length, 1)
  })

  await t.test('un fallo al guardar el perfil revierte local, global, aliases y confirmación previa', async () => {
    await reset()
    const id = await addDocument()
    await db.exec("create function fail_test_global_profile() returns trigger language plpgsql as $$ begin raise exception 'TEST_PROFILE_FAILURE'; end $$; create trigger fail_test_profile before insert on global_supplier_document_profiles for each row execute function fail_test_global_profile()")
    await assert.rejects(confirm(id), /TEST_PROFILE_FAILURE/)
    assert.equal((await document(id)).status, 'review')
    assert.equal((await document(id)).supplier_id, null)
    for (const table of ['suppliers', 'global_suppliers', 'supplier_identity_aliases', 'confirmation_audit']) {
      assert.equal((await query(`select * from ${table}`)).length, 0, table)
    }
    await db.exec('drop trigger fail_test_profile on global_supplier_document_profiles; drop function fail_test_global_profile()')
  })

  await t.test('rechaza estados no confirmables, acceso ajeno y llamadas directas a los internos', async () => {
    await reset()
    const id = await addDocument()
    await query("update supplier_documents set status='processing' where id=$1", [id])
    await assert.rejects(confirm(id), /NOT_READY/)
    await query("update supplier_documents set status='review', tenant_id='00000000-0000-0000-0000-000000000099' where id=$1", [id])
    await assert.rejects(confirm(id), /FORBIDDEN/)
    const [permissions] = await query("select has_function_privilege('authenticated','learn_confirmed_supplier_document_global_knowledge(uuid,uuid)','execute') learning, has_function_privilege('authenticated','confirm_supplier_document_local(uuid,date,boolean,uuid[])','execute') local")
    assert.equal(permissions.learning, false)
    assert.equal(permissions.local, false)
    assert.equal((await query('select * from global_suppliers')).length, 0)
  })

  await t.test('primera confirmación habilita deterministic en la siguiente factura compatible, no en otra plantilla', async () => {
    await reset()
    await confirm(await addDocument())
    const globals = await query('select * from global_suppliers')
    const profiles = await query('select * from global_supplier_document_profiles')
    const suppliers = await query('select * from suppliers')
    const compatible = await processEdge(detection(), { globals, profiles, suppliers })
    assert.equal(compatible.document.status, 'review')
    assert.equal(compatible.document.extraction_metadata.parserMode, 'deterministic')
    assert.equal(compatible.document.global_supplier_id, globals[0].id)
    assert.equal(compatible.document.global_profile_id, profiles[0].id)
    assert.equal(compatible.calls.interpret, 0, 'no vuelve a interpretar líneas con IA')
    const incompatible = await processEdge(detection('OTRA PLANTILLA'), { globals, profiles, suppliers })
    assert.equal(incompatible.document.status, 'review')
    assert.equal(incompatible.document.extraction_metadata.parserMode, 'ai')
    assert.equal(incompatible.calls.interpret, 1)
    assert.equal(incompatible.document.global_profile_id, null)
    assert.equal(incompatible.document.extraction_metadata.profileValidation.candidate, true)
  })
})

test('catálogos antiguos con CIFs equivalentes se conservan sin romper registros ni elegir un global ambiguo', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(bootstrap)
  await db.exec(localMigration)
  const helpers = dbHelpers(db)
  await helpers.addGlobal('B-12345678')
  await helpers.addGlobal('B12345678')
  await db.exec(migration)
  const supplierId = await helpers.addSupplier()
  const id = await helpers.addDocument({ supplierId })
  await helpers.confirm(id)
  assert.equal((await helpers.query('select * from global_suppliers')).length, 2)
  assert.equal((await helpers.document(id)).global_supplier_id, null)
  assert.equal((await helpers.document(id)).extraction_metadata.globalSupplierResolution.reason, 'ambiguous_tax_id')
  await assert.rejects(helpers.addGlobal('B.12345678'), /GLOBAL_SUPPLIER_TAX_ID_DUPLICATE/)
})

async function processEdge(data, { globals = [], profiles = [], suppliers = [] } = {}) {
  const document = { id: 'new-document', tenant_id: tenant, venue_id: venue, supplier_id: null, document_type: 'delivery_note', status: 'processing', storage_bucket: 'documents', storage_path: 'image', original_mime_type: 'image/jpeg', extraction_metadata: {} }
  const calls = { interpret: 0, supplier: 0, globalWrites: 0 }
  const rows = { supplier_documents: [document], global_suppliers: globals, global_supplier_document_profiles: profiles, suppliers }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'user' } }, error: null }) },
    storage: { from: () => ({ download: async () => ({ data: new Blob(['image']), error: null }) }) },
    from(table) {
      const filters = []
      let single = false
      let write
      return {
        select() { return this }, order() { return this },
        eq(key, value) { filters.push((row) => row[key] === value); return this },
        neq(key, value) { filters.push((row) => row[key] !== value); return this },
        in(key, values) { filters.push((row) => values.includes(row[key])); return this },
        ilike(key, value) { filters.push((row) => row[key]?.toLowerCase() === value.toLowerCase()); return this },
        single() { single = true; return this }, maybeSingle() { single = true; return this },
        update(value) { write = value; return this }, delete() { return this },
        insert() { if (table.startsWith('global_')) calls.globalWrites++; return this },
        then(resolve, reject) {
          const selected = (rows[table] ?? []).filter((row) => filters.every((filter) => filter(row)))
          if (write) for (const row of selected) Object.assign(row, write)
          return Promise.resolve({ data: structuredClone(single ? selected[0] ?? null : selected), error: null }).then(resolve, reject)
        },
      }
    },
  }
  const modules = {
    'https://esm.sh/@supabase/supabase-js@2.110.0': { createClient: () => client },
    '../_shared/supplier-documents/core.ts': core,
    '../_shared/supplier-documents/fixtures.ts': fixtures,
    '../_shared/supplier-documents/ocrQuality.ts': quality,
    '../_shared/supplier-documents/providers.ts': {
      ...providers,
      createDocumentOcrProvider: () => ({ name: 'mistral', analyze: async () => data.ocr }),
      OpenAiSupplierDocumentProvider: class {
        async interpret() { calls.interpret++; return data.extraction }
        async extractSupplier() { calls.supplier++; return { supplier: data.extraction.supplier, supplierEvidence: data.extraction.supplierEvidence } }
        async proposeProfile() { return data.rules }
      },
    },
  }
  let handler
  const tasks = []
  const env = { SUPABASE_URL: 'url', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', SUPPLIER_DOCUMENT_OCR_PROVIDER: 'mistral' }
  new Function('require', 'exports', 'Deno', 'EdgeRuntime', 'console', compiledEdge)(
    (name) => modules[name], {}, { env: { get: (key) => env[key] }, serve: (callback) => { handler = callback } },
    { waitUntil: (task) => tasks.push(task) }, { error() {} },
  )
  const response = await handler(new Request('https://example.test/process', { method: 'POST', headers: { Authorization: 'Bearer test' }, body: JSON.stringify({ documentId: document.id }) }))
  assert.equal(response.status, 202)
  await Promise.all(tasks)
  assert.equal(calls.globalWrites, 0, 'processing/review nunca crea entidades globales')
  return { document, calls }
}

test('OCR conserva el candidato validado en metadata aunque falte global, sin crearlo tampoco si ya existe', async () => {
  for (const globalId of [null, 'global-existing']) {
    const supplier = { id: 'local', tenant_id: tenant, venue_id: venue, name: 'DISPOCH S.L.', tax_id: 'B12345678', global_supplier_id: globalId }
    const result = await processEdge(detection(), { suppliers: [supplier], globals: globalId ? [{ id: globalId, name: supplier.name, tax_id: supplier.tax_id }] : [] })
    assert.equal(result.document.status, 'review')
    assert.equal(result.document.global_profile_id, null)
    assert.equal(result.document.extraction_metadata.profileValidation.candidate, true)
    assert.ok(result.document.extraction_metadata.profileParsedLineCount > 0)
    assert.deepEqual(result.document.extraction_metadata.lineParserProfile, detection().rules)
  }
})
