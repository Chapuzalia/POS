import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCompiledHookRunner, jsxRuntime, nodes } from '../helpers/component-harness.mjs'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../../src/services/backendService', () => ({ requireSupabase: () => ({ rpc }) }))
vi.mock('../../src/lib/supabase', () => ({ supabase: null }))

import { loadCrmDashboardLive, loadCrmDashboardPeriod } from '../../src/features/crm/analytics/services/analyticsService'
import type { CrmStats, CrmVenue, TenantContext } from '../../src/types'

const context = { tenantId: 'tenant' } as TenantContext
const venue = { id: 'venue', dayChangeTime: '06:00', timeZone: 'Europe/Madrid' } as CrmVenue
const live = { dayActivity: { totalCents: 500, cashCents: 500, cardCents: 0, ticketCount: 1 }, openCashSessions: [{ id: 'cash', venueId: 'venue' }] }

beforeEach(() => { rpc.mockReset() })

describe('dashboard loaders', () => {
  it('load the open cash sessions without waiting on the month', async () => {
    rpc.mockImplementation((name: string) => name === 'crm_stats_live' ? Promise.resolve({ data: live, error: null }) : new Promise(() => {}))
    expect(await loadCrmDashboardLive(context, venue)).toEqual(live)
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['crm_stats_live'])
  })

  it('load the month summary without the live state, and fall back on an unmigrated backend', async () => {
    rpc.mockResolvedValueOnce({ data: { averageTicketCents: 250, monthSalesCents: 1000, monthTicketCount: 4, topProducts: [] }, error: null })
    expect(await loadCrmDashboardPeriod(context, venue)).toMatchObject({ monthSalesCents: 1000, monthTicketCount: 4, salesByProduct: [] })
    rpc.mockReset()
    rpc.mockImplementation((name: string) => Promise.resolve(name === 'crm_dashboard_period_summary'
      ? { data: null, error: { code: 'PGRST202' } }
      : { data: { monthSalesCents: 7, monthTicketCount: 1, dayActivity: null, openCashSessions: [] }, error: null }))
    const period = await loadCrmDashboardPeriod(context, venue)
    expect(period).toMatchObject({ monthSalesCents: 7, monthTicketCount: 1 })
    expect(period).not.toHaveProperty('openCashSessions')
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['crm_dashboard_period_summary', 'crm_stats_period'])
  })

  it('surface a month failure instead of hiding it', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })
    await expect(loadCrmDashboardPeriod(context, venue)).rejects.toMatchObject({ code: '57014' })
  })
})

const source = readFileSync(new URL('../../src/features/crm/dashboard/pages/DashboardPage.tsx', import.meta.url), 'utf8')
const component = () => null
function renderDashboard(monthStatus: 'loading' | 'ready' | 'error') {
  const runner = createCompiledHookRunner(source, 'DashboardCrm', {
    'react/jsx-runtime': jsxRuntime,
    '../../../../components/ui/Checkbox': { Checkbox: component }, '../../../../components/ui/Button': { Button: component },
    '../../shared/components/EmptyList': { EmptyList: 'empty' }, 'lucide-react': new Proxy({}, { get: () => component }),
    '../../analytics/components/TopProductsList': { TopProductsList: 'top' },
    '../../../../lib/format': { formatMoney: (cents: number) => `${cents}c` }, '../../shared/formatCrmDateTime': { formatCrmDateTime: String },
    '../openCashSessionsModel': { groupOpenCashSessionsByVenue: () => [] },
  })
  const stats = { ...live, monthTicketCount: 0, averageTicketCents: 0, monthSalesCents: 0, topProducts: [] } as unknown as CrmStats
  const tree = nodes(runner.render({ disabled: false, monthStatus, onRefresh: vi.fn(), selectedVenueId: 'venue', stats }))
  const expanded = tree.flatMap((node) => typeof node.type === 'function' ? nodes(node.type(node.props)) : [])
  return [...tree, ...expanded]
}

describe('dashboard month card', () => {
  it.each(['loading', 'error'] as const)('keeps the open cash sessions visible while the month is %s', (status) => {
    const tree = renderDashboard(status)
    expect(tree.some((node) => node.type === 'empty' && node.props.message === 'Cargando cajas abiertas.')).toBe(false)
    expect(tree.some((node) => node.type === 'top')).toBe(false)
    if (status === 'loading') expect(tree.filter((node) => node.props?.value === '…')).toHaveLength(3)
    else expect(tree.some((node) => node.type === 'empty' && /actividad del mes/.test(node.props.message))).toBe(true)
  })

  it('does not show placeholder zeros as real month data while it loads', () => {
    expect(renderDashboard('loading').some((node) => node.props?.label === 'Ingresos' && node.props.value === '0c')).toBe(false)
    expect(renderDashboard('ready').some((node) => node.props?.label === 'Ingresos' && node.props.value === '0c')).toBe(true)
  })
})
