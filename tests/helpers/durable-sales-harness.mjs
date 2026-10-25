export function createDurableSalesHarness(onCommit = () => {}) {
  const operations = new Map()
  let events = []
  const save = operation => { operations.set(operation.key, operation); return operation }
  return {
    paymentScope: (context, session) => `${context.tenantId}:${context.venueId}:${context.deviceId}:${context.userId}:${session}`,
    withPaymentLock: (_key, work) => work(),
    loadPaymentOperation: async key => operations.get(key),
    loadPaymentOperations: async () => [...operations.values()],
    preparePaymentOperation: async (key, fingerprint, payload, params) => {
      const previous = operations.get(key)
      if (previous && previous.fingerprint !== fingerprint && previous.state !== 'committed') throw new Error('Pending payment')
      if (previous?.fingerprint === fingerprint) return previous
      return save({ key, fingerprint, payload, params, state: 'prepared', cashlogy: null, eventId: crypto.randomUUID() })
    },
    markPaymentCharging: async operation => save({ ...operation, state: 'charging' }),
    acceptPaymentOperation: async (operation, payload, cashlogy) => save({ ...operation, payload, cashlogy, state: 'accepted' }),
    discardPreparedPaymentOperation: async key => { if (operations.get(key)?.state === 'prepared') operations.delete(key) },
    commitPaymentOperation: async (operation, payload, enqueue, result) => {
      save({ ...operation, payload, result, state: 'committed' })
      if (enqueue) events.push({ id: operation.eventId, kind: 'sale_created', tenantId: payload.sale.tenantId, createdAt: payload.sale.createdAt, attempts: 0, payload })
      onCommit(enqueue)
    },
    cachedDurableEvents: () => events,
    loadDurableEvents: async () => events,
    loadDurableSessionTickets: async () => [],
    updateDurableEvent: async (id, error) => { events = events.flatMap(event => event.id !== id ? [event] : error === undefined ? [] : [{ ...event, attempts: event.attempts + 1, lastError: error }]) },
  }
}
