import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCashlogyManagementStore } from '../../src/features/local-printing/cashlogy/useCashlogyManagementStore'
import { usePrintAgentStore } from '../../src/features/local-printing/store/usePrintAgentStore'
import { loadCashlogyManagementIntent, saveCashlogyManagementIntent } from '../../src/features/local-printing/cashlogy/cashlogyStorage'
import { mapCashMovement } from '../../src/features/cash-registers/service'
import { summarizeSales } from '../../src/features/cash-registers/services/cashSummary'
import type { CashlogyCashManagementOperation, PrintAgentScope } from '../../src/features/local-printing/types'

// Keep the management store, HTTP client, intent persistence and cash service real.
// Mock only the hardware HTTP and Supabase RPC boundaries.
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }))
vi.mock('../../src/lib/observability.ts', () => ({ reportOperationError() {}, operationBreadcrumb() {} }))

const scope: PrintAgentScope = { tenantId: 'tenant-1', establishmentId: 'venue-1', terminalId: 'device-1' }
let operation: CashlogyCashManagementOperation
let hardwarePosts: string[]

function fixture(patch: Partial<CashlogyCashManagementOperation> = {}): CashlogyCashManagementOperation {
  return {
    id: 'operation-1', requestId: '', connectorId: 'connector-1', type: 'refill', status: 'completed',
    requestedAmountCents: null, acceptedCents: 2500, dispensedCents: null,
    denominationsRequested: null, denominationsDispensed: null, changeAddedCents: null,
    resultCode: null, normalizedErrorCode: null, error: null, startedAt: null, completedAt: null,
    createdAt: '2026-10-28T10:00:00Z', updatedAt: '2026-10-28T10:00:00Z', ...patch,
  }
}

function movementRow(args: Record<string, unknown>) {
  return {
    id: 'movement-1', tenant_id: scope.tenantId, venue_id: scope.establishmentId,
    cash_session_id: String(args.p_cash_session_id), created_by: 'user-1',
    direction: args.p_movement_type === 'cash_in' ? 'entry' as const : 'exit' as const,
    category: String(args.p_movement_type), amount_cents: Number(args.p_amount_cents),
    request_id: String(args.p_request_id), notes: String(args.p_notes), created_at: '2026-10-28T10:00:00Z',
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  const storage = new Map<string, string>()
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  } })
  operation = fixture()
  hardwarePosts = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (init.method === 'POST') {
      hardwarePosts.push(new URL(url).pathname)
      const body = JSON.parse(String(init.body))
      if (body.requestId) operation = { ...operation, requestId: body.requestId }
    }
    return Response.json({ ok: true, duplicate: false, operation })
  })
  rpc.mockReset()
  rpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => ({ data: movementRow(args), error: null }))
  usePrintAgentStore.setState({ baseUrl: 'https://agent.test', token: 'test-token', cashlogyConfigured: true })
  useCashlogyManagementStore.getState().configureScope(scope)
  useCashlogyManagementStore.getState().setCashSessionId('session-1')
})

