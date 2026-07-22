#!/usr/bin/env node
import { args, readJson, required } from './lib/cli.mjs'
import { upgradeDraftExport } from './lib/conversion.mjs'
import { formatValidation, validateCatalog } from './lib/contract.mjs'

try {
  const options = args(); const validation = validateCatalog(upgradeDraftExport(readJson(required(options.file, 'file'))))
  process.stdout.write(formatValidation(validation)); if (!validation.valid) process.exitCode = 2
} catch (error) { console.error(error.message); process.exitCode = 1 }
