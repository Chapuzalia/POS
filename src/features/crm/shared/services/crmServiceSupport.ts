import { reportOperationError } from '../../../../lib/observability.ts';
import { normalizeText } from "../../../../lib/format";
import { supabase } from "../../../../lib/supabase";

export function requireSupabase() {
  if (!supabase) {
    throw new Error("Supabase no está configurado.");
  }

  return supabase;
}

export async function getFunctionInvokeErrorMessage(data: unknown, error: unknown, fallback: string) {
  reportOperationError(error ?? data, { operation: 'crm.function.invoke' });
  return fallback;
}

export function getImportKey(value: string) {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function createSaleFormatKey(value: string) {
  return getImportKey(value).replace(/\s+/g, "_");
}
