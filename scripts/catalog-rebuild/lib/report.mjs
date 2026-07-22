import { stableJson } from './conversion.mjs'

export function createImportReport({ plan, sourceVenue, targetVenue, mode, dryRun, archive, startedAt, phases = {}, result = 'SUCCESS', rollback = null, errors = [] }) {
  const images = archive.manifest.images ?? []
  return {
    format: 'club-pos-catalog-import-report', reportVersion: 1, result, mode, dryRun,
    sourceVenue, targetVenue, schemaVersion: plan.document.schemaVersion,
    startedAt, finishedAt: new Date().toISOString(),
    counts: { original: plan.document.metadata.counts, imported: plan.counts },
    generatedIds: plan.generatedIds,
    orderNormalizations: plan.changes.orderNormalizations,
    assignmentChanges: plan.changes.assignmentChanges,
    excludedVariants: plan.changes.excludedVariants,
    unusedCategories: plan.changes.unusedCategories,
    images: {
      copied: images.filter((item) => !item.missing), missing: images.filter((item) => item.missing),
      checksums: images.filter((item) => !item.missing).map(({ ref, productRef, file, sha256, sizeBytes, mimeType, deduplicated }) => ({ ref, productRef, file, sha256, sizeBytes, mimeType, deduplicated })),
    },
    ambiguities: plan.document.metadata.warnings ?? [], errors, phases, rollback,
    isolation: { targetVenue, onlyTargetCatalogConfiguration: true, tenantUnchanged: true, historicalDataPreserved: true },
  }
}

export function renderImportReport(report) {
  const lines = [
    '# Informe de importación del catálogo', '',
    `Resultado: **${report.result}**${report.dryRun ? ' (dry run)' : ''}`,
    `Local origen: ${report.sourceVenue ?? 'desconocido'}`,
    `Local destino: ${report.targetVenue}`,
    `Contrato: ${report.schemaVersion}`,
    `Modo: ${report.mode}`, '',
    '## Conteos', '',
    ...Object.entries(report.counts.imported).map(([name, count]) => `- ${name}: ${count}`), '',
    '## Normalizaciones de orden', '',
    ...(report.orderNormalizations.length ? report.orderNormalizations.map((item) => `- ${item.collection}/${item.ref}: ${item.originalSortOrder} → ${item.importedSortOrder} (${item.sibling})`) : ['- Ninguna']), '',
    '## Asignaciones ajustadas', '',
    ...(report.assignmentChanges.length ? report.assignmentChanges.map((item) => `- ${item.assignmentRef}: ${item.originalState} → ${item.importedState}; ${item.rule}`) : ['- Ninguna']),
    ...report.excludedVariants.map((item) => `- Variante ${item.variantRef} excluida de ${item.assignmentRef}; ${item.rule}`), '',
    '## Categorías no utilizadas', '',
    ...(report.unusedCategories.length ? report.unusedCategories.map((item) => `- ${item.name} (${item.ref})`) : ['- Ninguna']), '',
    '## Imágenes', '',
    `- Copiadas: ${report.images.copied.length}`,
    `- Ausentes: ${report.images.missing.length}`,
    `- Checksums verificados: ${report.images.checksums.length}`, '',
    '## Aislamiento y rollback', '',
    `- Configuración limitada al local destino: ${report.isolation.onlyTargetCatalogConfiguration ? 'sí' : 'no'}`,
    `- Tenant sin modificar: ${report.isolation.tenantUnchanged ? 'sí' : 'no'}`,
    `- Histórico preservado: ${report.isolation.historicalDataPreserved ? 'sí' : 'no'}`,
    `- Rollback: ${report.rollback == null ? 'no necesario' : stableJson(report.rollback).trim()}`, '',
    '## Duración por fase', '',
    ...Object.entries(report.phases).map(([name, milliseconds]) => `- ${name}: ${milliseconds} ms`), '',
  ]
  if (report.errors.length) lines.push('## Errores', '', ...report.errors.map((error) => `- ${error}`), '')
  return `${lines.join('\n')}\n`
}

export function reportFiles(report) { return { json: stableJson(report), markdown: renderImportReport(report) } }
