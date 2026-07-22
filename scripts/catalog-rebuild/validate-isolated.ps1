param([string]$Container = 'pos-catalog-phase2', [string]$Database = 'pos_catalog_test')
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$work = Join-Path ([System.IO.Path]::GetTempPath()) 'pos-catalog-isolated'
New-Item -ItemType Directory -Force $work | Out-Null

$baseline = [System.IO.File]::ReadAllText((Join-Path $root 'supabase\0.complete-database.sql'))
$marker = 'create or replace function public.remove_restaurant_order_line_confirmed('
$split = $baseline.IndexOf($marker)
if ($split -lt 0) { throw 'No se encontró el punto de orden preexistente del baseline.' }
[System.IO.File]::WriteAllText((Join-Path $work 'baseline-before-orders.sql'), $baseline.Substring(0, $split), [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText((Join-Path $work 'baseline-after-orders.sql'), $baseline.Substring($split), [System.Text.UTF8Encoding]::new($false))

docker cp (Join-Path $root 'tests\fixtures\catalog-rebuild\supabase-prelude.sql') "${Container}:/tmp/prelude.sql"
docker cp (Join-Path $work 'baseline-before-orders.sql') "${Container}:/tmp/baseline-before-orders.sql"
docker cp (Join-Path $work 'baseline-after-orders.sql') "${Container}:/tmp/baseline-after-orders.sql"
docker cp (Join-Path $root 'supabase') "${Container}:/tmp/supabase"
docker exec $Container psql -v ON_ERROR_STOP=1 -U postgres -d $Database -f /tmp/prelude.sql
docker exec $Container psql -v ON_ERROR_STOP=1 -U postgres -d $Database -f /tmp/baseline-before-orders.sql
docker exec $Container psql -v ON_ERROR_STOP=1 -U postgres -d $Database -f /tmp/supabase/1.restaurant-tables-block1-migration.sql
docker exec $Container psql -v ON_ERROR_STOP=1 -U postgres -d $Database -f /tmp/baseline-after-orders.sql

$migrations = Get-ChildItem (Join-Path $root 'supabase') -File -Filter '*.sql' | Where-Object {
  $_.BaseName -match '^(\d+(?:\.\d+)?)\.' -and [decimal]$matches[1] -gt 1
} | Sort-Object { [decimal]([regex]::Match($_.BaseName, '^\d+(?:\.\d+)?').Value) }
foreach ($migration in $migrations) {
  docker exec $Container psql -v ON_ERROR_STOP=1 -U postgres -d $Database -f "/tmp/supabase/$($migration.Name)"
  if ($LASTEXITCODE -ne 0) { throw "Falló $($migration.Name)" }
}
