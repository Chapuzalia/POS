import { DEFAULT_PRINT_AGENT_PORT } from '../constants/config.ts'
import { PrintAgentError } from '../api/PrintAgentError.ts'

type NormalizeOptions = { allowHttpInDevelopment?: boolean; defaultPort?: string; isDevelopment?: boolean }

function isValidHostname(hostname: string) {
  if (hostname === 'localhost') return true
  if (hostname.length > 253 || hostname.includes('..')) return false
  return hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
}

function isValidIpv4(hostname: string) {
  const parts = hostname.split('.')
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isValidIpv6(hostname: string) {
  return hostname.includes(':') && /^[0-9a-f:]+$/i.test(hostname) && hostname.split(':').length <= 8
}

export function normalizePrintAgentUrl(value: string, options: NormalizeOptions = {}) {
  const input = value.trim()
  if (!input || /[\s@?#]/.test(input)) {
    throw new PrintAgentError({ code: 'CONFIGURATION_ERROR', message: 'Introduce una direccion valida del agente.' })
  }

  const hasProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(input)
  const looksLikeBareIpv6 = !hasProtocol && !input.startsWith('[') && (input.match(/:/g)?.length || 0) > 1
  const candidate = hasProtocol ? input : looksLikeBareIpv6 ? `https://[${input}]` : `https://${input}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch (cause) {
    throw new PrintAgentError({ code: 'CONFIGURATION_ERROR', message: 'La direccion del agente no es valida.', cause })
  }

  const allowHttp = options.allowHttpInDevelopment === true && options.isDevelopment === true
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new PrintAgentError({ code: 'CONFIGURATION_ERROR', message: 'El agente debe utilizar HTTPS.' })
  }
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new PrintAgentError({ code: 'CONFIGURATION_ERROR', message: 'La URL base no puede incluir credenciales, rutas, parametros ni fragmentos.' })
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const resemblesIpv4 = /^\d+(?:\.\d+){3}$/.test(hostname)
  if ((resemblesIpv4 && !isValidIpv4(hostname)) || (!isValidIpv4(hostname) && !isValidIpv6(hostname) && !isValidHostname(hostname))) {
    throw new PrintAgentError({ code: 'CONFIGURATION_ERROR', message: 'El hostname o la direccion IP no son validos.' })
  }

  if (!url.port) url.port = options.defaultPort || DEFAULT_PRINT_AGENT_PORT
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new PrintAgentError({ code: 'CONFIGURATION_ERROR', message: 'El puerto del agente no es valido.' })
  }
  return url.origin
}
