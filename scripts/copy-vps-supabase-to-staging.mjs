#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { closeSync, createReadStream, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

// Explicit scope: application schemas plus the ACTUAL production migration ledger.
export const appSchemas = ['public', 'pos_private', 'supabase_migrations']
const managedSchemas = ['auth', 'storage']
const dumpExcludedData = new Set([
  'auth.schema_migrations', 'storage.migrations',
  'storage.buckets_vectors', 'storage.vector_indexes',
])
const analyticsTables = new Set(['storage.buckets_analytics', 'storage.iceberg_namespaces', 'storage.iceberg_tables'])
const excludedData = new Set([...dumpExcludedData, ...analyticsTables])
const identifier = /^[a-z_][a-z0-9_]*$/
const quoteSql = (value) => `'${value.replaceAll("'", "''")}'`
const quoteShell = (value) => `'${value.replaceAll("'", "'\\''")}'`

export function targetConfig(env) {
  const ref = env.STAGING_PROJECT_REF ?? ''
  if (!/^[a-z]{20}$/.test(ref)) throw new Error('STAGING_PROJECT_REF debe ser el ref de staging (20 letras).')
  const host = env.STAGING_DB_HOST ?? ''
  const user = env.STAGING_DB_USER ?? ''
  const direct = host === `db.${ref}.supabase.co` && user === 'postgres'
  const pooler = /^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host) && user === `postgres.${ref}`
  if (!direct && !pooler) throw new Error('El host/usuario no corresponde al proyecto Cloud de staging indicado.')
  if (env.STAGING_DB_PORT && env.STAGING_DB_PORT !== '5432') throw new Error('Usa puerto 5432: conexión directa o session pooler; nunca transaction pooler.')
  if (!env.STAGING_DB_PASSWORD && !env.STAGING_PGPASSFILE) throw new Error('Configura STAGING_DB_PASSWORD o STAGING_PGPASSFILE.')
  const childEnv = { ...env }
  // Empty service-file values still make libpq try to open a file. Remove
  // inherited overrides entirely, including differently cased Windows keys.
  for (const key of Object.keys(childEnv)) {
    if (/^(PGSERVICE|PGSERVICEFILE|PGOPTIONS|PGHOSTADDR|PGPASSWORD|PGPASSFILE|PGHOST|PGPORT|PGUSER|PGDATABASE|PGSSLMODE|PGCONNECT_TIMEOUT)$/i.test(key)) delete childEnv[key]
  }
  Object.assign(childEnv, {
    PGHOST: host, PGPORT: '5432', PGUSER: user, PGDATABASE: 'postgres',
    PGSSLMODE: 'require', PGCONNECT_TIMEOUT: '15',
  })
  if (env.STAGING_DB_PASSWORD) childEnv.PGPASSWORD = env.STAGING_DB_PASSWORD
  if (env.STAGING_PGPASSFILE) childEnv.PGPASSFILE = env.STAGING_PGPASSFILE
  return childEnv
}

