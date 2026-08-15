type QueueEvent = {
  id: string
  attempts: number
  lastError?: string
}

function clonePersistable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Detaches a paid sale from mutable UI state before it enters the retry queue. */
export function appendFrozenQueueEvent<T extends QueueEvent>(events: T[], event: T) {
  return [...events, clonePersistable(event)]
}

/** Retry metadata may change, but the event payload remains byte-for-byte equivalent JSON. */
export function recordQueueEventFailure<T extends QueueEvent>(events: T[], eventId: string, error: string) {
  return events.map((event) => event.id === eventId
    ? { ...event, attempts: event.attempts + 1, lastError: error }
    : event)
}
