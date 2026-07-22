#!/usr/bin/env node
import { readCatalogArchive } from './lib/archive.mjs'
import { args, required } from './lib/cli.mjs'
import { buildImportPlan } from './lib/conversion.mjs'

try {
  const options = args(); const venue = required(options.venue, 'venue'); const mode = required(options.mode, 'mode')
  if (!['empty', 'replace'].includes(mode)) throw new Error('El modo debe ser empty o replace')
  const archive = readCatalogArchive(required(options.file, 'file')); const plan = buildImportPlan(archive.document, { venueId: venue })
  plan.imagePaths = Object.fromEntries(plan.document.catalog.images.filter((item) => !item.missing).map((item) => [item.ref, `${venue}/products/${plan.generatedIds.images[item.ref]}.${item.file.split('.').pop()}`]))
  const encoded = Buffer.from(JSON.stringify(plan), 'utf8').toString('base64')
  process.stdout.write(`begin;\nselect set_config('request.jwt.claim.role','service_role',true);\nselect public.import_catalog('${venue}'::uuid,'${mode}',convert_from(decode('${encoded}','base64'),'UTF8')::jsonb);\ncommit;\n`)
} catch (error) { console.error(error.message); process.exitCode = 1 }
