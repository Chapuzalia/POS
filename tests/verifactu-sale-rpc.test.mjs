import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { createAltaRecord } from '../src/features/fiscal/local/canonical.ts'

const prepare = await readFile(new URL('../supabase/migrations/20260928120000_prepare_local_verifactu_scope.sql', import.meta.url), 'utf8')
const saleMigration = await readFile(new URL('../supabase/migrations/20260928130000_sync_local_verifactu_sale.sql', import.meta.url), 'utf8')
const restaurantMigration = await readFile(new URL('../supabase/migrations/20260928140000_restaurant_local_verifactu_sale.sql', import.meta.url), 'utf8')
const guardMigration = await readFile(new URL('../supabase/migrations/20260928150000_guard_issued_local_fiscal_sales.sql', import.meta.url), 'utf8')
const seriesMigration = await readFile(new URL('../supabase/migrations/20260929190000_simplify_sif_series_identity.sql', import.meta.url), 'utf8')
const pwaMigration = await readFile(new URL('../supabase/migrations/20261002191101_pwa_fiscal_installation_identity.sql', import.meta.url), 'utf8')
const ids = {
  tenant: '11111111-1111-4111-8111-111111111111', venue: '22222222-2222-4222-8222-222222222222',
  device: '33333333-3333-4333-8333-333333333333', register: '44444444-4444-4444-8444-444444444444',
  subject: '55555555-5555-4555-8555-555555555555', installation: '66666666-6666-4666-8666-666666666666',
  user: '77777777-7777-4777-8777-777777777777', ticket: '88888888-8888-4888-8888-888888888888',
  sale: '99999999-9999-4999-8999-999999999999', invoice: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  event: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', record: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
}

