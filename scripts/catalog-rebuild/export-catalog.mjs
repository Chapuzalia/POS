#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { createCatalogArchive, writeCatalogArchive } from './lib/archive.mjs'
import { args, loadEnv, readJson, required } from './lib/cli.mjs'
import { stableJson, upgradeDraftExport } from './lib/conversion.mjs'
import { formatValidation, validateCatalog } from './lib/contract.mjs'

async function main() {
  const options = args(); const sourceFile = required(options.source, 'source'); const outputFile = resolve(required(options.out, 'out'))
  const document = upgradeDraftExport(readJson(sourceFile))
  const validation = validateCatalog(document)
  if (!validation.valid) throw new Error(formatValidation(validation))
  const env = loadEnv(); const url = env.VITE_SUPABASE_URL; const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.VITE_SUPABASE_ANON_KEY
  const client = url && key ? createClient(url.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, ''), key, { auth: { persistSession: false, autoRefreshToken: false } }) : null
  const conversionReport = options.report ? readFileSync(resolve(options.report), 'utf8') : `# Informe de conversión\n\n${formatValidation(validation)}\n`
  const archive = await createCatalogArchive(document, {
    conversionReport,
    loadImage: async (entry) => {
      if (!client) throw new Error('No hay credenciales de Supabase para descargar imágenes')
      const { data, error } = await client.storage.from(entry.source.storageBucket).download(entry.source.path)
      if (error) throw new Error(error.message)
      return { bytes: new Uint8Array(await data.arrayBuffer()), mimeType: data.type }
    },
  })
  writeCatalogArchive(outputFile, archive)
  process.stdout.write(stableJson({ output: outputFile, schemaVersion: archive.document.schemaVersion, counts: archive.document.metadata.counts, images: { copied: archive.manifest.images.filter((item) => !item.missing).length, missing: archive.manifest.images.filter((item) => item.missing).length, uniqueFiles: new Set(archive.manifest.images.map((item) => item.file).filter(Boolean)).size }, warnings: archive.warnings }))
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })
