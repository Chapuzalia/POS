type Clock = Pick<Window, 'setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval'> & Partial<Pick<Window, 'requestIdleCallback' | 'cancelIdleCallback'>>

export function createAssistScheduler(evaluate: () => void, clock: Clock) {
  let active = true, timeout: number | undefined, idle: number | undefined
  const schedule = () => {
    if (!active) return
    if (timeout !== undefined) clock.clearTimeout(timeout)
    if (idle !== undefined) clock.cancelIdleCallback?.(idle)
    timeout = clock.setTimeout(() => {
      if (!active) return
      const run = () => { if (active) evaluate() }
      if (clock.requestIdleCallback) idle = clock.requestIdleCallback(run, { timeout: 5000 })
      else run()
    }, 750)
  }
  const interval = clock.setInterval(schedule, 60_000)
  return { schedule, stop() {
    active = false; clock.clearInterval(interval)
    if (timeout !== undefined) clock.clearTimeout(timeout)
    if (idle !== undefined) clock.cancelIdleCallback?.(idle)
  } }
}
