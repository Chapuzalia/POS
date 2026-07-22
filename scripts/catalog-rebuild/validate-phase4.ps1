param([string]$Container = 'pos-catalog-phase4', [string]$Database = 'pos_catalog_phase4_fixture')
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$work = Join-Path ([System.IO.Path]::GetTempPath()) 'pos-catalog-phase4-isolated'
New-Item -ItemType Directory -Force $work | Out-Null

$baseline = [IO.File]::ReadAllText((Join-Path $root 'tests\fixtures\catalog-rebuild\catalog-pre-phase4-baseline.sql'))
$marker = 'create or replace function public.remove_restaurant_order_line_confirmed('
$split = $baseline.IndexOf($marker)
if ($split -lt 0) { throw 'Historical baseline split point was not found.' }
[IO.File]::WriteAllText((Join-Path $work 'baseline-before-orders.sql'),$baseline.Substring(0,$split),[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $work 'baseline-after-orders.sql'),$baseline.Substring($split),[Text.UTF8Encoding]::new($false))

& docker exec $Container dropdb -U postgres --if-exists $Database
& docker exec $Container createdb -U postgres $Database
& docker cp (Join-Path $root 'tests\fixtures\catalog-rebuild\supabase-prelude.sql') "${Container}:/tmp/prelude.sql"
& docker cp (Join-Path $work 'baseline-before-orders.sql') "${Container}:/tmp/baseline-before-orders.sql"
& docker cp (Join-Path $work 'baseline-after-orders.sql') "${Container}:/tmp/baseline-after-orders.sql"
& docker cp (Join-Path $root 'supabase\.') "${Container}:/tmp/supabase"
& docker cp (Join-Path $root 'tests\fixtures\catalog-rebuild\catalog-final-cleanup.sql') "${Container}:/tmp/catalog-final-cleanup.sql"
& docker exec $Container psql -q -v ON_ERROR_STOP=1 -U postgres -d $Database -f /tmp/prelude.sql
& docker exec $Container psql -q -v ON_ERROR_STOP=1 -U postgres -d $Database -f /tmp/baseline-before-orders.sql
& docker exec $Container psql -q -v ON_ERROR_STOP=1 -U postgres -d $Database -f /tmp/supabase/1.restaurant-tables-block1-migration.sql
& docker exec $Container psql -q -v ON_ERROR_STOP=1 -U postgres -d $Database -f /tmp/baseline-after-orders.sql

$migrations = Get-ChildItem (Join-Path $root 'supabase') -File -Filter '*.sql' | Where-Object {
  $_.BaseName -match '^(\d+(?:\.\d+)?)\.' -and [decimal]$matches[1] -gt 1 -and [decimal]$matches[1] -lt 42
} | Sort-Object { [decimal]([regex]::Match($_.BaseName,'^\d+(?:\.\d+)?').Value) }
foreach ($migration in $migrations) {
  & docker exec $Container psql -q -v ON_ERROR_STOP=1 -U postgres -d $Database -f "/tmp/supabase/$($migration.Name)"
  if ($LASTEXITCODE -ne 0) { throw "Failed $($migration.Name)" }
}
& docker exec $Container psql -q -v ON_ERROR_STOP=1 -U postgres -d $Database -f /tmp/catalog-final-cleanup.sql
if ($LASTEXITCODE -ne 0) { throw 'PHASE4_ISOLATED_FAILED' }
