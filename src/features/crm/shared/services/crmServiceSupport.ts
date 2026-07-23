import { normalizeText } from "../../../../lib/format";
import { supabase } from "../../../../lib/supabase";

export function requireSupabase() {
  if (!supabase) {
    throw new Error("Supabase no esta configurado.");
  }

  return supabase;
}

function errorMessageFromBody(value: unknown) {
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  ) {
    return value.error;
  }
  return null;
}

export async function getFunctionInvokeErrorMessage(
  data: unknown,
  error: unknown,
  fallback: string,
) {
  const dataMessage = errorMessageFromBody(data);
  if (dataMessage) return dataMessage;

  if (typeof error === "object" && error !== null && "context" in error) {
    const context = error.context;
    if (context instanceof Response) {
      try {
        const responseMessage = errorMessageFromBody(await context.json());
        if (responseMessage) return responseMessage;
      } catch {
        // The response may not contain JSON (network proxy or relay failure).
      }
    }
  }

  if (
    error instanceof Error &&
    error.message &&
    !error.message.includes("non-2xx status code")
  ) {
    return error.message;
  }
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
