-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

begin;

lock table public.fiscal_local_records in access exclusive mode;

create temporary table _historical_fiscal_uuid_repair on commit drop as
select r.id as old_id, r.idempotency_key as old_key, r.invoice_id as old_invoice,
  r.tenant_id,
  case when r.id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then r.id
    else (substring(r.id::text, 1, 14) || '3' || substring(r.id::text, 16, 4) || '8' || substring(r.id::text, 21, 16))::uuid end as new_id,
  case when r.invoice_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then r.invoice_id
    else (substring(r.invoice_id::text, 1, 14) || '3' || substring(r.invoice_id::text, 16, 4) || '8' || substring(r.invoice_id::text, 21, 16))::uuid end as new_invoice
from public.fiscal_local_records r
where r.ticket_id is not null
  and r.id = md5(r.ticket_id::text || case r.record_kind when 'alta' then ':alta' else ':anulacion' end)::uuid
  and r.idempotency_key = r.id
  and r.invoice_id = md5(r.ticket_id::text || ':sif-invoice')::uuid
  and r.record_envelope->>'idempotencyKey' = r.id::text
  and r.record_envelope->>'invoiceId' = r.invoice_id::text
  and (
    substring(r.id::text, 15, 1) not in ('1','2','3','4','5','6','7','8')
    or substring(r.id::text, 20, 1) not in ('8','9','a','b')
    or substring(r.idempotency_key::text, 15, 1) not in ('1','2','3','4','5','6','7','8')
    or substring(r.idempotency_key::text, 20, 1) not in ('8','9','a','b')
    or substring(r.invoice_id::text, 15, 1) not in ('1','2','3','4','5','6','7','8')
    or substring(r.invoice_id::text, 20, 1) not in ('8','9','a','b')
  );

do $$
begin
  if exists (
    select 1 from _historical_fiscal_uuid_repair repair
    join public.fiscal_local_records existing on existing.id = repair.new_id and existing.id <> repair.old_id
  ) or exists (
    select 1 from _historical_fiscal_uuid_repair repair
    join public.fiscal_local_records existing on existing.idempotency_key = repair.new_id and existing.id <> repair.old_id
  ) or exists (
    select 1 from _historical_fiscal_uuid_repair repair
    join public.fiscal_local_records existing on existing.invoice_id = repair.new_invoice and existing.invoice_id <> repair.old_invoice
  ) then
    raise exception 'FISCAL_UUID_REPAIR_COLLISION';
  end if;
end;
$$;

alter table public.fiscal_local_records disable trigger fiscal_local_records_no_rewrite;

update public.fiscal_local_records r
set id = repair.new_id,
    idempotency_key = repair.new_id,
    invoice_id = repair.new_invoice,
    record_envelope = jsonb_set(
      jsonb_set(r.record_envelope, '{idempotencyKey}', to_jsonb(repair.new_id::text)),
      '{invoiceId}', to_jsonb(repair.new_invoice::text)
    )
from _historical_fiscal_uuid_repair repair
where r.id = repair.old_id;

alter table public.fiscal_local_records enable trigger fiscal_local_records_no_rewrite;

commit;
