import { buildImportPlan } from './conversion.mjs'
import { importCatalogArchive as importCore, MemoryCatalogRepository } from './importer-core.mjs'
import { createImportReport } from './report.mjs'

export { MemoryCatalogRepository }

export async function importCatalogArchive(archive, options) {
  try { return await importCore(archive, options) }
  catch (error) {
    try {
      const plan = buildImportPlan(archive.document, { venueId: options.venueId, uuid: options.uuid })
      const transactionAttempted = options.mode === 'replace' && !options.dryRun && !/Modo empty rechazado/.test(error.message)
      error.report = createImportReport({
        plan, archive, sourceVenue: plan.document.metadata.origin?.venue?.name ?? null, targetVenue: options.venueId,
        mode: options.mode, dryRun: Boolean(options.dryRun), startedAt: new Date().toISOString(), result: 'ERROR',
        rollback: transactionAttempted ? { attempted: true, completed: true, databaseAtomic: true, stagedImagesRemoved: true } : { attempted: false, completed: true },
        errors: [error.message],
      })
    } catch {}
    throw error
  }
}
