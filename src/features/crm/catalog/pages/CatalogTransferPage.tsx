import { Download, Upload } from 'lucide-react'
import { useMemo, useState, type ChangeEvent } from 'react'
import type { CatalogData } from '../../../catalog/domain/types.ts'
import { parseRevoItemsCsv, type RevoImportParseResult } from '../../../../lib/revoImport.ts'
import { getReadableError } from '../../../../utils/errors.ts'
import { exportFinalCatalog, importRevoIntoFinalCatalog, type FinalCatalogImportResult } from '../services/catalogTransferService.ts'

type Props = {
  catalog: CatalogData
  disabled: boolean
  mutate: (action: () => Promise<unknown>) => Promise<boolean>
  venueName: string
}

export function CatalogTransferCrm({ catalog, disabled, mutate, venueName }: Props) {
  const [fileName, setFileName] = useState('')
  const [parseResult, setParseResult] = useState<RevoImportParseResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<FinalCatalogImportResult | null>(null)
  const warningCount = useMemo(() => (parseResult?.warnings.length ?? 0) + (parseResult?.products.reduce((total, product) => total + product.warnings.length, 0) ?? 0), [parseResult])

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    setFileName(file.name)
    setResult(null)
    try {
      const parsed = parseRevoItemsCsv(await file.text())
      setParseResult(parsed)
      setError(parsed.products.length ? null : 'No se encontraron productos importables.')
    } catch (readError) {
      setParseResult(null)
      setError(getReadableError(readError))
    }
  }

  return <div className="!grid !gap-4 xl:!grid-cols-2">
    <section className="crm-panel !rounded-2xl !bg-[var(--crm-surface)] !p-5 !shadow-[var(--crm-shadow-card)]"><h2 className="!text-lg !font-bold">Exportar catálogo definitivo</h2><p className="!mt-1 !text-sm !text-[var(--crm-text-muted)]">Genera el documento normalizado del local con productos, variantes, pestañas, categorías, grupos, modificadores e imágenes referenciadas por ruta.</p><button className="crm-primary-button !mt-4" disabled={disabled} onClick={() => void mutate(() => exportFinalCatalog(catalog.venueId, venueName))} type="button"><Download className="!size-4" /> Exportar JSON</button></section>
    <section className="crm-panel !rounded-2xl !bg-[var(--crm-surface)] !p-5 !shadow-[var(--crm-shadow-card)]"><h2 className="!text-lg !font-bold">Importar desde REVO</h2><p className="!mt-1 !text-sm !text-[var(--crm-text-muted)]">La importación crea categorías, variantes, apariciones y relaciones definitivas en un único batch transaccional. No escribe formatos ni tablas legacy.</p><label className="crm-secondary-button !mt-4 !inline-flex !cursor-pointer"><Upload className="!size-4" /> Seleccionar CSV<input accept=".csv,text/csv" className="!sr-only" disabled={disabled} onChange={readFile} type="file" /></label>{fileName ? <p className="!mt-3 !text-sm">{fileName} · {parseResult?.products.length ?? 0} productos · {warningCount} avisos</p> : null}{error ? <p className="!mt-3 !text-sm !text-red-500" role="alert">{error}</p> : null}<button className="crm-primary-button !mt-4" disabled={disabled || !parseResult?.products.length} onClick={() => void mutate(async () => { const next = await importRevoIntoFinalCatalog(catalog, parseResult?.products ?? []); setResult(next) })} type="button"><Upload className="!size-4" /> Importar catálogo</button>{result ? <p className="!mt-3 !rounded-xl !bg-[var(--crm-green-soft)] !p-3 !text-sm !text-[var(--crm-green)]">{result.products} productos, {result.variants} variantes, {result.categories} categorías y {result.placements} apariciones creadas.</p> : null}</section>
  </div>
}
