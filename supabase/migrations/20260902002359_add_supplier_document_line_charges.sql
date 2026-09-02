alter table public.supplier_document_lines
  add column if not exists charges_amount numeric(18, 6) not null default 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'supplier_document_lines_charges_amount_check'
      and conrelid = 'public.supplier_document_lines'::regclass
  ) then
    alter table public.supplier_document_lines
      add constraint supplier_document_lines_charges_amount_check
      check (charges_amount >= 0) not valid;
  end if;
end;
$$;

alter table public.supplier_document_lines
  validate constraint supplier_document_lines_charges_amount_check;

comment on column public.supplier_document_lines.charges_amount is
  'Suma de cargos auxiliares del bloque OCR; cero para líneas y perfiles heredados.';
