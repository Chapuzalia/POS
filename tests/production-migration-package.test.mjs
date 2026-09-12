import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  adaptLegacyPipelineMigration,
  LEGACY_PIPELINE_MIGRATION,
} from '../scripts/prepare-production-migrations.mjs'

const migration = await readFile(
  new URL(`../supabase/migrations/${LEGACY_PIPELINE_MIGRATION}`, import.meta.url),
  'utf8',
)

test('conserva inmutable la migración y adapta solo sus tres índices en el paquete de producción', () => {
  assert.equal(migration.match(/create index concurrently/gi)?.length, 3)

  const preparedMigration = adaptLegacyPipelineMigration(migration)

  assert.doesNotMatch(preparedMigration, /create index concurrently/i)
  assert.equal(preparedMigration.match(/create index if not exists/gi)?.length, 3)
  assert.equal(
    preparedMigration.replaceAll('create index', 'create index concurrently'),
    migration,
  )
})

test('rechaza adaptar una versión inesperada de la migración histórica', () => {
  assert.throws(
    () => adaptLegacyPipelineMigration(migration.replace('create index concurrently', 'create index')),
    /must contain exactly 3 concurrent indexes; found 2/,
  )
})
