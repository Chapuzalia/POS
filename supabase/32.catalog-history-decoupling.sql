begin;

-- Open orders keep their catalogue UUID snapshots during replacement. They are
-- intentionally not referential dependencies of mutable catalogue rows.
alter table public.order_lines drop constraint if exists order_lines_product_id_fkey;
alter table public.order_lines drop constraint if exists order_lines_variant_id_fkey;
alter table public.order_lines drop constraint if exists order_lines_mixer_product_id_fkey;

comment on column public.order_lines.product_id is 'Catalogue UUID snapshot without a live foreign key.';
comment on column public.order_lines.variant_id is 'Catalogue UUID snapshot without a live foreign key.';
comment on column public.ticket_lines.product_id is 'Historical catalogue UUID snapshot without a live foreign key.';
comment on column public.ticket_lines.variant_id is 'Historical catalogue UUID snapshot without a live foreign key.';

commit;
