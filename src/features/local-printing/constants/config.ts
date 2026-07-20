export const DEFAULT_PRINT_AGENT_URL = import.meta.env?.VITE_PRINT_AGENT_DEFAULT_URL || 'https://tpv-printer.local:8443'
export const DEFAULT_PRINT_AGENT_TIMEOUT_MS = Number(import.meta.env?.VITE_PRINT_AGENT_DEFAULT_TIMEOUT_MS) || 5_000
export const PRINT_AGENT_HEALTH_TIMEOUT_MS = Number(import.meta.env?.VITE_PRINT_AGENT_HEALTH_TIMEOUT_MS) || 2_500
export const PRINT_AGENT_ENABLED = import.meta.env?.VITE_PRINT_AGENT_ENABLED !== 'false'
export const DEFAULT_PRINT_AGENT_PORT = '8443'

export const KNOWN_PRINT_AGENT_URLS = [
  DEFAULT_PRINT_AGENT_URL,
  'https://alteil-print-mess.local:8443',
  'https://alteil-print-loft.local:8443',
]

export const FINAL_JOB_STATUSES = new Set(['printed', 'failed', 'cancelled', 'unknown'])