export function selectRestoreEntries(toc, customTriggers) {
  const selected = []
  const dataTables = []
  const skippedManagedDefaultAcls = []
  for (const line of toc.split(/\r?\n/)) {
    if (!/^\d+; /.test(line)) continue
    const content = line.replace(/^\d+; \d+ \d+ /, '')
    // Cloud's postgres cannot ALTER DEFAULT PRIVILEGES for supabase_admin.
    // These govern future objects created by the platform role, not the ACLs
    // of restored objects. Keep postgres defaults and every explicit app ACL.
    if (/^DEFAULT ACL (public|pos_private|supabase_migrations) DEFAULT PRIVILEGES FOR (TABLES|SEQUENCES|FUNCTIONS|TYPES|SCHEMAS) supabase_admin$/.test(content)) {
      skippedManagedDefaultAcls.push(content)
      continue
    }
    // Application identifiers in this repository do not contain whitespace.
    const schema = content.match(/^[A-Z][A-Z ]* (public|pos_private|supabase_migrations) /)?.[1]
      ?? content.match(/^(?:SCHEMA -|COMMENT - SCHEMA|ACL - SCHEMA) (public|pos_private|supabase_migrations) /)?.[1]
    if (schema) {
      selected.push(line)
      continue
    }
    const table = content.match(/^TABLE DATA (auth|storage) (\w+) \S+$/)
    if (table && !excludedData.has(`${table[1]}.${table[2]}`)) {
      selected.push(line)
      dataTables.push(`${table[1]}.${table[2]}`)
    } else {
      const policy = content.match(/^POLICY (auth|storage) (\w+) /)
      if (policy && !excludedData.has(`${policy[1]}.${policy[2]}`)) selected.push(line)
      const trigger = content.match(/^TRIGGER (auth|storage) (\w+) (\w+) \S+$/)
      if (trigger && !excludedData.has(`${trigger[1]}.${trigger[2]}`)
        && customTriggers.has(`${trigger[1]}.${trigger[2]}.${trigger[3]}`)) selected.push(line)
    }
  }
  if (!selected.some((line) => /TABLE DATA supabase_migrations schema_migrations /.test(line))) {
    throw new Error('El dump no contiene supabase_migrations.schema_migrations; no se restaurará un historial incompleto.')
  }
  if (!dataTables.includes('auth.users')) throw new Error('El dump no contiene auth.users.')
  return { list: `${selected.join('\n')}\n`, dataTables, skippedManagedDefaultAcls }
}

// Inspect the dump's snapshot, rather than a separate live count that could race
// with writes. Preserve Analytics in the raw dump but never silently discard data.
export async function assertEmptyAnalyticsSql(path) {
  const input = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let table = null
  try {
    for await (const line of lines) {
      const copy = line.match(/^COPY (storage\.\w+) /)
      if (copy) {
        if (!analyticsTables.has(copy[1])) throw new Error('Tabla inesperada en la comprobación de Analytics.')
        table = copy[1]
      } else if (table && line === '\\.') {
        table = null
      } else if (table) {
        throw new Error(`${table} contiene datos de Analytics. Requiere una migración específica; staging no se modificará.`)
      } else if (/^INSERT INTO storage\./.test(line)) {
        throw new Error('El dump contiene datos de Analytics; requiere una migración específica.')
      }
    }
    if (table) throw new Error('COPY de Analytics incompleto; no se restaurará el dump.')
  } finally {
    lines.close()
    input.destroy()
  }
}

export function resetSql() {
  const schemas = appSchemas.map(quoteSql).join(',')
  return `SET lock_timeout = '10s';
SET statement_timeout = '30min';
SELECT pg_advisory_xact_lock(731904218);
SET session_replication_role = replica;
-- Remove app-dependent triggers/policies/FKs together with the old app schema.
DROP SCHEMA IF EXISTS public, pos_private, supabase_migrations CASCADE;
DO $reset$
DECLARE item record; tables text;
BEGIN
  FOR item IN SELECT schemaname, tablename, policyname FROM pg_policies
    WHERE schemaname IN ('auth', 'storage')
      AND (schemaname || '.' || tablename) NOT IN (${[...excludedData].map(quoteSql).join(',')})
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', item.policyname, item.schemaname, item.tablename);
  END LOOP;
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ',') INTO tables
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('auth', 'storage') AND c.relkind = 'r'
      AND (n.nspname || '.' || c.relname) NOT IN (${[...excludedData].map(quoteSql).join(',')});
  -- No CASCADE: an unexpected dependency outside the scope aborts the transaction.
  IF tables IS NOT NULL THEN EXECUTE 'TRUNCATE TABLE ' || tables; END IF;
END $reset$;
-- Selected pg_dump schemas must recreate these, including the migration ledger.
-- Scope: ${schemas}
`
}

