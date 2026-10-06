import type { AssistConfiguration, AssistOrder, AssistSituation, AssistSnapshot } from './types.ts'

export function isAssistEnabled(config: AssistConfiguration | undefined, features?: string[]) {
  return config?.tenantEnabled === true && config.venueEnabled === true && features?.includes('tickit_assist') === true
}

// Benchmark boundary: replace this provider with compact historical aggregates in V2.
export function assistThresholds(sensitivity: AssistConfiguration['sensitivity']) {
  const factor = sensitivity === 'low' ? 1.5 : sensitivity === 'high' ? 0.75 : 1
  return { firstOrderMs: 12 * 60_000 * factor, readyMs: 8 * 60_000 * factor,
    preparationMs: 30 * 60_000 * factor, overloadUnits: 18 * factor,
    imbalanceGap: 10 * factor, actionFactor: 2, cooldownMs: 15 * 60_000 }
}

const elapsed = (date: string | null, now: number) => {
  const time = date ? Date.parse(date) : NaN
  return Number.isFinite(time) && time <= now ? now - time : 0
}
export function operationalLoad(order: AssistOrder, waiting: boolean) {
  return 2 + Math.min(30, Math.max(0, order.guests)) / 2 + (waiting ? 3 : 0) + (order.pendingUnits > 0 ? 1 : 0)
}

export class AssistEngine {
  private active = new Map<string, AssistSituation>()
  private lastAction = new Map<string, number>()
  private queue: Array<{ at: number; units: number }> = []

  restore(situations: AssistSituation[], now: number) {
    for (const situation of situations.slice(-64)) {
      if (situation.state !== 'active' || !Number.isFinite(Date.parse(situation.startedAt)) || Date.parse(situation.expiresAt) <= now) continue
      this.active.set(situation.key, { ...situation })
      if (situation.severity === 'ACTION') this.lastAction.set(situation.key, now)
    }
  }

  feedback(key: string, value: 'understood' | 'not_a_problem') {
    const situation = this.active.get(key)
    if (situation) situation.feedback = value
    return situation
  }