afterEach(() => {
  useCashlogyManagementStore.getState().configureScope({ ...scope, terminalId: 'cleanup' })
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('entradas y salidas automáticas de Cashlogy', () => {
  it('registra el importe final del relleno en la misma función de caja y aparece en el resumen del cierre', async () => {
    operation = fixture({ status: 'accepting', acceptedCents: 0 })
    await useCashlogyManagementStore.getState().startRefill()
    expect(rpc).not.toHaveBeenCalled()
    const intent = loadCashlogyManagementIntent(scope)
    expect(intent).toMatchObject({ cashSessionId: 'session-1', cashMovementRequestId: expect.any(String) })
    operation = { ...operation, status: 'completed', acceptedCents: 3525 }
    await useCashlogyManagementStore.getState().finalizeRefill()
    expect(rpc).toHaveBeenCalledExactlyOnceWith('create_cash_movement', {
      p_cash_session_id: 'session-1', p_device_id: 'device-1', p_movement_type: 'cash_in',
      p_amount_cents: 3525, p_notes: 'Entrada de efectivo en Cashlogy', p_request_id: intent?.cashMovementRequestId,
    })
    const result = await rpc.mock.results[0].value
    expect(summarizeSales(10000, [], [mapCashMovement(result.data)])).toMatchObject({
      cashEntriesCents: 3525, cashExitsCents: 0, cashCents: 13525, totalSalesCents: 0,
    })
    useCashlogyManagementStore.getState().clearResolved()
    expect(loadCashlogyManagementIntent(scope)).toBeNull()
  })

  it('también registra el relleno cuando termina por polling con el modal oculto', async () => {
    operation = fixture({ status: 'accepting' })
    await useCashlogyManagementStore.getState().startRefill()
    useCashlogyManagementStore.getState().hide()
    operation = { ...operation, status: 'completed' }
    await vi.advanceTimersByTimeAsync(500)
    expect(rpc).toHaveBeenCalledOnce()
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_movement_type: 'cash_in', p_amount_cents: 2500 })
  })

  it.each(['withdraw', 'empty'] as const)('registra %s por el importe realmente entregado, sin usar el solicitado', async type => {
    operation = fixture({ type, requestedAmountCents: 5000, dispensedCents: 3750 })
    if (type === 'withdraw') await useCashlogyManagementStore.getState().withdraw([{ valueCents: 5000, quantity: 1 }])
    else await useCashlogyManagementStore.getState().empty()
    expect(rpc.mock.calls[0]).toEqual(['create_cash_movement', expect.objectContaining({
      p_movement_type: 'cash_out', p_amount_cents: 3750, p_cash_session_id: 'session-1', p_device_id: 'device-1',
    })])
    const result = await rpc.mock.results[0].value
    expect(summarizeSales(10000, [], [mapCashMovement(result.data)])).toMatchObject({ cashExitsCents: 3750, cashCents: 6250 })
  })

  it.each([[2500, 2500, null], [2500, 2000, 'cash_in'], [2500, 3000, 'cash_out']] as const)(
    'dar cambio de %i entregando %i registra solo la diferencia neta', async (acceptedCents, dispensedCents, type) => {
      operation = fixture({ type: 'give_change', acceptedCents, dispensedCents })
      await useCashlogyManagementStore.getState().startGiveChange([{ valueCents: 500, availableQuantity: 10, kind: 'coin' }])
      if (type) expect(rpc.mock.calls[0][1]).toMatchObject({ p_movement_type: type, p_amount_cents: 500 })
      else expect(rpc).not.toHaveBeenCalled()
    },
  )

  it('mantiene la retirada de stacker en su registro actual, sin una segunda salida', async () => {
    operation = fixture({ type: 'remove_stacker', dispensedCents: 5000 })
    await useCashlogyManagementStore.getState().collectStacker()
    expect(rpc).toHaveBeenCalledExactlyOnceWith('record_cashlogy_stacker_collection', expect.objectContaining({ p_amount_cents: 5000 }))
  })

  it('si se pierde la respuesta al registrar, conserva el UUID al recargar y reintenta sin repetir la operación física', async () => {
    rpc.mockRejectedValueOnce(new TypeError('Response lost after saving'))
    await expect(useCashlogyManagementStore.getState().startRefill()).rejects.toThrow('entrada/salida')
    const firstArgs = rpc.mock.calls[0][1]
    expect(firstArgs.p_request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(useCashlogyManagementStore.getState().cashMovementPending).toBe(true)
    useCashlogyManagementStore.getState().clearResolved()
    expect(loadCashlogyManagementIntent(scope)).not.toBeNull()
    useCashlogyManagementStore.getState().configureScope(scope)
    useCashlogyManagementStore.getState().setCashSessionId('session-2')
    await useCashlogyManagementStore.getState().recover()
    expect(rpc.mock.calls[1][1]).toEqual(firstArgs)
    expect(hardwarePosts).toHaveLength(1)
    expect(useCashlogyManagementStore.getState().cashMovementPending).toBe(false)
    await useCashlogyManagementStore.getState().recover()
    expect(rpc.mock.calls[2][1].p_request_id).toBe(firstArgs.p_request_id)
  })

  it.each(['failed', 'cancelled', 'unknown', 'needs_attention'] as const)('no inventa movimientos para una operación %s', async status => {
    operation = fixture({ status })
    await useCashlogyManagementStore.getState().startRefill()
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each([null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('mantiene pendiente un relleno sin importe confirmado válido: %s', async acceptedCents => {
    operation = fixture({ acceptedCents })
    await expect(useCashlogyManagementStore.getState().startRefill()).rejects.toThrow('entrada/salida')
    expect(rpc).not.toHaveBeenCalled()
    useCashlogyManagementStore.getState().clearResolved()
    expect(loadCashlogyManagementIntent(scope)).not.toBeNull()
  })

  it('permite preparar el fondo sin turno abierto y no genera un movimiento de cero', async () => {
    useCashlogyManagementStore.getState().setCashSessionId(null)
    await useCashlogyManagementStore.getState().startRefill()
    expect(rpc).not.toHaveBeenCalled()
    useCashlogyManagementStore.getState().clearResolved()
    useCashlogyManagementStore.getState().setCashSessionId('session-1')
    operation = fixture({ acceptedCents: 0 })
    await useCashlogyManagementStore.getState().startRefill()
    expect(rpc).not.toHaveBeenCalled()
    expect(useCashlogyManagementStore.getState().cashMovementPending).toBe(false)
  })

  it('no imputa una operación antigua a la caja actual ni a otro tenant/dispositivo', async () => {
    operation = fixture({ requestId: 'old-request' })
    saveCashlogyManagementIntent(scope, { requestId: operation.requestId, type: 'refill', operationId: operation.id, createdAt: operation.createdAt })
    useCashlogyManagementStore.getState().configureScope(scope)
    useCashlogyManagementStore.getState().setCashSessionId('session-1')
    await useCashlogyManagementStore.getState().recover()
    expect(rpc).not.toHaveBeenCalled()
    useCashlogyManagementStore.getState().configureScope({ tenantId: 'other-tenant', establishmentId: 'other-venue', terminalId: 'other-device' })
    expect(await useCashlogyManagementStore.getState().recover()).toBeNull()
    expect(rpc).not.toHaveBeenCalled()
  })
})