export function verificationSql() {
  return `SET session_replication_role = origin;
-- COPY with replica disables FK triggers. Check existing validated FKs with
-- SELECTs; Cloud's managed tables must not require any ALTER TABLE permission.
DO $verify$
DECLARE item record; predicates record; invalid boolean; condition text; next_id bigint; allocated_id bigint;
BEGIN
  FOR item IN SELECT c.*, c.conrelid::regclass AS tbl, c.confrelid::regclass AS parent_tbl
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    JOIN pg_class relation ON relation.oid = c.conrelid
    WHERE c.contype = 'f' AND c.convalidated
      AND n.nspname IN ('public', 'pos_private', 'auth', 'storage')
      AND (n.nspname || '.' || relation.relname) NOT IN (${[...excludedData].map(quoteSql).join(',')})
  LOOP
    SELECT string_agg(format('child.%I IS NOT NULL', a.attname), ' AND ' ORDER BY k.i) AS all_present,
      string_agg(format('child.%I IS NULL', a.attname), ' OR ' ORDER BY k.i) AS any_null,
      string_agg(format('child.%I IS NOT NULL', a.attname), ' OR ' ORDER BY k.i) AS any_present,
      string_agg(format('parent.%I OPERATOR(%I.%s) child.%I', b.attname, ns.nspname, op.oprname, a.attname), ' AND ' ORDER BY k.i) AS equality
      INTO predicates
      FROM generate_subscripts(item.conkey, 1) AS k(i)
      JOIN pg_attribute a ON a.attrelid=item.conrelid AND a.attnum=item.conkey[k.i]
      JOIN pg_attribute b ON b.attrelid=item.confrelid AND b.attnum=item.confkey[k.i]
      JOIN pg_operator op ON op.oid=item.conpfeqop[k.i]
      JOIN pg_namespace ns ON ns.oid=op.oprnamespace;
    condition := format('(%s) AND NOT EXISTS (SELECT 1 FROM %s parent WHERE %s)',
      predicates.all_present, item.parent_tbl, predicates.equality);
    IF item.confmatchtype = 'f' THEN
      condition := condition || format(' OR ((%s) AND (%s))', predicates.any_null, predicates.any_present);
    END IF;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s child WHERE %s)', item.tbl, condition) INTO invalid;
    IF invalid THEN RAISE EXCEPTION 'FK inválida después de restaurar: %.%', item.tbl, item.conname; END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations) THEN
    RAISE EXCEPTION 'El historial de migraciones de producción está vacío';
  END IF;
  -- Existing managed sequences are excluded from pg_restore's SEQUENCE SET.
  -- Use transactional RESTART where allowed. Cloud platform-owned sequences
  -- instead advance via nextval (USAGE): never lower a sequence or use setval.
  FOR item IN SELECT s.schemaname, s.sequencename, s.increment_by, s.start_value,
      s.last_value, s.cycle, t.oid::regclass AS tbl, a.attname,
      pg_has_role(current_user, seq.relowner, 'USAGE') AS can_restart
    FROM pg_sequences s JOIN pg_namespace n ON n.nspname=s.schemaname
    JOIN pg_class seq ON seq.relnamespace=n.oid AND seq.relname=s.sequencename
    JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=seq.oid
      AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
    JOIN pg_class t ON t.oid=d.refobjid
    JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
    WHERE s.schemaname IN ('auth','storage')
      AND (s.schemaname || '.' || t.relname) NOT IN (${[...excludedData].map(quoteSql).join(',')})
  LOOP
    IF item.increment_by <= 0 OR item.cycle THEN RAISE EXCEPTION 'Secuencia gestionada descendente/cíclica no soportada'; END IF;
    EXECUTE format('SELECT greatest(coalesce(max(%I) + $1, $2), $2) FROM %s', item.attname, item.tbl)
      INTO next_id USING item.increment_by, greatest(coalesce(item.last_value + item.increment_by, item.start_value), item.start_value);
    IF next_id <= coalesce(item.last_value + item.increment_by, item.start_value) THEN CONTINUE; END IF;
    IF item.can_restart THEN
      EXECUTE format('ALTER SEQUENCE %I.%I RESTART WITH %s', item.schemaname, item.sequencename, next_id);
    ELSE
      -- nextval cannot roll back; consumed values can leave harmless gaps if a
      -- later failure rolls back the data, but never create duplicate IDs.
      LOOP
        EXECUTE format('SELECT pg_catalog.nextval(%L::regclass)', format('%I.%I', item.schemaname, item.sequencename)) INTO allocated_id;
        EXIT WHEN allocated_id >= next_id - item.increment_by;
      END LOOP;
    END IF;
  END LOOP;
END $verify$;
NOTIFY pgrst, 'reload schema';
`
}