  evaluate(snapshot: AssistSnapshot, now: number) {
    const thresholds = assistThresholds(snapshot.configuration.sensitivity)
    const candidates = new Map<string, Omit<AssistSituation, 'episodeId' | 'startedAt' | 'endedAt' | 'state' | 'expiresAt'>>()
    const add = (kind: AssistSituation['kind'], entityId: string, description: string, metrics: Record<string, number>, action = false) => {
      const key = `${kind}:${entityId}`
      candidates.set(key, { key, kind, entityId, description, metrics, severity: action ? 'ACTION' : 'ATTENTION' })
    }
    const zones = new Map<string, number>(), zoneNames = new Map<string, string>()
    // Splits/joined tables are one operational group, never one warning per product.
    const groups = new Map<string, AssistOrder>()
    for (const order of snapshot.orders) {
      const previous = groups.get(order.groupId)
      if (!previous) groups.set(order.groupId, { ...order })
      else {
        const previousUnits = previous.timedPendingUnits ?? previous.pendingUnits
        const nextUnits = order.timedPendingUnits ?? order.pendingUnits
        const previousSent = Date.parse(previous.averagePendingAt ?? previous.oldestPendingAt ?? '')
        const nextSent = Date.parse(order.averagePendingAt ?? order.oldestPendingAt ?? '')
        const weight = (Number.isFinite(previousSent) ? previousUnits : 0) + (Number.isFinite(nextSent) ? nextUnits : 0)
        if (weight > 0) {
          previous.averagePendingAt = new Date(((Number.isFinite(previousSent) ? previousSent * previousUnits : 0) + (Number.isFinite(nextSent) ? nextSent * nextUnits : 0)) / weight).toISOString()
          previous.timedPendingUnits = weight
        }
        previous.lineCount += order.lineCount
        previous.pendingUnits += order.pendingUnits
        previous.readyUnits += order.readyUnits
        previous.guests = Math.max(previous.guests, order.guests)
        if (order.updatedAt > previous.updatedAt) previous.updatedAt = order.updatedAt
        if (order.readyAt && (!previous.readyAt || order.readyAt > previous.readyAt)) previous.readyAt = order.readyAt
        if (order.openedAt < previous.openedAt) previous.openedAt = order.openedAt
        if (order.oldestPendingAt && (!previous.oldestPendingAt || order.oldestPendingAt < previous.oldestPendingAt)) previous.oldestPendingAt = order.oldestPendingAt
      }
    }
    let units = 0, weightedAge = 0, oldest = 0, affected = 0
    for (const order of groups.values()) {
      const sinceOpen = elapsed(order.openedAt, now)
      // Empty tables and food ready but not served require attention; eating/awaiting kitchen do not.
      const empty = order.lineCount === 0 && sinceOpen >= thresholds.firstOrderMs
      const ready = order.readyUnits > 0 && elapsed(order.readyAt, now) >= thresholds.readyMs
      if (empty || ready) {
        const age = empty ? sinceOpen : elapsed(order.readyAt, now)
        add('unattended_table', order.groupId, `${order.tableName} · ${Math.floor(age / 60_000)} min ${empty ? 'desde apertura sin comanda' : 'con elaboraciones listas sin servir'}`,
          { minutes: Math.floor(age / 60_000), ready_units: order.readyUnits, line_count: order.lineCount }, age >= (empty ? thresholds.firstOrderMs : thresholds.readyMs) * thresholds.actionFactor)
      }
      const age = elapsed(order.oldestPendingAt, now)
      const pending = Math.max(0, order.pendingUnits)
      if (pending && age > thresholds.preparationMs) add('kitchen_delay', order.groupId,
        `${order.tableName} · ${Math.floor(age / 60_000)} min de preparación`,
        { pending_items: pending, minutes: Math.floor(age / 60_000), expected_minutes: thresholds.preparationMs / 60_000 }, age >= thresholds.preparationMs * thresholds.actionFactor)
      units += pending
      weightedAge += elapsed(order.averagePendingAt ?? order.oldestPendingAt, now) * (order.timedPendingUnits ?? pending)
      oldest = Math.max(oldest, age)
      if (pending) affected++
      if (order.zoneId) zones.set(order.zoneId, (zones.get(order.zoneId) ?? 0) + operationalLoad(order, empty || ready))
      if (order.zoneId && order.zoneName) zoneNames.set(order.zoneId, order.zoneName)
    }
    this.queue = this.queue.filter((sample) => now - sample.at <= 10 * 60_000)
    const baseline = this.queue[0]
    const growth = baseline && now - baseline.at >= 2 * 60_000 ? units - baseline.units : 0
    if (!this.queue.length || now - this.queue[this.queue.length - 1].at >= 60_000) this.queue.push({ at: now, units })
    const average = units ? weightedAge / units : 0
    if (units >= thresholds.overloadUnits && (average >= thresholds.preparationMs * .6 || (growth >= 6 && oldest >= thresholds.preparationMs * .5))) {
      add('kitchen_overload', 'kitchen', 'Cocina · cola acumulada y preparación prolongada',
        { pending_items: units, average_delay_minutes: Math.floor(average / 60_000), queue_growth: growth, affected_tables: affected }, average >= thresholds.preparationMs)
    }
    if (zones.size >= 2) {
      const loads = [...zones.values()]
      const min = Math.min(...loads), max = Math.max(...loads)
      const affectedZone = [...zones].find(([, load]) => load === max)?.[0] ?? 'zones'
      if (max - min >= thresholds.imbalanceGap && max >= Math.max(1, min) * 2.5) add('floor_imbalance', affectedZone,
        `Sala · ${zoneNames.get(affectedZone) ?? 'una zona'} concentra una carga operativa elevada`, { max_load: max, min_load: min, active_zones: zones.size })
    }
    const changed: AssistSituation[] = [], notifications: AssistSituation[] = []
    for (const [key, previous] of this.active) {
      if (!candidates.has(key)) {
        changed.push({ ...previous, state: 'resolved', endedAt: new Date(now).toISOString() })
        this.active.delete(key)
      }
    }
    for (const [key, candidate] of candidates) {
      const previous = this.active.get(key)
      const situation: AssistSituation = { ...candidate, episodeId: previous?.episodeId ?? crypto.randomUUID(),
        startedAt: previous?.startedAt ?? new Date(now).toISOString(), endedAt: null, state: 'active',
        expiresAt: new Date(now + 24 * 60 * 60_000).toISOString(), feedback: previous?.feedback }
      if (!previous || previous.severity !== situation.severity) changed.push(situation)
      if (situation.severity === 'ACTION' && !situation.feedback && (!previous || previous.severity !== 'ACTION') && now - (this.lastAction.get(key) ?? -Infinity) >= thresholds.cooldownMs) {
        this.lastAction.set(key, now); notifications.push(situation)
      }
      this.active.set(key, situation)
    }
    for (const [key, at] of this.lastAction) if (!this.active.has(key) && now - at > thresholds.cooldownMs) this.lastAction.delete(key)
    const rank = { ACTION: 0, ATTENTION: 1, INFO: 2 }
    return { situations: [...this.active.values()].sort((a, b) => rank[a.severity] - rank[b.severity] || a.startedAt.localeCompare(b.startedAt)), changed, notifications }
  }
}
