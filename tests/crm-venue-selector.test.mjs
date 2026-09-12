import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  compileComponent,
  createHookHarness,
  jsxRuntime,
  nodes,
} from './helpers/component-harness.mjs'

const source = await readFile(new URL('../src/components/crm/CrmPage.tsx', import.meta.url), 'utf8')

test('elegir otro local cambia el estado efectivo de la página CRM', () => {
  const hooks = createHookHarness()
  const { CrmPage } = compileComponent(source, {
    '../../features/crm/access/services/accessService': { loadCrmVenues() {} },
    '../../features/crm/analytics/services/analyticsService': {
      applyCrmOpenCashSalesTotals() {},
      loadCrmDayActivity() {},
      loadCrmOpenCashSalesTotals() {},
      loadCrmStats() {},
      subscribeToCrmStatsChanges() {},
    },
    '../../features/crm/catalog/hooks/useCatalogAdmin.ts': { useCatalogAdmin: () => ({ catalog: null, isLoading: false, refresh: async () => undefined }) },
    '../../features/crm/catalog/services/catalogAdminService.ts': { catalogAdminService: {} },
    '../../features/crm/layout/CrmShell': { CrmShell: 'crm-shell' },
    '../../features/crm/routing/CrmSectionContent': { CrmSectionContent: 'crm-content' },
    '../../features/crm/routing/crmPermissions': { canAccessCrm: () => true, canAccessCrmSection: () => true },
    '../../features/crm/venues/services/venueSelection': { resolveSelectedVenueId: () => '' },
    '../../lib/supabase': { recoverSupabaseRealtimeConnection() {} },
    '../../utils/errors': { getReadableError: String },
    react: hooks.react,
    'react/jsx-runtime': jsxRuntime,
  }, { document: {}, window: {} })
  const props = {
    context: { features: {}, role: 'admin' },
    error: null,
    isOnline: true,
    onCatalogChanged: async () => undefined,
    onError() {},
    onLogout() {},
  }
  const initial = hooks.render(CrmPage, props)

  assert.equal(initial.props.selectedVenueId, '')
  initial.props.onVenueChange('venue-b')
  const updated = hooks.render(CrmPage, props)

  assert.equal(updated.props.selectedVenueId, 'venue-b')
  assert.equal(nodes(updated).find((node) => node.type === 'crm-content').props.selectedVenueId, 'venue-b')
})
