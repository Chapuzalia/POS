import { describe, expect, it, vi } from 'vitest'

const listeners: Record<string, (event?: unknown) => void> = {}
const send = vi.fn(async () => {
  listeners.message?.({ eventName: 'agent-ready', args: [{ baseUrl: 'http://127.0.0.1:47913', token: 'token-de-prueba-0123456789' }] })
})

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }))
vi.mock('@capawesome/capacitor-nodejs', () => ({
  Nodejs: {
    addListener: async (name: string, listener: (event?: unknown) => void) => {
      listeners[name] = listener
      return { remove: async () => { delete listeners[name] } }
    },
    isReady: async () => ({ ready: true }),
    send,
  },
}))

describe('servidor de impresión integrado (app nativa)', () => {
  it('obtiene URL y token del agente embebido y permite HTTP solo en el loopback', async () => {
    const { waitForEmbeddedPrintAgent, getEmbeddedPrintAgent } = await import('../../src/features/local-printing/embedded/embeddedPrintAgent')
    const { normalizePrintAgentUrl } = await import('../../src/features/local-printing/utils/normalizePrintAgentUrl')

    await expect(waitForEmbeddedPrintAgent()).resolves.toEqual({ baseUrl: 'http://127.0.0.1:47913', token: 'token-de-prueba-0123456789' })
    expect(send).toHaveBeenCalledWith({ eventName: 'agent-hello', args: [] })
    expect(getEmbeddedPrintAgent()?.baseUrl).toBe('http://127.0.0.1:47913')
    expect(Object.keys(listeners)).toEqual([])

    expect(normalizePrintAgentUrl('http://127.0.0.1:47913', { allowLoopbackHttp: true })).toBe('http://127.0.0.1:47913')
    expect(() => normalizePrintAgentUrl('http://192.168.1.20:8443', { allowLoopbackHttp: true })).toThrow()
    expect(() => normalizePrintAgentUrl('http://127.0.0.1:47913')).toThrow()
  })
})
