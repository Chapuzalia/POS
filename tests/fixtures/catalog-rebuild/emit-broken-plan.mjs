import { readCatalogArchive } from '../../../scripts/catalog-rebuild/lib/archive.mjs'
import { buildImportPlan } from '../../../scripts/catalog-rebuild/lib/conversion.mjs'

const venue = '11111111-1111-4111-8111-111111111111'
const archive = readCatalogArchive('backups/mess-catalog.zip')
const plan = buildImportPlan(archive.document, { venueId: venue })
plan.document.catalog.variants[0].productRef = 'product_missing'
plan.imagePaths = {}
const encoded = Buffer.from(JSON.stringify(plan), 'utf8').toString('base64')
process.stdout.write(`begin;\nselect set_config('request.jwt.claim.role','service_role',true);\nselect public.import_catalog('${venue}'::uuid,'replace',convert_from(decode('${encoded}','base64'),'UTF8')::jsonb);\ncommit;\n`)
