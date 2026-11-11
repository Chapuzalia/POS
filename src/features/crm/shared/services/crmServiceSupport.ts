import { normalizeText } from "../../../../lib/format";

export function getImportKey(value: string) {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function createSaleFormatKey(value: string) {
  return getImportKey(value).replace(/\s+/g, "_");
}
