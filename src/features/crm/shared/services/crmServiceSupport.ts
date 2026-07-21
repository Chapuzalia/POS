import { normalizeText } from '../../../../lib/format'
import { supabase } from '../../../../lib/supabase'

export function requireSupabase() {
  if (!supabase) {
    throw new Error('Supabase no esta configurado.')
  }

  return supabase
}

export function getMonthStartIso() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
}

export function getImportKey(value: string) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, ' ').trim()
}

export function createSaleFormatKey(value: string) {
  return getImportKey(value).replace(/\s+/g, '_')
}
