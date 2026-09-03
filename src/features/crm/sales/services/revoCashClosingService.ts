import { supabase } from '../../../../lib/supabase'
import type { ImportedCashClosing, RevoClosingDay } from '../../../../lib/revoCashClosings.ts'
import type { TenantContext } from '../../../../types'
import { loadCashClosingHistory } from '../../../cash-registers/service'
import { getCashClosingDay, type CashClosingReportRecord } from './cashClosingReportModel.ts'
import type { OperationalDayConfig } from '../../../../lib/operationalDay.ts'

function client() {
  if (!supabase) throw new Error('Supabase no está configurado.')
  return supabase
}

export async function loadImportedCashClosings(context: TenantContext): Promise<ImportedCashClosing[]> {
  const closings: ImportedCashClosing[] = []
  const pageSize = 500
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client().from('imported_cash_closings')
      .select('id, tenant_id, venue_id, business_date, cash_cents, card_cents, cash_tip_cents, card_tip_cents, source_row_count, file_name, imported_at')
      .eq('tenant_id', context.tenantId).eq('venue_id', context.venueId).eq('source', 'revo')
      .order('business_date', { ascending: false }).order('id').range(offset, offset + pageSize - 1)
    if (error) throw error
    closings.push(...(data ?? []).map((row): ImportedCashClosing => ({
      id: row.id, tenantId: row.tenant_id, venueId: row.venue_id, source: 'revo', date: row.business_date,
      cashCents: row.cash_cents, cardCents: row.card_cents, cashTipCents: row.cash_tip_cents,
      cardTipCents: row.card_tip_cents, rowCount: row.source_row_count, fileName: row.file_name, importedAt: row.imported_at,
    })))
    if (!data || data.length < pageSize) return closings
  }
}

export async function loadCashClosingReports(context: TenantContext, config: OperationalDayConfig): Promise<CashClosingReportRecord[]> {
  const [native, imported] = await Promise.all([
    loadCashClosingHistory(context, null), loadImportedCashClosings(context),
  ])
  return [...native, ...imported].sort((a, b) => getCashClosingDay(b, config).localeCompare(getCashClosingDay(a, config)))
}

export async function importRevoCashClosings(venueId: string, fileName: string, days: RevoClosingDay[]) {
  if (!venueId) throw new Error('Selecciona el local de destino.')
  const { data, error } = await client().rpc('import_revo_cash_closings', {
    p_venue_id: venueId, p_file_name: fileName, p_days: days,
  })
  if (error) throw error
  if (!data || !Number.isInteger(data.inserted) || !Number.isInteger(data.skipped)) {
    throw new Error('No se pudo verificar el resultado. Puedes volver a importar el archivo sin duplicar días.')
  }
  return data as { inserted: number; skipped: number }
}
