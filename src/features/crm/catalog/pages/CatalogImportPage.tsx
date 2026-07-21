import { Download, Upload } from 'lucide-react'
import { EmptyList } from '../../shared/components/EmptyList'
import { KpiCard, MiniMetric } from '../../dashboard/pages/DashboardPage'
import { formatMoney } from '../../../../lib/format'
import { getReadableError } from '../../../../utils/errors'
import { getSaleFormatLabel } from '../../../../lib/catalog'
import { type CatalogBackupImportResult, type CatalogImportResult, importCatalogBackup, importRevoCatalogProducts } from '../services/catalogImportService'
import { type Category, type Product, type SaleFormatDefinition, type TenantContext } from '../../../../types'
import { type ChangeEvent, useMemo, useState } from 'react'
import { type ParsedCatalogTransfer, exportCatalogZip, parseCatalogZip } from '../../../../lib/catalogTransfer'
import { type RevoImportParseResult, parseRevoItemsCsv } from '../../../../lib/revoImport'
import { type RunAction } from '../../shared/types'

export type RevoImportCrmProps = {
  categories: Category[]
  disabled: boolean
  onCatalogChanged: () => Promise<void>
  products: Product[]
  runAction: RunAction
  saleFormats: SaleFormatDefinition[]
  selectedVenueId: string
  tenantContext: TenantContext
  venueName: string
}