test('sale and fiscal record commit together, with idempotency, chain and legacy gate', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$ select '${ids.user}'::uuid $$;
    create table public.tenants (id uuid primary key);
    create table public.venues (id uuid primary key, tenant_id uuid not null, timezone text);
    create table public.devices (id uuid primary key, tenant_id uuid not null, venue_id uuid not null);
    create table public.cash_registers (id uuid primary key, tenant_id uuid not null, venue_id uuid not null);
    create table public.tickets (id uuid primary key, tenant_id uuid, venue_id uuid, cash_register_id uuid, device_id uuid,
      status text, is_invoice boolean default false,
      customer_id uuid, customer_snapshot jsonb, invoice_series text, invoice_number text, invoice_issued_at timestamptz);
    create table public.sales (id uuid primary key, ticket_id uuid, tenant_id uuid, venue_id uuid,
      cash_register_id uuid, device_id uuid, total_cents integer, payment_method text);
    create table public.sale_payments (id uuid primary key, tenant_id uuid, sale_id uuid, method text, amount_cents integer);
    create table public.offline_event_log (tenant_id uuid, client_event_id uuid, unique(tenant_id, client_event_id));
    create table public.fiscal_integration_settings (tenant_id uuid, enabled boolean);
    create table public.customers (id uuid primary key, tenant_id uuid);
    create function public.user_is_tenant_admin(uuid) returns boolean language sql as $$ select true $$;
    create function public.user_has_venue_access(uuid, uuid) returns boolean language sql as $$ select true $$;
    create function public.user_has_device_access(uuid, uuid, uuid) returns boolean language sql as $$ select true $$;
    create function public.sync_sale_created_v2(p_event_id uuid, p_payload jsonb) returns void
      language plpgsql as $$ begin
        insert into public.offline_event_log values ((p_payload->'ticket'->>'tenantId')::uuid, p_event_id);
        insert into public.tickets(id,tenant_id,status) values
          ((p_payload->'ticket'->>'id')::uuid, (p_payload->'ticket'->>'tenantId')::uuid, 'paid');
        insert into public.sales(id,ticket_id,tenant_id,venue_id,cash_register_id,device_id) values
          ((p_payload->'sale'->>'id')::uuid, (p_payload->'ticket'->>'id')::uuid, (p_payload->'ticket'->>'tenantId')::uuid,
           (p_payload->'ticket'->>'venueId')::uuid, (p_payload->'ticket'->>'cashRegisterId')::uuid,
           (p_payload->'ticket'->>'deviceId')::uuid);
      end $$;
    insert into public.tenants values ('${ids.tenant}');
    insert into public.venues values ('${ids.venue}', '${ids.tenant}', 'Europe/Madrid');
    insert into public.devices values ('${ids.device}', '${ids.tenant}', '${ids.venue}');
    insert into public.cash_registers values ('${ids.register}', '${ids.tenant}', '${ids.venue}');
    insert into public.fiscal_integration_settings values ('${ids.tenant}', false);
  `)
  await db.exec(prepare)
  await db.exec(saleMigration)
  await db.exec(restaurantMigration)
  await db.exec(guardMigration)
  await db.exec(seriesMigration)
  await db.exec(`
    insert into public.fiscal_subjects(id,tenant_id,legal_name,nif) values
      ('${ids.subject}','${ids.tenant}','Emisor ficticio','89890001K');
    insert into public.fiscal_sif_installations
      (id,tenant_id,fiscal_subject_id,venue_id,cash_register_id,device_id,installation_number,
       venue_code,register_code,installation_code,mode)
    values ('${ids.installation}','${ids.tenant}','${ids.subject}','${ids.venue}','${ids.register}',
      '${ids.device}','INSTALL-1','L1','C1','I1','production');
  `)
  const generatedAt = '2026-09-28T12:00:00+02:00'
  const built = await createAltaRecord({
    invoice: { issuerNif: '89890001K', seriesAndNumber: 'L1-C1-2026-S/1', issueDate: '28-09-2026' },
    issuerName: 'Emisor ficticio', type: 'F2', description: 'Venta ficticia',
    details: [{ Impuesto: '01', ClaveRegimen: '01', CalificacionOperacion: 'S1', TipoImpositivo: '21.00', BaseImponibleOimporteNoSujeto: '10.00', CuotaRepercutida: '2.10' }],
    system: { NombreRazon: 'Productor ficticio', NIF: '89890001K', NombreSistemaInformatico: 'Tickit', IdSistemaInformatico: 'TK',
      Version: '1.0', NumeroInstalacion: 'INSTALL-1', TipoUsoPosibleSoloVerifactu: 'S', TipoUsoPosibleMultiOT: 'S', IndicadorMultiplesOT: 'S' },
    previous: null, generatedAt, environment: 'production',
  })
  const payload = { ticket: { id: ids.ticket, tenantId: ids.tenant, venueId: ids.venue, cashRegisterId: ids.register,
    deviceId: ids.device, totalCents: 1210 }, sale: { id: ids.sale } }
  const record = { idempotencyKey: ids.record, environment: 'production', tenantId: ids.tenant,
    fiscalSubjectId: ids.subject, issuerNif: '89890001K', venueId: ids.venue, cashRegisterId: ids.register,
    installationId: ids.installation, deviceId: ids.device, invoiceId: ids.invoice, chainPosition: 1,
    previous: null, hash: built.hash, generatedAt, canonicalSchema: 'aeat-registro-v1',
    canonicalRecord: built.canonicalRecord, lease: { leaseId: 'lease', fencingToken: 1 } }
  const invoice = { invoiceId: ids.invoice, ticketId: ids.ticket, saleId: ids.sale,
    series: 'L1-C1-2026-S', number: 1, issuedAt: generatedAt, totalCents: 1210 }
  const args = [ids.event, JSON.stringify(payload), JSON.stringify(record), JSON.stringify(invoice)]
  const call = (values = args) => db.query('select public.sync_local_fiscal_sale_created($1::uuid,$2::jsonb,$3::jsonb,$4::jsonb)', values)
  await assert.rejects(db.exec(`insert into public.sales(id,ticket_id,tenant_id,venue_id,cash_register_id,device_id)
    values ('${ids.sale}','${ids.ticket}','${ids.tenant}','${ids.venue}','${ids.register}','${ids.device}')`), /LOCAL_FISCAL_RECORD_REQUIRED/)
  await assert.rejects(db.exec(`insert into public.sales(id,ticket_id,tenant_id,venue_id,cash_register_id,device_id)
    values ('${ids.sale}','${ids.ticket}','${ids.tenant}','${ids.venue}','${ids.register}','dddddddd-dddd-4ddd-8ddd-dddddddddddd')`), /LOCAL_FISCAL_RECORD_REQUIRED/)
  await call()
  await call()
  const rows = await db.query('select chain_position, hash, ticket_id, sale_id, record_envelope, invoice_snapshot from public.fiscal_local_records')
  assert.equal(rows.rows.length, 1)
  assert.equal(rows.rows[0].hash, built.hash)
  assert.equal(rows.rows[0].record_envelope.idempotencyKey, ids.record)
  assert.equal(rows.rows[0].invoice_snapshot.series, invoice.series)
  assert.equal((await db.query('select last_number from public.fiscal_local_series')).rows[0].last_number, 1)
  await assert.rejects(call([ids.event, JSON.stringify(payload), JSON.stringify({ ...record, hash: 'D'.repeat(64) }), JSON.stringify(invoice)]), /IDEMPOTENCY_CONFLICT/)

  const secondTicket = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const secondSale = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const secondRecordId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  const secondInvoiceId = '12121212-1212-4212-8212-121212121212'
  await db.exec(`create function public.close_restaurant_order_checked_v2(uuid,text,integer,boolean,jsonb)
    returns jsonb language plpgsql as $$ begin
      insert into public.tickets(id,tenant_id,venue_id,cash_register_id,status) values
        ('${secondTicket}','${ids.tenant}','${ids.venue}','${ids.register}','paid');
      insert into public.sales(id,ticket_id,tenant_id,venue_id,cash_register_id,device_id) values
        ('${secondSale}','${secondTicket}','${ids.tenant}','${ids.venue}','${ids.register}','${ids.device}');
      return jsonb_build_object('requiresConfirmation',false,'ticketId','${secondTicket}',
        'saleId','${secondSale}','paymentId',null,'totalCents',1210);
    end $$`)
  const chained = await createAltaRecord({
    invoice: { issuerNif: '89890001K', seriesAndNumber: 'L1-C1-2026-S/2', issueDate: '28-09-2026' },
    issuerName: 'Emisor ficticio', type: 'F2', description: 'Segunda venta ficticia',
    details: [{ Impuesto: '01', ClaveRegimen: '01', CalificacionOperacion: 'S1', TipoImpositivo: '21.00',
      BaseImponibleOimporteNoSujeto: '10.00', CuotaRepercutida: '2.10' }],
    system: { NombreRazon: 'Productor ficticio', NIF: '89890001K', NombreSistemaInformatico: 'Tickit',
      IdSistemaInformatico: 'TK', Version: '1.0', NumeroInstalacion: 'INSTALL-1',
      TipoUsoPosibleSoloVerifactu: 'S', TipoUsoPosibleMultiOT: 'S', IndicadorMultiplesOT: 'S' },
      previous: { IDEmisorFactura: '89890001K', NumSerieFactura: 'L1-C1-2026-S/1',
      FechaExpedicionFactura: '28-09-2026', Huella: built.hash }, generatedAt, environment: 'production',
  })
  const secondRecord = { ...record, idempotencyKey: secondRecordId, invoiceId: secondInvoiceId, chainPosition: 2,
    previous: { issuerNif: '89890001K', seriesAndNumber: 'L1-C1-2026-S/1',
      issueDate: '28-09-2026', hash: built.hash }, hash: chained.hash, canonicalRecord: chained.canonicalRecord }
  const secondInvoice = { ...invoice, invoiceId: secondInvoiceId, ticketId: secondTicket, saleId: secondSale, number: 2 }
  const restaurantArgs = ['close', JSON.stringify({ orderId: ids.ticket, method: 'card', receivedCents: 1210,
    allowPending: true, discount: null }), JSON.stringify(secondRecord), JSON.stringify(secondInvoice)]
  const restaurantCall = (values = restaurantArgs) => db.query('select public.pay_restaurant_local_fiscal($1::text,$2::jsonb,$3::jsonb,$4::jsonb)', values)
  await assert.rejects(restaurantCall([restaurantArgs[0], restaurantArgs[1],
    JSON.stringify({ ...secondRecord, previous: { ...secondRecord.previous, seriesAndNumber: 'WRONG/1' } }),
    restaurantArgs[3]]), /LOCAL_FISCAL_CHAIN_CONFLICT/)
  await restaurantCall()
  await restaurantCall()
  assert.equal((await db.query('select count(*)::integer as n from public.fiscal_local_records')).rows[0].n, 2)
  assert.equal((await db.query('select last_number from public.fiscal_local_series')).rows[0].last_number, 2)
  await assert.rejects(restaurantCall([restaurantArgs[0], restaurantArgs[1], JSON.stringify(secondRecord),
    JSON.stringify({ ...secondInvoice, totalCents: 1220 })]), /IDEMPOTENCY_CONFLICT/)
  await assert.rejects(db.exec(`update public.tickets set status = 'voided' where id = '${secondTicket}'`), /LOCAL_FISCAL_INVOICE_IMMUTABLE/)
  await assert.rejects(db.exec(`delete from public.sales where id = '${secondSale}'`), /LOCAL_FISCAL_SALE_IMMUTABLE/)

  // Expand after historical records exist: their original identities remain usable
  // for pre-retirement pending synchronization, while new PWA series start at 1.
  await db.exec(`alter table devices add column is_active boolean default true;
    alter table devices add column can_take_payments boolean default true;
    alter table cash_registers add column is_active boolean default true;
    create table fiscal_pos_bridge_settings(tenant_id uuid,aeat_environment text);
    insert into fiscal_pos_bridge_settings values('${ids.tenant}','test');
    update venues set fiscal_code='L1'`)
  for (const statement of pwaMigration.split(/(create (?:unique )?index concurrently[^;]+;)/i)) {
    if (statement.trim()) await db.exec(statement)
  }
  const newInstallation = (await db.query('select activate_pwa_fiscal_installation($1,$2,$3,$4,$5,$6,false) as id',
    [ids.tenant,ids.venue,ids.register,ids.device,crypto.randomUUID(),ids.installation])).rows[0].id
  assert.equal((await db.query('select invoice_snapshot from fiscal_local_records where id=$1',[ids.record])).rows[0].invoice_snapshot.series,'L1-C1-2026-S')
  await call() // Acknowledgment lost before replacement remains idempotent.
  const previous = {issuerNif:'89890001K',seriesAndNumber:'L1-C1-2026-S/2',issueDate:'28-09-2026',hash:chained.hash}
  async function freshArgs(installationId, series, number, position, prior, issuedAt = generatedAt) {
    const ticketId = crypto.randomUUID(), saleId = crypto.randomUUID(), invoiceId = crypto.randomUUID()
    const system = {...built.canonicalRecord.RegistroAlta.SistemaInformatico,
      NumeroInstalacion: installationId === ids.installation ? 'INSTALL-1' : 'L1-C1-2'}
    const canonical = await createAltaRecord({invoice:{issuerNif:'89890001K',seriesAndNumber:`${series}/${number}`,issueDate:'28-09-2026'},
      issuerName:'Emisor ficticio',type:'F2',description:'Venta',details:built.canonicalRecord.RegistroAlta.Desglose.DetalleDesglose,
      system,previous:prior ? {IDEmisorFactura:prior.issuerNif,NumSerieFactura:prior.seriesAndNumber,FechaExpedicionFactura:prior.issueDate,Huella:prior.hash}:null,
      generatedAt:issuedAt,environment:'production'})
    return [crypto.randomUUID(),JSON.stringify({...payload,ticket:{...payload.ticket,id:ticketId},sale:{id:saleId}}),
      JSON.stringify({...record,idempotencyKey:crypto.randomUUID(),installationId,invoiceId,chainPosition:position,previous:prior,generatedAt:issuedAt,hash:canonical.hash,canonicalRecord:canonical.canonicalRecord}),
      JSON.stringify({...invoice,invoiceId,ticketId,saleId,series,number,issuedAt})]
  }
  // Pending record generated BEFORE replacement can still commit on the retired chain.
  await call(await freshArgs(ids.installation,'L1-C1-2026-S',3,3,previous))
  const retirement = (await db.query('select retired_at from fiscal_sif_installations where id=$1',[ids.installation])).rows[0].retired_at
  const afterRetirement = new Date(new Date(retirement).getTime()+1000).toISOString().slice(0,19)+'+00:00'
  await assert.rejects(call(await freshArgs(ids.installation,'L1-C1-2026-S',4,4,previous,afterRetirement)),/INSTALLATION_FORBIDDEN/)
  const newFirstArgs=await freshArgs(newInstallation,'L1-C1-2-2026-S',1,1,null)
  await call(newFirstArgs)
  await assert.rejects(call(await freshArgs(newInstallation,'L1-C1-2026-S',1,2,null)),/SERIES_MISMATCH/)
  assert.equal((await db.query('select last_number from fiscal_local_series where installation_id=$1',[newInstallation])).rows[0].last_number,1)
  const newFirst=JSON.parse(newFirstArgs[2])
  const nextArgs=await freshArgs(newInstallation,'L1-C1-2-2026-S',2,2,{issuerNif:'89890001K',seriesAndNumber:'L1-C1-2-2026-S/1',issueDate:'28-09-2026',hash:newFirst.hash})
  const nextInvoice=JSON.parse(nextArgs[3])
  await db.exec(`create or replace function public.close_restaurant_order_checked_v2(uuid,text,integer,boolean,jsonb) returns jsonb language plpgsql as $$begin
    insert into public.tickets(id,tenant_id,venue_id,cash_register_id,status) values('${nextInvoice.ticketId}','${ids.tenant}','${ids.venue}','${ids.register}','paid');
    insert into public.sales(id,ticket_id,tenant_id,venue_id,cash_register_id,device_id) values('${nextInvoice.saleId}','${nextInvoice.ticketId}','${ids.tenant}','${ids.venue}','${ids.register}','${ids.device}');
    return jsonb_build_object('requiresConfirmation',false,'ticketId','${nextInvoice.ticketId}','saleId','${nextInvoice.saleId}','paymentId',null,'totalCents',1210);
  end$$`)
  const badSystem=JSON.parse(nextArgs[2])
  badSystem.canonicalRecord.RegistroAlta.SistemaInformatico.NumeroInstalacion='INSTALL-1'
  await assert.rejects(restaurantCall(['close',restaurantArgs[1],JSON.stringify(badSystem),nextArgs[3]]),/INSTALLATION_IDENTITY_MISMATCH/)
  assert.equal((await db.query('select count(*)::integer as n from tickets where id=$1',[nextInvoice.ticketId])).rows[0].n,0)
  await restaurantCall(['close',restaurantArgs[1],nextArgs[2],nextArgs[3]])
  assert.equal((await db.query('select last_number from fiscal_local_series where installation_id=$1',[newInstallation])).rows[0].last_number,2)
})
