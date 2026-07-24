import { AlertTriangle, Download, FileJson, Upload, X } from 'lucide-react'
import { useMemo, useState, type ChangeEvent } from 'react'
import type { CatalogData } from '../../../catalog/domain/types.ts'
import { parseRevoItemsCsv, type RevoImportParseResult } from '../../../../lib/revoImport.ts'
import { getReadableError } from '../../../../utils/errors.ts'
import { CrmModal } from '../../shared/components/CrmModal.tsx'
import { ProgressBar } from '../../shared/components/ProgressBar.tsx'
import {
  getCatalogImportSummary,
  parseCatalogExportJson,
  type CatalogExportDocument,
  type CatalogImportSummary,
} from '../services/catalogTransferDocument.ts'
import {
  exportFinalCatalog,
  importOwnCatalog,
  importRevoIntoFinalCatalog,
  type CatalogImportProgress,
  type FinalCatalogImportResult,
} from '../services/catalogTransferService.ts'

type Props = {
  catalog: CatalogData
  disabled: boolean
  mutate: (action: () => Promise<unknown>) => Promise<boolean>
  venueName: string
}

const MAX_CATALOG_FILE_BYTES = 100 * 1024 * 1024

function Summary({ value }: { value: CatalogImportSummary }) {
  return <p className="!mt-3 !text-sm !text-[var(--crm-text-muted)]">
    {value.products} productos · {value.variants} variantes · {value.formats} formatos · {value.categories} categorías · {value.images} imágenes
  </p>
}
function ImportProgress({ progress }: { progress: CatalogImportProgress }) {
  return <div aria-live="polite" className="!mt-4 !rounded-xl !border !border-[var(--crm-border)] !bg-[var(--crm-surface-soft)]/45 !p-3">
    <div className="!mb-2 !flex !items-center !justify-between !gap-3">
      <span className="!text-sm !font-medium !text-[var(--crm-text)]">{progress.label}</span>
      <span className="!sr-only">{progress.value}%</span>
    </div>
    <ProgressBar aria-label={progress.label} labelPosition="right" value={progress.value} />
  </div>
}