export const catalogSql = `SELECT json_build_object(
  'serverVersion', current_setting('server_version_num')::int,
  'schemas', (SELECT json_agg(nspname ORDER BY nspname) FROM pg_namespace WHERE nspname IN ('public','pos_private','supabase_migrations')),
  'columns', (SELECT json_agg(json_build_object('schema',table_schema,'table',table_name,'column',column_name,
    'type',udt_schema || '.' || udt_name,'nullable',is_nullable,'default',column_default,'identity',is_identity,'generated',is_generated) ORDER BY table_schema,table_name,ordinal_position)
    FROM information_schema.columns WHERE table_schema IN ('auth','storage')),
  'triggers', (SELECT coalesce(json_agg(n.nspname || '.' || c.relname || '.' || t.tgname ORDER BY n.nspname,c.relname,t.tgname), '[]'::json)
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
    WHERE NOT t.tgisinternal AND n.nspname IN ('auth','storage') AND pn.nspname IN ('public','pos_private')),
  'history', (SELECT json_agg(version ORDER BY version) FROM supabase_migrations.schema_migrations)
);`

export function checkManagedColumns(source, target, dataTables) {
  const tables = new Set(dataTables)
  const sourceColumns = new Map(source.columns.map((c) => [`${c.schema}.${c.table}.${c.column}`, c]))
  const targetColumns = new Map(target.columns.map((c) => [`${c.schema}.${c.table}.${c.column}`, c]))
  for (const [key, column] of sourceColumns) {
    if (!tables.has(`${column.schema}.${column.table}`)) continue
    if (targetColumns.get(key)?.type !== column.type) throw new Error(`Columna gestionada incompatible en Cloud: ${key}.`)
  }
  for (const [key, column] of targetColumns) {
    if (tables.has(`${column.schema}.${column.table}`) && !sourceColumns.has(key)
      && column.nullable === 'NO' && column.default === null && column.identity !== 'YES' && column.generated !== 'ALWAYS') {
      throw new Error(`Cloud requiere una columna ausente en el origen: ${key}.`)
    }
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/copy-vps-supabase-to-staging.mjs [--dump-only | --replace-staging PROJECT_REF]\nConfiguración y requisitos: docs/copy-vps-supabase-to-staging.md')
    return
  }
  const replace = args[0] === '--replace-staging' && args.length === 2
  if (!(args.length === 0 || (args.length === 1 && args[0] === '--dump-only') || replace)) throw new Error('Argumentos no válidos; usa --help.')
  const env = process.env
  const sshHost = env.VPS_SSH_HOST ?? ''
  if (!/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(sshHost)) throw new Error('Configura VPS_SSH_HOST (alias SSH o usuario@host).')
  const container = env.VPS_DB_CONTAINER ?? 'supabase-db'
  const user = env.VPS_DB_USER ?? 'supabase_admin'
  const database = env.VPS_DB_NAME ?? 'postgres'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container) || !identifier.test(user) || !identifier.test(database)) throw new Error('Contenedor, usuario o base de origen no válido.')
  const pgEnv = targetConfig(env)
  if (replace && args[1] !== env.STAGING_PROJECT_REF) throw new Error('La confirmación no coincide con STAGING_PROJECT_REF.')
  const output = resolve('backups', `vps-to-staging-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}`)
  mkdirSync(output, { recursive: true, mode: 0o700 })
  const log = resolve(output, 'commands.log')
  const pg = (tool) => env.PG_BIN_DIR ? resolve(env.PG_BIN_DIR, process.platform === 'win32' ? `${tool}.exe` : tool) : tool
  const run = (command, commandArgs, { file, input, childEnv = env } = {}) => new Promise((resolveRun, reject) => {
    const errFd = openSync(log, 'a', 0o600)
    const outFd = file ? openSync(file, 'wx', 0o600) : null
    const child = spawn(command, commandArgs, { env: childEnv, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', outFd ?? 'pipe', errFd] })
    let stdout = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stdin?.on('error', () => {})
    if (input) child.stdin.end(input)
    child.on('error', reject)
    child.on('close', (code) => {
      closeSync(errFd)
      if (outFd !== null) closeSync(outFd)
      if (code === 0) resolveRun(stdout.trim())
      else reject(new Error(`Falló ${command} (código ${code}); diagnóstico privado: ${log}`))
    })
  })
  const sshArgs = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15']
  if (env.VPS_SSH_KEY) sshArgs.push('-o', 'IdentitiesOnly=yes', '-i', env.VPS_SSH_KEY)
  const source = (tool, toolArgs, options) => {
    const remote = ['docker', 'exec', container, 'sh', '-c', 'export PGPASSWORD="$POSTGRES_PASSWORD" PGOPTIONS="-c default_transaction_read_only=on"; exec "$@"', 'sh', tool,
      '-h', 'localhost', '-U', user, '-d', database, ...toolArgs].map(quoteShell).join(' ')
    return run('ssh', [...sshArgs, sshHost, remote], options)
  }
  const query = (sql) => run(pg('psql'), ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { input: sql, childEnv: pgEnv })

  console.log('Comprobando origen VPS de producción (main) y destino Cloud de staging...')
  const sourceCatalog = JSON.parse(await source('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', catalogSql]))
  if (!sourceCatalog.schemas?.includes('supabase_migrations') || !sourceCatalog.history?.length) throw new Error('Producción no tiene un historial de migraciones válido.')
  const targetCatalog = JSON.parse(await query(catalogSql.replace("(SELECT json_agg(version ORDER BY version) FROM supabase_migrations.schema_migrations)", "'[]'::json")))
  const sourceMajor = Math.floor(sourceCatalog.serverVersion / 10000)
  const targetMajor = Math.floor(targetCatalog.serverVersion / 10000)
  const restoreVersion = await run(pg('pg_restore'), ['--version'])
  const dumpVersion = await run(pg('pg_dump'), ['--version'])
  const psqlVersion = await run(pg('psql'), ['--version'])
  if (targetMajor < sourceMajor) throw new Error('No se admite restaurar en una versión mayor de Postgres inferior al origen.')
  for (const version of [restoreVersion, dumpVersion, psqlVersion]) {
    const major = Number(version.match(/PostgreSQL\) (\d+)/)?.[1])
    if (major !== targetMajor) throw new Error(`Usa psql/pg_dump/pg_restore de Postgres ${targetMajor} (PG_BIN_DIR) para evitar SQL incompatible generado por clientes más recientes.`)
  }

  console.log(`Exportando snapshot consistente de Postgres ${sourceMajor}, incluido supabase_migrations...`)
  const dump = resolve(output, 'production.dump')
  await source('pg_dump', ['--format=custom', '--lock-wait-timeout=10s',
    ...[...appSchemas, ...managedSchemas].flatMap((schema) => ['--schema', schema]),
    ...[...dumpExcludedData].flatMap((table) => ['--exclude-table-data', table]),
  ], { file: dump })
  const toc = await run(pg('pg_restore'), ['--list', dump])
  const afterDump = JSON.parse(await source('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', catalogSql]))
  // Row writes can continue during the snapshot. DDL/migration deploys cannot.
  if (JSON.stringify(afterDump) !== JSON.stringify(sourceCatalog)) throw new Error('El catálogo/historial de producción cambió durante el dump. Reintenta sin desplegar migraciones simultáneamente.')
  const { list, dataTables, skippedManagedDefaultAcls } = selectRestoreEntries(toc, new Set(sourceCatalog.triggers))
  if (skippedManagedDefaultAcls.length) console.log(`Cloud: se omiten ${skippedManagedDefaultAcls.length} defaults del rol supabase_admin; se conservan ACL explícitas y defaults de postgres.`)
  const analyticsList = toc.split(/\r?\n/).filter((line) => {
    const table = line.match(/^\d+; \d+ \d+ TABLE DATA (storage \w+) /)?.[1]?.replace(' ', '.')
    return table && analyticsTables.has(table)
  })
  if (analyticsList.length) {
    const analyticsListFile = resolve(output, 'analytics.list')
    const analyticsSqlFile = resolve(output, 'analytics-check.sql')
    writeFileSync(analyticsListFile, `${analyticsList.join('\n')}\n`, { mode: 0o600 })
    await run(pg('pg_restore'), ['--file=-', '--data-only', '--use-list', analyticsListFile, dump], { file: analyticsSqlFile })
    await assertEmptyAnalyticsSql(analyticsSqlFile)
    console.log('Analytics vacío en el snapshot: se conserva la estructura gestionada de Cloud.')
  }
  checkManagedColumns(sourceCatalog, targetCatalog, dataTables)
  const listFile = resolve(output, 'restore.list')
  writeFileSync(listFile, list, { mode: 0o600 })
  // Do not persist passwords, SSH details, auth contents or environment variables.
  writeFileSync(resolve(output, 'manifest.json'), JSON.stringify({ sourceMajor, targetMajor,
    stagingProjectRef: env.STAGING_PROJECT_REF, schemas: appSchemas, dataTables,
    migrationVersions: sourceCatalog.history, skippedManagedDefaultAcls, createdAt: new Date().toISOString(),
  }, null, 2), { mode: 0o600 })
  if (!replace) {
    console.log(`Dump preparado en ${output}. Staging no se ha modificado.\nPara reemplazarlo: --replace-staging ${env.STAGING_PROJECT_REF}`)
    return
  }

  console.log('Guardando backup de todos los esquemas afectados de staging antes del reemplazo...')
  await run(pg('pg_dump'), ['--format=custom', '--lock-wait-timeout=10s',
    ...[...appSchemas, ...managedSchemas].flatMap((schema) => ['--schema', schema]),
  ], { childEnv: pgEnv, file: resolve(output, 'staging-before.dump') })
  await run(pg('pg_restore'), ['--list', resolve(output, 'staging-before.dump')])
  const restoreFile = resolve(output, 'restore.sql')
  await run(pg('pg_restore'), ['--file=-', '--no-owner', '--use-list', listFile, dump], { file: restoreFile })
  const resetFile = resolve(output, 'reset.sql')
  const verifyFile = resolve(output, 'verify.sql')
  writeFileSync(resetFile, resetSql(), { mode: 0o600 })
  writeFileSync(verifyFile, verificationSql(), { mode: 0o600 })
  console.log('Reemplazando staging en una única transacción; cualquier error provoca rollback...')
  await run(pg('psql'), ['-X', '--single-transaction', '-v', 'ON_ERROR_STOP=1',
    '-f', resetFile, '-f', restoreFile, '-f', verifyFile,
  ], { childEnv: pgEnv, file: resolve(output, 'restore-result.log') })
  console.log(`Staging restaurado. Historial de main: ${sourceCatalog.history.length} migraciones.\nBackups y diagnóstico privado: ${output}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
