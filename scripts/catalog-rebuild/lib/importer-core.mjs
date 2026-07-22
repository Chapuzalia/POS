import { buildImportPlan } from './conversion.mjs'
import { createImportReport } from './report.mjs'

const now = () => performance.now()
const phase = async (phases, name, action) => { const started = now(); try { return await action() } finally { phases[name] = Math.round((now() - started) * 100) / 100 } }

export async function importCatalogArchive(archive, { repository, venueId, mode, dryRun = false, uuid, clock = () => new Date().toISOString() }) {
  if (!['empty', 'replace'].includes(mode)) throw new Error(`Modo no permitido: ${mode}. Use empty o replace.`)
  const phases = {}; const startedAt = clock()
  const plan = await phase(phases, 'plan', async () => buildImportPlan(archive.document, { venueId, uuid }))
  const existing = await phase(phases, 'preflight', async () => repository.countCatalog(venueId))
  if (mode === 'empty' && existing > 0) throw new Error(`Modo empty rechazado: el local contiene ${existing} registros de catálogo.`)
  if (!dryRun) await phase(phases, 'transaction', async () => repository.importCatalog(plan, { mode }))
  return createImportReport({
    plan, archive, sourceVenue: plan.document.metadata.origin?.venue?.name ?? null, targetVenue: venueId,
    mode, dryRun, startedAt, phases, result: dryRun ? 'DRY_RUN' : 'SUCCESS', rollback: null,
  })
}

export class MemoryCatalogRepository {
  constructor(initial = {}) { this.state = structuredClone({ venues: {}, tickets: [], orders: [], cash: [], users: [], ...initial }); this.writes = 0; this.failAfterDelete = false }
  async countCatalog(venueId) { return Object.values(this.state.venues[venueId] ?? {}).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0) }
  async importCatalog(plan, { mode }) {
    const before = structuredClone(this.state)
    try {
      if (mode === 'replace') this.state.venues[plan.venueId] = {}
      if (this.failAfterDelete) throw new Error('Fallo inyectado después del borrado')
      const target = {}
      for (const [name, rows] of Object.entries(plan.document.catalog)) {
        target[name] = rows.map((row) => ({ ...structuredClone(row), id: plan.generatedIds[name][row.ref], venueId: plan.venueId }))
      }
      this.state.venues[plan.venueId] = target
      this.writes += 1
    } catch (error) { this.state = before; throw error }
  }
  snapshot() { return structuredClone(this.state) }
}