export function CatalogTransferCrm({ catalog, disabled, mutate, venueName }: Props) {
  const [ownFileName, setOwnFileName] = useState('')
  const [ownDocument, setOwnDocument] = useState<CatalogExportDocument | null>(null)
  const [ownError, setOwnError] = useState<string | null>(null)
  const [ownResult, setOwnResult] = useState<CatalogImportSummary | null>(null)
  const [isConfirmingImport, setIsConfirmingImport] = useState(false)
  const [isOwnImporting, setIsOwnImporting] = useState(false)
  const [ownProgress, setOwnProgress] = useState<CatalogImportProgress | null>(null)

  const [revoFileName, setRevoFileName] = useState('')
  const [revoParseResult, setRevoParseResult] = useState<RevoImportParseResult | null>(null)
  const [revoError, setRevoError] = useState<string | null>(null)
  const [revoResult, setRevoResult] = useState<FinalCatalogImportResult | null>(null)
  const [isRevoImporting, setIsRevoImporting] = useState(false)
  const [revoProgress, setRevoProgress] = useState<CatalogImportProgress | null>(null)

  const ownSummary = useMemo(() => ownDocument ? getCatalogImportSummary(ownDocument) : null, [ownDocument])
  const warningCount = useMemo(
    () => (revoParseResult?.warnings.length ?? 0) + (revoParseResult?.products.reduce((total, product) => total + product.warnings.length, 0) ?? 0),
    [revoParseResult],
  )

  async function readOwnCatalog(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    setOwnFileName(file.name)
    setOwnDocument(null)
    setOwnResult(null)
    setOwnProgress(null)
    setOwnError(null)
    try {
      if (file.size > MAX_CATALOG_FILE_BYTES) throw new Error('El catálogo supera el máximo de 100 MB.')
      setOwnDocument(parseCatalogExportJson(await file.text()))
    } catch (readError) {
      setOwnError(getReadableError(readError))
    }
  }

  async function readRevoFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    setRevoFileName(file.name)
    setRevoResult(null)
    setRevoProgress(null)
    try {
      const parsed = parseRevoItemsCsv(await file.text())
      setRevoParseResult(parsed)
      setRevoError(parsed.products.length ? null : 'No se encontraron productos importables.')
    } catch (readError) {
      setRevoParseResult(null)
      setRevoError(getReadableError(readError))
    }
  }

  async function confirmOwnImport() {
    if (!ownDocument) return
    setIsOwnImporting(true)
    setOwnProgress({ label: 'Preparando importación', value: 2 })
    const imported = await mutate(async () => {
      const next = await importOwnCatalog(catalog, ownDocument, setOwnProgress)
      setOwnResult(next)
    })
    setIsOwnImporting(false)
    if (imported) {
      setIsConfirmingImport(false)
      return
    }
    setOwnProgress(null)
  }

  async function importRevoCatalog() {
    if (!revoParseResult?.products.length) return
    setIsRevoImporting(true)
    setRevoProgress({ label: 'Preparando importación REVO', value: 2 })
    const imported = await mutate(async () => {
      const next = await importRevoIntoFinalCatalog(catalog, revoParseResult.products, setRevoProgress)
      setRevoResult(next)
    })
    setIsRevoImporting(false)
    if (!imported) setRevoProgress(null)
  }

  return <>
    <div className="!grid !gap-4 xl:!grid-cols-2">
      <section className="crm-panel !rounded-2xl !bg-[var(--crm-surface)] !p-5 !shadow-[var(--crm-shadow-card)]">
        <div className="!flex !items-start !gap-3">
          <Download className="!mt-0.5 !size-5 !shrink-0 !text-[var(--crm-green)]" />
          <div>
            <h2 className="!text-lg !font-bold">Exportar catálogo completo</h2>
            <p className="!mt-1 !text-sm !text-[var(--crm-text-muted)]">Descarga productos, formatos, variantes, pestañas, categorías, grupos, modificadores e imágenes en un único JSON portable.</p>
          </div>
        </div>
        <button className="crm-primary-button !mt-4" disabled={disabled} onClick={() => void mutate(() => exportFinalCatalog(catalog.venueId, venueName))} type="button">
          <Download className="!size-4" /> Exportar JSON
        </button>
      </section>

      <section className="crm-panel !rounded-2xl !bg-[var(--crm-surface)] !p-5 !shadow-[var(--crm-shadow-card)]">
        <div className="!flex !items-start !gap-3">
          <FileJson className="!mt-0.5 !size-5 !shrink-0 !text-[var(--crm-green)]" />
          <div>
            <h2 className="!text-lg !font-bold">Importar catálogo de la app</h2>
            <p className="!mt-1 !text-sm !text-[var(--crm-text-muted)]">Restaura en este local un JSON generado mediante «Exportar catálogo completo».</p>
          </div>
        </div>
        <label className="crm-secondary-button !mt-4 !inline-flex !cursor-pointer">
          <FileJson className="!size-4" /> Seleccionar JSON
          <input accept=".json,application/json" className="!sr-only" disabled={disabled} onChange={readOwnCatalog} type="file" />
        </label>
        {ownFileName ? <p className="!mt-3 !text-sm !font-medium">{ownFileName}</p> : null}
        {ownSummary ? <Summary value={ownSummary} /> : null}
        {ownError ? <p className="!mt-3 !text-sm !text-red-500" role="alert">{ownError}</p> : null}
        <button className="crm-primary-button !mt-4" disabled={disabled || !ownDocument} onClick={() => setIsConfirmingImport(true)} type="button">
          <Upload className="!size-4" /> Importar catálogo
        </button>
        {ownResult ? <div className="!mt-3 !rounded-xl !bg-[var(--crm-green-soft)] !p-3 !text-sm !text-[var(--crm-green)]"><strong>Catálogo importado.</strong><Summary value={ownResult} /></div> : null}
      </section>

      <section className="crm-panel !rounded-2xl !bg-[var(--crm-surface)] !p-5 !shadow-[var(--crm-shadow-card)] xl:!col-span-2">
        <h2 className="!text-lg !font-bold">Importar desde REVO</h2>
        <p className="!mt-1 !text-sm !text-[var(--crm-text-muted)]">La importación REVO añade formatos, categorías, variantes, apariciones y relaciones definitivas en un único batch transaccional.</p>
        <label className="crm-secondary-button !mt-4 !inline-flex !cursor-pointer">
          <Upload className="!size-4" /> Seleccionar CSV
          <input accept=".csv,text/csv" className="!sr-only" disabled={disabled} onChange={readRevoFile} type="file" />
        </label>
        {revoFileName ? <p className="!mt-3 !text-sm">{revoFileName} · {revoParseResult?.products.length ?? 0} productos · {warningCount} avisos</p> : null}
        {revoError ? <p className="!mt-3 !text-sm !text-red-500" role="alert">{revoError}</p> : null}
        <button className="crm-primary-button !mt-4" disabled={disabled || isRevoImporting || !revoParseResult?.products.length} onClick={() => void importRevoCatalog()} type="button">
          <Upload className="!size-4" /> {isRevoImporting ? 'Importando…' : 'Importar desde REVO'}
        </button>
        {isRevoImporting && revoProgress ? <ImportProgress progress={revoProgress} /> : null}
        {revoResult ? <p className="!mt-3 !rounded-xl !bg-[var(--crm-green-soft)] !p-3 !text-sm !text-[var(--crm-green)]">{revoResult.products} productos, {revoResult.variants} variantes, {revoResult.formats} formatos, {revoResult.categories} categorías y {revoResult.placements} apariciones creadas.</p> : null}
      </section>
    </div>

    {isConfirmingImport && ownDocument && ownSummary ? <CrmModal label="Confirmar importación de catálogo" onClose={() => { if (!isOwnImporting) setIsConfirmingImport(false) }}>
      <div className="!flex !items-center !justify-between !border-b !border-[var(--crm-border)] !px-5 !py-4">
        <div className="!flex !items-center !gap-3">
          <span className="!grid !size-9 !place-items-center !rounded-full !bg-amber-500/15 !text-amber-500"><AlertTriangle className="!size-5" /></span>
          <div><h2 className="!font-bold">Sustituir catálogo del local</h2><p className="!text-xs !text-[var(--crm-text-muted)]">Esta operación se realiza de forma transaccional.</p></div>
        </div>
        <button aria-label="Cerrar" className="crm-icon-button" disabled={disabled || isOwnImporting} onClick={() => setIsConfirmingImport(false)} type="button"><X className="!size-4" /></button>
      </div>
      <div className="!overflow-y-auto !p-5">
        <p className="!text-sm">El catálogo actual de <strong>{venueName}</strong> será reemplazado por el contenido de <strong>{ownFileName}</strong>.</p>
        <Summary value={ownSummary} />
        <p className="!mt-4 !rounded-xl !bg-amber-500/10 !p-3 !text-sm !text-amber-600 dark:!text-amber-400">No se modifican ventas, tickets ni datos fiscales históricos.</p>
        {isOwnImporting && ownProgress ? <ImportProgress progress={ownProgress} /> : null}
      </div>
      <div className="!flex !justify-end !gap-2 !border-t !border-[var(--crm-border)] !px-5 !py-4">
        <button className="crm-secondary-button" disabled={disabled || isOwnImporting} onClick={() => setIsConfirmingImport(false)} type="button">Cancelar</button>
        <button className="crm-primary-button" disabled={disabled || isOwnImporting} onClick={() => void confirmOwnImport()} type="button"><Upload className="!size-4" /> {isOwnImporting ? 'Importando…' : 'Importar y reemplazar'}</button>
      </div>
    </CrmModal> : null}
  </>
}