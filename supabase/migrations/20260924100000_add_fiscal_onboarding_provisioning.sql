-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

alter table public.fiscal_entities
  add column if not exists fiscal_address text,
  add column if not exists fiscal_postal_code text,
  add column if not exists fiscal_city text,
  add column if not exists fiscal_country_code text not null default 'ES',
  add column if not exists provisioning_status text not null default 'ready',
  add column if not exists provisioning_error text,
  add column if not exists odoo_company_id integer,
  add column if not exists provisioning_started_at timestamptz,
  add column if not exists provisioning_completed_at timestamptz;

alter table public.fiscal_entities
  add constraint fiscal_entities_provisioning_status_check
  check (provisioning_status in ('pending', 'provisioning', 'ready', 'error'));

create unique index if not exists fiscal_entities_provider_entity_ref_uidx
  on public.fiscal_entities (provider_entity_ref)
  where provider_entity_ref is not null;

create unique index if not exists fiscal_entities_tenant_normalized_tax_id_uidx
  on public.fiscal_entities (tenant_id, upper(regexp_replace(tax_id, '[ .-]', '', 'g')));

create index if not exists fiscal_entities_provisioning_status_idx
  on public.fiscal_entities (tenant_id, provisioning_status, updated_at desc);

drop view if exists public.fiscal_entities_safe;

create view public.fiscal_entities_safe with (security_invoker = true) as
select id, tenant_id, display_name, legal_name, tax_id, fiscal_address, fiscal_postal_code,
  fiscal_city, fiscal_country_code, integration_provider, tax_system, environment, enabled,
  automatic_submission, provider_entity_ref, provisioning_status, provisioning_error,
  odoo_company_id, provisioning_started_at, provisioning_completed_at, created_at, updated_at
from public.fiscal_entities;

grant select (id, tenant_id, display_name, legal_name, tax_id, fiscal_address, fiscal_postal_code,
  fiscal_city, fiscal_country_code, integration_provider, tax_system, environment, enabled,
  automatic_submission, provider_entity_ref, provisioning_status, provisioning_error,
  odoo_company_id, provisioning_started_at, provisioning_completed_at, created_at, updated_at)
  on public.fiscal_entities to authenticated;
