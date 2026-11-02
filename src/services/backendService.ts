import { reportOperationError } from "../lib/observability.ts";
import { supabase } from "../lib/supabase";

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

