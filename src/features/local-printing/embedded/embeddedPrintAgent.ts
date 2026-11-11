import { Capacitor } from '@capacitor/core'
import { z } from 'zod'

/**
 * En la app nativa (Android/iOS) el backend de impresión corre dentro de la propia app
 * (Node.js embebido) y escucha en 127.0.0.1. En la PWA se sigue usando el agente externo.
 */
export const isEmbeddedPrintAgent = Capacitor.isNativePlatform()

export type EmbeddedPrintAgent = { baseUrl: string; token: string }

const START_TIMEOUT_MS = 30_000
const readySchema = z.object({ baseUrl: z.string().regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/), token: z.string().min(16) })

let current: EmbeddedPrintAgent | null = null
let pending: Promise<EmbeddedPrintAgent> | null = null

/** Agente embebido ya arrancado, o null si aún no está listo o no es la app nativa. */
export function getEmbeddedPrintAgent() {
  return current
}

/** Espera a que el agente embebido anuncie su URL y token por el canal del plugin. */
export function waitForEmbeddedPrintAgent(): Promise<EmbeddedPrintAgent> {
  if (!isEmbeddedPrintAgent) return Promise.reject(new Error('El servidor de impresión integrado solo existe en la app nativa.'))
  if (current) return Promise.resolve(current)
  pending ??= connect().finally(() => { pending = null })
  return pending
}

async function connect() {
  const { Nodejs } = await import('@capawesome/capacitor-nodejs')
  let resolveReady: (agent: EmbeddedPrintAgent) => void = () => undefined
  let rejectReady: (error: Error) => void = () => undefined
  const ready = new Promise<EmbeddedPrintAgent>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const timer = globalThis.setTimeout(() => rejectReady(new Error('El servidor de impresión integrado no ha arrancado.')), START_TIMEOUT_MS)
  const hello = () => { void Nodejs.send({ eventName: 'agent-hello', args: [] }).catch(() => undefined) }
  const handles = [
    await Nodejs.addListener('message', (event) => {
      if (event.eventName === 'agent-ready') {
        const parsed = readySchema.safeParse(event.args[0])
        if (parsed.success) resolveReady(parsed.data)
        else rejectReady(new Error('El servidor de impresión integrado ha enviado datos no válidos.'))
      } else if (event.eventName === 'agent-error') {
        rejectReady(new Error('El servidor de impresión integrado no ha podido arrancar.'))
      }
    }),
    await Nodejs.addListener('ready', hello),
  ]
  try {
    if ((await Nodejs.isReady()).ready) hello()
    current = await ready
    return current
  } finally {
    globalThis.clearTimeout(timer)
    await Promise.allSettled(handles.map((handle) => handle.remove()))
  }
}
