#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { buildCatalogExport } from '../catalog-rebuild-phase-1/catalog-tools.mjs'
import { loadCurrentCatalogSnapshot } from '../catalog-rebuild-phase-1/database-reader.mjs'
import { createCatalogArchive, readCatalogArchive } from './lib/archive.mjs'
import { args, loadEnv, readJson, required } from './lib/cli.mjs'
import { upgradeDraftExport } from './lib/conversion.mjs'
import { importCatalogArchive } from './lib/importer.mjs'
import { renderImportReport } from './lib/report.mjs'
import { SupabaseCatalogRepository } from './lib/supabase-repository.mjs'

async function main() {
  const options = args(); const targetVenue = required(options.venue, 'venue'); const mode = required(options.mode, 'mode'); const env = loadEnv()
  let draft
  if (options.source) draft = readJson(options.source)
  else {
    const sourceVenue = required(options.sourceVenue, 'source-venue')
    const snapshot = await loadCurrentCatalogSnapshot({ url: env.VITE_SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, venueId: sourceVenue })
    draft = buildCatalogExport(snapshot)
  }
  const document = upgradeDraftExport(draft)
  const storage = createClient(env.VITE_SUPABASE_URL.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, ''), env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const built = await createCatalogArchive(document, {
    conversionReport: '# Migración directa\n',
    loadImage: async (entry) => {
      const { data, error } = await storage.storage.from(entry.source.storageBucket).download(entry.source.path)
      if (error) throw new Error(error.message)
      return { bytes: new Uint8Array(await data.arrayBuffer()), mimeType: data.type }
    },
  })
  const archive = readCatalogArchive(built.bytes)
  const repository = new SupabaseCatalogRepository({ url: env.VITE_SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, archive })
  const report = await importCatalogArchive(archive, { repository, venueId: targetVenue, mode, dryRun: Boolean(options.dryRun) })
  process.stdout.write(renderImportReport(report))
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })
