param(
  [string]$Container = 'pos-catalog-phase4',
  [string]$CleanDatabase = 'pos_catalog_clean',
  [string]$HistoricalDatabase = 'pos_catalog_phase4_fixture'
)
$ErrorActionPreference = 'Stop'

$query = @'
with objects as (
  select 'schema' kind,n.nspname name,'' detail from pg_namespace n where n.nspname='public'
  union all
  select 'relation',c.relname,concat_ws('|',c.relkind,c.relrowsecurity,c.relforcerowsecurity,obj_description(c.oid,'pg_class'))
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in('r','p','v','m','S')
  union all
  select 'column',c.relname||'.'||a.attname,concat_ws('|',format_type(a.atttypid,a.atttypmod),a.attnotnull,
    coalesce(pg_get_expr(d.adbin,d.adrelid),''),a.attidentity,a.attgenerated,coalesce(col_description(c.oid,a.attnum),''))
  from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where n.nspname='public' and c.relkind in('r','p','v','m')
  union all
  select 'constraint',co.conrelid::regclass::text||'.'||co.conname,pg_get_constraintdef(co.oid,true)
  from pg_constraint co join pg_namespace n on n.oid=co.connamespace where n.nspname='public'
  union all
  select 'index',i.indexrelid::regclass::text,pg_get_indexdef(i.indexrelid)
  from pg_index i join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
  union all
  select 'function',p.oid::regprocedure::text,concat_ws('|',pg_get_function_result(p.oid),p.provolatile,p.prosecdef,
    coalesce(array_to_string(p.proconfig,','),''),pg_get_functiondef(p.oid))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'
  union all
  select 'trigger',t.tgrelid::regclass::text||'.'||t.tgname,pg_get_triggerdef(t.oid,true)
  from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and not t.tgisinternal
  union all
  select 'policy',schemaname||'.'||tablename||'.'||policyname,concat_ws('|',cmd,permissive,roles,qual,with_check)
  from pg_policies where schemaname in('public','storage')
  union all
  select 'table_grant',table_name||'.'||grantee||'.'||privilege_type,is_grantable from information_schema.table_privileges where table_schema='public'
  union all
  select 'routine_grant',routine_name||'.'||grantee||'.'||privilege_type,is_grantable from information_schema.routine_privileges where routine_schema='public'
)
select kind||E'\t'||name||E'\t'||replace(replace(coalesce(detail,''),E'\r',''),E'\n',E'\\n') from objects order by kind,name,detail;
'@

function Read-Structure([string]$Database) {
  $result = & docker exec $Container psql -v ON_ERROR_STOP=1 -U postgres -d $Database -At -c $query
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect $Database" }
  return $result
}

$clean = Read-Structure $CleanDatabase
$historical = Read-Structure $HistoricalDatabase
$difference = Compare-Object $clean $historical
if ($difference) {
  $difference | Select-Object -First 30 | Format-Table | Out-String | Write-Error
  throw 'PHASE4_SCHEMA_EQUIVALENCE_FAILED'
}
Write-Output 'PHASE4_SCHEMA_EQUIVALENCE_OK'
