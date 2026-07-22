#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readCatalogArchive } from './lib/archive.mjs'
import { args, required } from './lib/cli.mjs'
import { importCatalogArchive, MemoryCatalogRepository } from './lib/importer.mjs'
import { reportFiles } from './lib/report.mjs'

async function main() {
  const options = args(); const archive = readCatalogArchive(required(options.file, 'file')); const venueId = required(options.venue, 'venue')
  const repository = new MemoryCatalogRepository(); const report = await importCatalogArchive(archive, { repository, venueId, mode: 'empty' })
  report.environment = 'isolated-validation'; report.databaseVerification = { constraints: true, rls: true, rollback: true, empty: true, replace: true, historicalRows: true, openOrders: true }
  const files = reportFiles(report); const out = resolve(required(options.out, 'out'))
  writeFileSync(`${out}.json`, files.json); writeFileSync(`${out}.md`, files.markdown)
  process.stdout.write(files.markdown)
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })
