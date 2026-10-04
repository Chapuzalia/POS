#!/usr/bin/env node

import { cp, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const LEGACY_PIPELINE_MIGRATION = '20260912222539_paginate_pos_session_tickets.sql'
export const SALE_LATENCY_PIPELINE_MIGRATION = '20261003183458_optimize_pos_sale_latency.sql'

function adaptPipelineIndexes(sql, filename, expectedCount) {
  const matches = sql.match(/^create index concurrently\b/gim) ?? []
  if (matches.length !== expectedCount) {
    throw new Error(
      `${filename} must contain exactly ${expectedCount} concurrent indexes; found ${matches.length}.`,
    )
  }

  return sql.replace(/^create index concurrently\b/gim, 'create index')
}

export function adaptLegacyPipelineMigration(sql) {
  return adaptPipelineIndexes(sql, LEGACY_PIPELINE_MIGRATION, 3)
}

export async function prepareProductionMigrations(sourceDirectory, outputDirectory) {
  await cp(sourceDirectory, outputDirectory, {
    recursive: true,
    force: false,
    errorOnExist: true,
  })

  // PostgreSQL treats a leading UTF-8 BOM as SQL, rather than an encoding marker.
  // Normalize only the deployment copy; historical migration sources stay immutable.
  for (const entry of await readdir(outputDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) continue
    const outputPath = join(outputDirectory, entry.name)
    let contents = await readFile(outputPath)
    if (contents[0] === 0xef && contents[1] === 0xbb && contents[2] === 0xbf) {
      contents = contents.subarray(3)
      await writeFile(outputPath, contents)
    }
    if (entry.name === SALE_LATENCY_PIPELINE_MIGRATION) {
      await writeFile(outputPath, adaptPipelineIndexes(contents.toString('utf8'), entry.name, 2), 'utf8')
    }
  }

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
    console.log(`Prepared production migrations with CLI pipeline index compatibility for ${basename(migrationPath)} and ${SALE_LATENCY_PIPELINE_MIGRATION}.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
