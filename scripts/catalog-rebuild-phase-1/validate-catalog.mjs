#!/usr/bin/env node
/** TEMPORARY PHASE-1 VALIDATION COMMAND. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { formatValidation, renderConversionReport, validateCatalogExport } from './catalog-tools.mjs'
import { parseArguments } from './cli-support.mjs'

async function main() {
  const args = parseArguments(process.argv.slice(2))
  if (!args.file) throw new Error('Uso: node scripts/catalog-rebuild-phase-1/validate-catalog.mjs --file <catalog.json> [--report <report.md>]')
  const document = JSON.parse(await readFile(resolve(args.file), 'utf8'))
  const validation = validateCatalogExport(document)
  if (args.report) await writeFile(resolve(args.report), renderConversionReport(document), 'utf8')
  process.stdout.write(formatValidation(validation))
  if (!validation.valid) process.exitCode = 2
}

main().catch((error) => {
  process.stderr.write(`ERROR VALIDATION_FAILED - ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
