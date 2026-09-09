begin;

create or replace function public.promote_supplier_parser_candidate_when_ready()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if new.status = 'candidate'
    and new.success_count >= 3
    and new.correction_count::numeric / greatest(new.success_count, 1) <= 0.15
  then
    new.status := 'verified';
  end if;

  return new;
end;
$$;

revoke all on function public.promote_supplier_parser_candidate_when_ready()
from public, anon, authenticated;

drop trigger if exists promote_supplier_parser_candidate_when_ready
on public.global_supplier_document_profiles;

create trigger promote_supplier_parser_candidate_when_ready
before update of success_count, correction_count
on public.global_supplier_document_profiles
for each row
execute function public.promote_supplier_parser_candidate_when_ready();

-- Recupera candidatos que hayan quedado atascados por la regresión.
update public.global_supplier_document_profiles
set
  status = 'verified',
  updated_at = now()
where status = 'candidate'
  and success_count >= 3
  and correction_count::numeric / greatest(success_count, 1) <= 0.15;

commit;