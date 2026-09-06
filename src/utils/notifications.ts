import { sileo } from 'sileo'

let lastMessage = ''
let lastShownAt = 0

/** Realtime refreshes and repeated offline state must not flood the operator. */
export function notifyOperationalError(message: string) {
  const now = Date.now()
  if (message === lastMessage && now - lastShownAt < 30_000) return
  lastMessage = message
  lastShownAt = now
  sileo.error({ title: message })
}
