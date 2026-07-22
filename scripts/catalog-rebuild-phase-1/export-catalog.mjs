#!/usr/bin/env node
/** TEMPORARY PHASE-1 READ-ONLY EXPORT COMMAND. */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { buildCatalogExport, formatValidation, renderConversionReport, stableJson, validateCatalogExport } from './catalog-tools.mjs'
import { connectionFrom, loadEnvironment, parseArguments } from './cli-support.mjs'
import { loadCurrentCatalogSnapshot } from './database-reader.mjs'

async function main() {
  const args = parseArguments(process.argv.slice(2))
  if (!args.venue || !args.out) throw new Error('Uso: node scripts/catalog-rebuild-phase-1/export-catalog.mjs --venue <uuid> --out <catalog.json> [--report <report.md>] [--env-file .env.local]')
  const connection = connectionFrom(args, await loadEnvironment(args['env-file']))
  const snapshot = await loadCurrentCatalogSnapshot({ ...connection, venueId: args.venue })
  const document = buildCatalogExport(snapshot)
  if (snapshot.sourceOnly?.productVenueSettings?.length) document.metadata.sourceOnly = snapshot.sourceOnly
  const outputPath = resolve(args.out)
  const reportPath = resolve(args.report ?? `${outputPath}.conversion.md`)
  await Promise.all([mkdir(dirname(outputPath), { recursive: true }), mkdir(dirname(reportPath), { recursive: true })])
  await Promise.all([writeFile(outputPath, stableJson(document), 'utf8'), writeFile(reportPath, renderConversionReport(document), 'utf8')])
  const validation = validateCatalogExport(document)
  process.stdout.write(`Exportado ${document.metadata.origin.venue.name}\nJSON: ${outputPath}\nInforme: ${reportPath}\n${formatValidation(validation)}`)
  if (!validation.valid) process.exitCode = 2
}

main().catch((error) => {
  process.stderr.write(`ERROR EXPORT_FAILED - ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})