export function CatalogImportCrm({
  categories,
  disabled,
  onCatalogChanged,
  products: catalogProducts,
  runAction,
  saleFormats,
  selectedVenueId,
  tenantContext,
  venueName,
}: RevoImportCrmProps) {
  const [backupFileError, setBackupFileError] = useState<string | null>(null)
  const [backupFileName, setBackupFileName] = useState('')
  const [backupImportResult, setBackupImportResult] = useState<CatalogBackupImportResult | null>(null)
  const [catalogTransfer, setCatalogTransfer] = useState<ParsedCatalogTransfer | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [importResult, setImportResult] = useState<CatalogImportResult | null>(null)
  const [parseResult, setParseResult] = useState<RevoImportParseResult | null>(null)
  const products = useMemo(() => parseResult?.products ?? [], [parseResult])
  const variantCount = products.reduce((total, product) => total + product.variants.length, 0)
  const allWarnings = useMemo(() => {
    const productWarnings = products.flatMap((product) =>
      product.warnings.map((warning) => `${product.name}: ${warning}`),
    )
    return [...(parseResult?.warnings ?? []), ...productWarnings]
  }, [parseResult?.warnings, products])

  async function handleExportCatalog() {
    if (!selectedVenueId) {
      return
    }

    await runAction(async () => {
      await exportCatalogZip({
        categories,
        products: catalogProducts,
        saleFormats,
        tenantName: tenantContext.tenantName,
        venueName: venueName || 'local',
      })
    })
  }

  async function handleBackupFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null
    event.currentTarget.value = ''
    setBackupFileError(null)
    setBackupImportResult(null)

    if (!file) {
      return
    }

    setBackupFileName(file.name)
    try {
      setCatalogTransfer(await parseCatalogZip(file))
    } catch (readError) {
      setCatalogTransfer(null)
      setBackupFileError(getReadableError(readError))
    }
  }

  async function handleBackupImport() {
    if (!catalogTransfer || !selectedVenueId) {
      return
    }

    setBackupImportResult(null)
    await runAction(async () => {
      const nextResult = await importCatalogBackup(tenantContext, catalogTransfer, selectedVenueId)
      setBackupImportResult(nextResult)
      await onCatalogChanged()
    })
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null
    event.currentTarget.value = ''
    setFileError(null)
    setImportResult(null)

    if (!file) {
      return
    }

    try {
      const text = await file.text()
      const nextResult = parseRevoItemsCsv(text)
      setFileName(file.name)
      setParseResult(nextResult)

      if (!nextResult.products.length) {
        setFileError('No se han encontrado productos importables en el CSV.')
      }
    } catch (readError) {
      setFileName(file.name)
      setParseResult(null)
      setFileError(getReadableError(readError))
    }
  }

  async function handleImport() {
    if (!parseResult?.products.length || !selectedVenueId) {
      return
    }

    setImportResult(null)
    await runAction(async () => {
      const nextResult = await importRevoCatalogProducts(tenantContext, parseResult.products, selectedVenueId)
      setImportResult(nextResult)
      await onCatalogChanged()
    })
  }

  return (
    <div className="crm-dashboard-grid !grid !grid-cols-1 !items-start !gap-4 xl:!grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)] xl:!gap-6">
      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-panel-span !col-span-full">
        <div className="crm-list-toolbar !flex !flex-col !items-stretch !justify-between !gap-[18px] !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 md:!flex-row md:!items-center md:!px-[22px]">
          <div className="crm-list-title">
            <h2>Copia completa del catalogo</h2>
            <p>
              Exporta productos, categorias, formatos, precios, modificadores e imagenes a un ZIP, o importa uno en el local seleccionado.
            </p>
          </div>
          <div className="crm-toolbar-actions !flex !min-w-0 !flex-col !items-stretch !justify-end !gap-[9px] md:!flex-row md:!items-center">
            <button
              className="crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
              disabled={disabled || !selectedVenueId}
              onClick={() => void handleExportCatalog()}
              type="button"
            >
              <Download className="h-4 w-4" />
              Exportar ZIP
            </button>
            <label
              className={
                disabled
                  ? 'crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 crm-file-button crm-file-button-disabled'
                  : 'crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 crm-file-button'
              }
            >
              <Upload className="h-4 w-4" />
              Seleccionar ZIP
              <input accept=".zip,application/zip" disabled={disabled} onChange={handleBackupFileChange} type="file" />
            </label>
            <button
              className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
              disabled={disabled || !catalogTransfer || !selectedVenueId}
              onClick={() => void handleBackupImport()}
              type="button"
            >
              <Upload className="h-4 w-4" />
              Importar ZIP
            </button>
          </div>
        </div>

        <div className="crm-kpi-strip !grid !grid-cols-1 !gap-3 !px-[18px] !pt-3 !pb-[18px] md:!grid-cols-2 md:!px-[22px] md:!pt-3.5 md:!pb-[22px] lg:!grid-cols-4 lg:!gap-[18px]">
          <KpiCard color="green" label="Productos del local" value={catalogProducts.length} />
          <KpiCard color="blue" label="Categorias" value={categories.length} />
          <KpiCard color="neutral" label="Formatos de venta" value={saleFormats.length} />
          <KpiCard color="neutral" label="Imagenes" value={catalogProducts.filter((product) => product.imageUrl).length} />
        </div>
      </section>

      {backupFileError ? <div className="crm-import-alert crm-import-alert-warning">{backupFileError}</div> : null}

      {catalogTransfer ? (
        <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-panel-span !col-span-full">
          <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
            <span>ZIP preparado: {backupFileName}</span>
          </div>
          <div className="crm-import-result-grid !grid !grid-cols-1 !gap-3 !px-[22px] !pt-3.5 !pb-[22px] md:!grid-cols-3">
            <MiniMetric label="Origen" value={catalogTransfer.manifest.source.venueName} />
            <MiniMetric label="Productos" value={String(catalogTransfer.manifest.products.length)} />
            <MiniMetric label="Categorias" value={String(catalogTransfer.manifest.categories.length)} />
            <MiniMetric label="Formatos de venta" value={String(catalogTransfer.manifest.saleFormats.length)} />
            <MiniMetric label="Variantes" value={String(catalogTransfer.manifest.products.reduce((sum, product) => sum + product.variants.length, 0))} />
            <MiniMetric label="Imagenes" value={String(catalogTransfer.images.size)} />
          </div>
        </section>
      ) : null}

      {backupImportResult ? (
        <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-panel-span !col-span-full">
          <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
            <span>Resultado de la importacion ZIP</span>
          </div>
          <div className="crm-import-result-grid !grid !grid-cols-1 !gap-3 !px-[22px] !pt-3.5 !pb-[22px] md:!grid-cols-3">
            <MiniMetric label="Categorias creadas / actualizadas" value={`${backupImportResult.categoriesCreated} / ${backupImportResult.categoriesUpdated}`} />
            <MiniMetric label="Formatos creados / actualizados" value={`${backupImportResult.saleFormatsCreated} / ${backupImportResult.saleFormatsUpdated}`} />
            <MiniMetric label="Productos creados / actualizados" value={`${backupImportResult.productsCreated} / ${backupImportResult.productsUpdated}`} />
            <MiniMetric label="Variantes creadas / actualizadas" value={`${backupImportResult.variantsCreated} / ${backupImportResult.variantsUpdated}`} />
            <MiniMetric label="Modificadores creados / actualizados" value={`${backupImportResult.modifiersCreated} / ${backupImportResult.modifiersUpdated}`} />
            <MiniMetric label="Imagenes cargadas" value={String(backupImportResult.imagesUploaded)} />
          </div>
        </section>
      ) : null}

      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-panel-span !col-span-full">
        <div className="crm-list-toolbar !flex !flex-col !items-stretch !justify-between !gap-[18px] !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 md:!flex-row md:!items-center md:!px-[22px]">
          <div className="crm-list-title">
            <h2>Importar articulos REVO</h2>
            <p>
              {fileName
                ? `${fileName} - ${products.length} productos y ${variantCount} formatos detectados`
                : 'Selecciona el CSV de articulos exportado desde REVO.'}
            </p>
          </div>
          <div className="crm-toolbar-actions !flex !min-w-0 !flex-col !items-stretch !justify-end !gap-[9px] md:!flex-row md:!items-center">
            <label
              className={
                disabled
                  ? 'crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 crm-file-button crm-file-button-disabled'
                  : 'crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 crm-file-button'
              }
            >
              <Upload className="h-4 w-4" />
              Seleccionar CSV
              <input accept=".csv,text/csv" disabled={disabled} onChange={handleFileChange} type="file" />
            </label>
            <button
              className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
              disabled={disabled || !parseResult?.products.length || !selectedVenueId}
              onClick={() => void handleImport()}
              type="button"
            >
              <Upload className="h-4 w-4" />
              Importar
            </button>
          </div>
        </div>

        <div className="crm-kpi-strip !grid !grid-cols-1 !gap-3 !px-[18px] !pt-3 !pb-[18px] md:!grid-cols-2 md:!px-[22px] md:!pt-3.5 md:!pb-[22px] lg:!grid-cols-4 lg:!gap-[18px]">
          <KpiCard color="blue" label="Productos" value={products.length} />
          <KpiCard color="green" label="Formatos" value={variantCount} />
          <KpiCard color="neutral" label="Avisos" value={allWarnings.length} />
          <KpiCard color="neutral" label="Filas omitidas" value={parseResult?.skippedRows ?? 0} />
        </div>
      </section>

      {fileError ? <div className="crm-import-alert crm-import-alert-warning">{fileError}</div> : null}

      {allWarnings.length ? (
        <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-panel-span !col-span-full">
          <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
            <span>Avisos de interpretacion</span>
          </div>
          <ul className="crm-import-warning-list">
            {allWarnings.slice(0, 8).map((warning, index) => (
              <li key={`${index}:${warning}`}>{warning}</li>
            ))}
            {allWarnings.length > 8 ? <li>{allWarnings.length - 8} avisos mas en el CSV.</li> : null}
          </ul>
        </section>
      ) : null}

      {importResult ? (
        <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-panel-span !col-span-full">
          <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
            <span>Resultado de importacion</span>
          </div>
          <div className="crm-import-result-grid !grid !grid-cols-1 !gap-3 !px-[22px] !pt-3.5 !pb-[22px] md:!grid-cols-3">
            <MiniMetric label="Categorias creadas" value={String(importResult.categoriesCreated)} />
            <MiniMetric label="Categorias actualizadas" value={String(importResult.categoriesUpdated)} />
            <MiniMetric label="Productos creados" value={String(importResult.productsCreated)} />
            <MiniMetric label="Productos actualizados" value={String(importResult.productsUpdated)} />
            <MiniMetric label="Formatos creados" value={String(importResult.variantsCreated)} />
            <MiniMetric label="Formatos actualizados" value={String(importResult.variantsUpdated)} />
          </div>
        </section>
      ) : null}

      {parseResult ? (
        <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-panel-span !col-span-full">
          <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
            <span>Previsualizacion</span>
          </div>
          <div className="crm-data-table !grid !overflow-auto crm-import-table">
            <div className="crm-data-head !sticky !top-0 !z-[1] !grid !min-h-[50px] !min-w-[920px] !items-center !gap-3.5 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !px-[22px] !text-[11px] !font-semibold !uppercase !tracking-[0.045em] !text-[var(--crm-text-muted)]">
              <span>Producto</span>
              <span>Categoria destino</span>
              <span>Formatos</span>
              <span>Precio</span>
              <span>Estado</span>
              <span>Avisos</span>
            </div>
            {products.map((product) => (
              <div className="crm-data-row !grid !min-h-[72px] !min-w-[920px] !items-center !gap-3.5 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[22px] !text-[13px] !font-medium !text-[var(--crm-text-secondary)] !transition-colors !duration-150 hover:!bg-[var(--crm-surface-hover)]" key={`${product.categoryName}:${product.name}`}>
                <div className="crm-cell-main">
                  <strong>{product.name}</strong>
                  <span>{product.sourceCategories.join(', ') || 'REVO'}</span>
                </div>
                <span>{product.categoryName}</span>
                <div className="crm-format-list">
                  {product.saleFormats.map((format) => (
                    <span key={format}>{getSaleFormatLabel(format)}</span>
                  ))}
                </div>
                <div className="crm-price-list">
                  {product.variants.map((variant) => (
                    <span key={variant.name}>
                      {variant.name}: {formatMoney(variant.priceCents)}
                    </span>
                  ))}
                </div>
                <span className={product.active ? 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-active !bg-[var(--crm-green-soft)] !text-[var(--crm-green)]' : 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-muted !bg-[var(--crm-surface-soft)] !text-[var(--crm-text-secondary)]'}>
                  {product.active ? 'Activo' : 'Oculto'}
                </span>
                <span className="crm-import-warning-cell">
                  {product.warnings.length ? product.warnings.join(' ') : 'Sin avisos'}
                </span>
              </div>
            ))}
            {!products.length ? <EmptyList message="Carga un CSV de REVO para ver la previsualizacion." /> : null}
          </div>
        </section>
      ) : null}
    </div>
  )
}
