-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- Odoo (Alteil's fiscal issuer) customer linked to each billed business.
alter table public.billing_accounts add column odoo_partner_id bigint;

-- One row per Mollie payment: the Odoo proforma (sale.order), invoice and credit note issued for it.
create table public.billing_odoo_documents (
  payment_id text primary key references public.billing_invoices(stripe_invoice_id),
  tenant_id uuid not null references public.billing_accounts(tenant_id),
  state text not null check (state in ('proforma','invoiced','canceled','refunded','failed')),
  sale_order_id bigint,
  invoice_id bigint,
  refund_id bigint,
  invoice_number text,
  last_error text,
  attempts integer not null default 0,
  updated_at timestamptz not null default now()
);
create index billing_odoo_documents_tenant_idx on public.billing_odoo_documents(tenant_id);

-- RLS without policies: service role only (Edge Functions); owners see documents through the billing function.
alter table public.billing_odoo_documents enable row level security;
