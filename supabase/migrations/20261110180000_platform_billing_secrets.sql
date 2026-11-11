-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- Mollie/Odoo credentials set from the Superadmin settings page. A missing value falls back to the Edge env.
create table public.platform_billing_secrets (
  id boolean primary key default true check (id),
  mollie_api_key text check (mollie_api_key ~ '^(live|test)_[A-Za-z0-9]{20,64}$'),
  odoo_url text check (odoo_url ~ '^https://'),
  odoo_db text,
  odoo_api_key text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
create index platform_billing_secrets_updated_by_idx on public.platform_billing_secrets(updated_by);

-- RLS without policies: service role only. The billing function never returns the keys to a browser.
alter table public.platform_billing_secrets enable row level security;
