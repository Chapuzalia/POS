-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: Restricts only the new table-link issuance RPC to the trusted API service role; existing POS RPC grants remain unchanged.

create function public.tickit_api_table_link(p_integration_id uuid,p_table_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i tickit_private.integrations; t public.restaurant_tables%rowtype; token text;
begin
  select * into i from tickit_private.integrations where id=p_integration_id and enabled for share;
  if i.id is null then raise exception 'INTEGRATION_UNAVAILABLE' using errcode='42501'; end if;
  select * into t from public.restaurant_tables
    where id=p_table_id and tenant_id=i.tenant_id and venue_id=i.venue_id and is_active and cash_session_id is null;
  if t.id is null then raise exception 'TABLE_UNAVAILABLE' using errcode='42501'; end if;
  token:=replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
  insert into tickit_private.table_links(table_id,integration_id,token_hash)
    values(t.id,i.id,encode(extensions.digest(token,'sha256'),'hex'))
    on conflict(table_id) do update set token_hash=excluded.token_hash,integration_id=excluded.integration_id;
  delete from tickit_private.sessions where table_id=t.id;
  return jsonb_build_object('tableToken',token,'tableName',t.name);
end $$;
revoke all on function public.tickit_api_table_link(uuid,uuid) from public, anon, authenticated;
grant execute on function public.tickit_api_table_link(uuid,uuid) to service_role;
notify pgrst, 'reload schema';
