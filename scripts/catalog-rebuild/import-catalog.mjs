#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { readCatalogArchive } from './lib/archive.mjs'
import { args, loadEnv, required } from './lib/cli.mjs'
import { importCatalogArchive } from './lib/importer.mjs'
import { reportFiles } from './lib/report.mjs'
import { SupabaseCatalogRepository } from './lib/supabase-repository.mjs'

function writeReport(outputBase, report) {
  const files = reportFiles(report)
  writeFileSync(`${outputBase}.json`, files.json); writeFileSync(`${outputBase}.md`, files.markdown)
  return files
}

async function main() {
  const options = args(); const file = resolve(required(options.file, 'file')); const venueId = required(options.venue, 'venue'); const mode = required(options.mode, 'mode')
  const outputBase = resolve(options.report ?? `${file.slice(0, -extname(file).length)}-import-report`)
  try {
    const archive = readCatalogArchive(file); const env = loadEnv()
    const repository = new SupabaseCatalogRepository({ url: env.VITE_SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, archive })
    const report = await importCatalogArchive(archive, { repository, venueId, mode, dryRun: Boolean(options.dryRun) })
    process.stdout.write(writeReport(outputBase, report).markdown)
  } catch (error) {
    if (error.report) writeReport(outputBase, error.report)
    throw error
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })
