#!/usr/bin/env node

import { cp, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const LEGACY_PIPELINE_MIGRATION = '20260912222539_paginate_pos_session_tickets.sql'
const EXPECTED_CONCURRENT_INDEXES = 3

export function adaptLegacyPipelineMigration(sql) {
  const matches = sql.match(/create index concurrently/gi) ?? []
  if (matches.length !== EXPECTED_CONCURRENT_INDEXES) {
    throw new Error(
      `${LEGACY_PIPELINE_MIGRATION} must contain exactly ${EXPECTED_CONCURRENT_INDEXES} concurrent indexes; found ${matches.length}.`,
    )
  }

  return sql.replaceAll('create index concurrently', 'create index')
}

export async function prepareProductionMigrations(sourceDirectory, outputDirectory) {
  await cp(sourceDirectory, outputDirectory, {
    recursive: true,
    force: false,
    errorOnExist: true,
  })

  const migrationPath = join(outputDirectory, LEGACY_PIPELINE_MIGRATION)
  const migration = await readFile(migrationPath, 'utf8')
  await writeFile(migrationPath, adaptLegacyPipelineMigration(migration), 'utf8')

  return migrationPath
}

async function main() {
  const [sourceDirectory, outputDirectory] = process.argv.slice(2)
  if (!sourceDirectory || !outputDirectory || process.argv.length !== 4) {
    console.error('Usage: node scripts/prepare-production-migrations.mjs <source-directory> <output-directory>')
    process.exitCode = 2
    return
  }

  try {
    const migrationPath = await prepareProductionMigrations(sourceDirectory, outputDirectory)
    console.log(`Prepared production migrations with legacy CLI compatibility for ${basename(migrationPath)}.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
