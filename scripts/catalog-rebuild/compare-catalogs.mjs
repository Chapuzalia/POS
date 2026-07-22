#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js'
import { args, loadEnv, readJson, required } from './lib/cli.mjs'
import { compareCatalogs } from './lib/comparator.mjs'
import { stableJson } from './lib/conversion.mjs'

async function main() {
  const options = args(); const source = readJson(required(options.source, 'source')); let target
  if (options.target) target = readJson(options.target)
  else {
    const venue = required(options.venue, 'venue'); const env = loadEnv(); const client = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data, error } = await client.rpc('export_catalog', { p_venue_id: venue })
    if (error) throw new Error(error.message); target = data
  }
  const comparison = compareCatalogs(source, target); process.stdout.write(`${comparison.status}\n${stableJson(comparison)}`)
  if (['DIFFERENCE', 'ERROR'].includes(comparison.status)) process.exitCode = 2
}

main().catch((error) => { console.error(`ERROR\n${error.message}`); process.exitCode = 1 })
