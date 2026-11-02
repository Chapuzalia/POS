export function nowIso() {
  return new Date().toISOString()
}

export function localDateKey(value: Date, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).format(value)
}

export function shiftDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

export function getDateRange(dateKey: string, timeZone: string) {
  return {
    from: zonedLocalToUtc(dateKey, '00:00', timeZone),
    to: zonedLocalToUtc(shiftDateKey(dateKey, 1), '00:00', timeZone),
  }
}

export function zonedLocalToUtc(dateKey: string, time: string, timeZone: string) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const localEpoch = Date.UTC(year, month - 1, day, hour, minute)
  let candidate = localEpoch
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    day: '2-digit', hour: '2-digit', hourCycle: 'h23', minute: '2-digit',
    month: '2-digit', second: '2-digit', timeZone, year: 'numeric',
  })
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate))
      .filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    const adjusted = localEpoch - (represented - candidate)
    if (adjusted === candidate) return new Date(adjusted).toISOString()
    candidate = adjusted
  }
  return new Date(candidate).toISOString()
}
