begin;

alter table public.product_images add column if not exists updated_at timestamptz not null default now();
drop trigger if exists product_images_updated_at on public.product_images;
create trigger product_images_updated_at before update on public.product_images for each row execute function public.set_updated_at();

do $$ declare t text;
begin
  foreach t in array array['product_images','product_selection_group_assignment_variants','product_modifier_group_assignment_variants'] loop
    execute format('drop trigger if exists %I on public.%I',t||'_audit',t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.audit_catalog_change()',t||'_audit',t);
  end loop;
end $$;

commit;
