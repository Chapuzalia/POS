export type OperationalDayConfig = {
  dayChangeTime: string | null
  timeZone: string
}

type ZonedDateTimeParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const zonedDateTimeFormatters = new Map<string, Intl.DateTimeFormat>()

function getZonedDateTimeFormatter(timeZone: string) {
  const cached = zonedDateTimeFormatters.get(timeZone)
  if (cached) return cached

  const formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone,
    year: 'numeric',
  })
  zonedDateTimeFormatters.set(timeZone, formatter)
  return formatter
}

function getZonedDateTimeParts(value: Date, timeZone: string): ZonedDateTimeParts {
  const parts = Object.fromEntries(
    getZonedDateTimeFormatter(timeZone)
      .formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  )

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  }
}

function toIsoDate({ year, month, day }: Pick<ZonedDateTimeParts, 'year' | 'month' | 'day'>) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function shiftIsoDate(isoDate: string, days: number) {
  const [year, month, day] = isoDate.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`
}

function getTimeZoneOffsetMs(value: Date, timeZone: string) {
  const wholeSecondValue = new Date(Math.floor(value.getTime() / 1000) * 1000)
  const parts = getZonedDateTimeParts(wholeSecondValue, timeZone)
  const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return representedAsUtc - wholeSecondValue.getTime()
}

function zonedDateTimeToDate(parts: ZonedDateTimeParts, timeZone: string) {
  const localEpoch = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  let candidate = localEpoch
  const candidates = new Set<number>()

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const adjusted = localEpoch - getTimeZoneOffsetMs(new Date(candidate), timeZone)
    if (adjusted === candidate) return new Date(adjusted)
    candidates.add(adjusted)
    candidate = adjusted
  }

  // If the configured time falls inside a daylight-saving gap, use the later
  // compatible instant so the operational day never starts before that gap.
  return new Date(Math.max(...candidates))
}

export function normalizeDayChangeTime(value: string | null | undefined) {
  const normalized = value?.trim() ?? ''
  if (!normalized) return null

  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(normalized)
  if (!match) {
    throw new Error('La hora de cambio de día debe tener formato HH:mm.')
  }

  return `${match[1]}:${match[2]}`
}

export function getOperationalDateKey(value: Date | string, config: OperationalDayConfig) {
  const instant = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(instant.getTime())) {
    throw new Error('No se puede calcular el día operativo de una fecha no válida.')
  }

  const local = getZonedDateTimeParts(instant, config.timeZone)
  const calendarDate = toIsoDate(local)
  const dayChangeTime = normalizeDayChangeTime(config.dayChangeTime)
  if (!dayChangeTime) return calendarDate

  const [changeHour, changeMinute] = dayChangeTime.split(':').map(Number)
  const isBeforeDayChange = local.hour * 60 + local.minute < changeHour * 60 + changeMinute
  return isBeforeDayChange ? shiftIsoDate(calendarDate, -1) : calendarDate
}

export function getOperationalMonthStartIso(config: OperationalDayConfig, now = new Date()) {
  const operationalDate = getOperationalDateKey(now, config)
  const [year, month] = operationalDate.split('-').map(Number)
  const dayChangeTime = normalizeDayChangeTime(config.dayChangeTime) ?? '00:00'
  const [hour, minute] = dayChangeTime.split(':').map(Number)

  return zonedDateTimeToDate({
    year,
    month,
    day: 1,
    hour,
    minute,
    second: 0,
  }, config.timeZone).toISOString()
}
