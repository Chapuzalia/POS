import { createClient } from "https://esm.sh/@supabase/supabase-js@2.110.0";
import {
  chooseDefaultWarehouse,
  groundSupplierExtractionInOcr,
  matchInventoryItem,
  normalizeAlias,
  normalizeSupplierTaxId,
  normalizePurchaseToBase,
  ocrDocumentSchema,
  parseSupplierDocumentExtraction,
  resolveSupplierCandidate,
  resolveSupplierFromOcr,
  runDeterministicParser,
  supplierExtractionMetadata,
  supplierSelection,
  supplierProfileRulesSchema,
  validateExtractionMath,
  validateProposedProfile,
  type InventoryUnitDefinition,
  type SupplierCandidate,
  type SupplierDocumentExtraction,
} from "../_shared/supplier-documents/core.ts";
import { getSupplierDocumentMockFixture } from "../_shared/supplier-documents/fixtures.ts";
import {
  createDocumentOcrProvider,
  MockDocumentOcrProvider,
  MockSupplierDocumentAiProvider,
  NoopNativePdfTextExtractor,
  OpenAiSupplierDocumentProvider,
  ProviderConfigurationError,
  type DocumentBinaryInput,
  type NativePdfTextExtractor,
  type SupplierDocumentAiProvider,
  type SupplierAiTrace,
} from "../_shared/supplier-documents/providers.ts";
import {
  analyzeOcrWithQuality,
  ocrAttemptMetadata,
  OcrQualityError,
} from "../_shared/supplier-documents/ocrQuality.ts";
import {
  normalizeMetadataValue,
  resolveDocumentMetadata,
} from "../_shared/supplier-documents/documentMetadata.ts";
import {
  diagnoseParser,
  type ParserDiagnosis,
  type ParserRepairInput,
  type ParserRepairProposal,
} from "../_shared/supplier-documents/profileRepair.ts";

type UntypedSupabaseClient = ReturnType<typeof createClient<any>>;
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type DbRow = Record<string, unknown>;
type DocumentRow = DbRow & {
  id: string;
  tenant_id: string;
  venue_id: string;
  document_type: "invoice" | "delivery_note";
  storage_bucket: string | null;
  storage_path: string | null;
  original_file_name: string | null;
  original_mime_type: string | null;
  status: string;
  supplier_id: string | null;
  ocr_snapshot: unknown;
  extraction_metadata: Record<string, unknown>;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function requiredEnvironment() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey)
    throw new Error("SUPABASE_FUNCTION_ENV_MISSING");
  return { supabaseUrl, anonKey, serviceRoleKey };
}

function dateValue(value: string | null) {
  return normalizeMetadataValue("date", value);
}

function learnedPackageExpression(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const packaging = value as Record<string, unknown>;
  const packageCount = Number(packaging.packageCount ?? 1);
  const unitQuantity = Number(packaging.unitQuantity);
  const unitSymbol =
    typeof packaging.unitSymbol === "string" ? packaging.unitSymbol.trim() : "";
  if (!(packageCount > 0) || !(unitQuantity > 0) || !unitSymbol) return null;
  return `${packageCount}x${unitQuantity}${unitSymbol}`;
}

function bytesToDataUrl(bytes: Uint8Array, contentType: string) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)),
    );
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

async function loadBinary(
  admin: UntypedSupabaseClient,
  document: DocumentRow,
): Promise<DocumentBinaryInput> {
  if (!document.storage_bucket || !document.storage_path)
    throw new Error("SUPPLIER_DOCUMENT_FILE_MISSING");
  const { data, error } = await admin.storage
    .from(document.storage_bucket)
    .download(document.storage_path);
  if (error || !data)
    throw error ?? new Error("SUPPLIER_DOCUMENT_DOWNLOAD_FAILED");
  return {
    bytes: new Uint8Array(await data.arrayBuffer()),
    contentType:
      document.original_mime_type || data.type || "application/octet-stream",
    fileName: document.original_file_name || "document",
  };
}

async function loadAllRows(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: DbRow[] | null; error: unknown }>,
) {
  const rows: DbRow[] = [];
  const pageSize = 200;
  for (let from = 0; ; from += pageSize) {
    const result = await page(from, from + pageSize - 1);
    if (result.error) throw result.error;
    const batch = result.data ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
}

async function loadGlobalKnowledge(admin: UntypedSupabaseClient) {
  const [suppliers, profiles] = await Promise.all([
    loadAllRows((from, to) =>
      admin
        .from("global_suppliers")
        .select("id, name, tax_id")
        .order("id")
        .range(from, to),
    ),
    loadAllRows((from, to) =>
      admin
        .from("global_supplier_document_profiles")
        .select(
          "id, global_supplier_id, document_type, rules_json, status, success_count",
        )
        .in("status", ["verified", "active"])
        .order("status", { ascending: false })
        .order("success_count", { ascending: false })
        .order("id")
        .range(from, to),
    ),
  ]);
  return { suppliers, profiles };
}

function tryKnownProfiles(
  ocr: Awaited<ReturnType<MockDocumentOcrProvider["analyze"]>>,
  documentType: "invoice" | "delivery_note",
  suppliers: DbRow[],
  profiles: DbRow[],
  routedSupplier: SupplierCandidate,
) {
  // Routing (including a manual hint) permits read-only reuse, not identity learning.
  const taxId = normalizeSupplierTaxId(routedSupplier.taxId);
  const matchingSuppliers = suppliers.filter((supplier) =>
    routedSupplier.globalSupplierId
      ? supplier.id === routedSupplier.globalSupplierId
      : taxId &&
        normalizeSupplierTaxId(String(supplier.tax_id ?? "")) === taxId,
  );
  if (matchingSuppliers.length !== 1)
    return { selected: null, diagnostics: [] as ParserDiagnosis[] };
  const supplier = matchingSuppliers[0];
  const diagnostics: ParserDiagnosis[] = [];
  let selected: {
    extraction: SupplierDocumentExtraction;
    globalProfileId: string;
    globalSupplierId: string;
  } | null = null;
  for (const profile of profiles) {
    if (profile.global_supplier_id !== supplier.id) continue;
    if (profile.document_type !== documentType) continue;
    if (profile.status !== "verified" && profile.status !== "active") continue;
    const diagnosis = diagnoseParser(
      {
        id: String(profile.id),
        status: String(profile.status),
        rules_json: profile.rules_json,
      },
      ocr,
      documentType,
    );
    diagnostics.push(diagnosis);
    try {
      if (
        !diagnosis.extraction ||
        !["success", "applicable_parser_failed"].includes(
          diagnosis.classification,
        ) ||
        diagnosis.failedFields.includes("lines")
      )
        continue;
      const extraction = parseSupplierDocumentExtraction(
        groundSupplierExtractionInOcr(
          {
            ...diagnosis.extraction,
            supplier: {
              ...diagnosis.extraction.supplier,
              name: String(supplier.name),
              taxId: supplier.tax_id ?? null,
            },
          },
          ocr,
        ),
      );
      const missing = (value: SupplierDocumentExtraction) =>
        Number(!value.document.date) + Number(!value.document.number);
      if (
        !selected ||
        missing(extraction) < missing(selected.extraction) ||
        (missing(extraction) === missing(selected.extraction) &&
          extraction.lines.length > selected.extraction.lines.length)
      )
        selected = {
          extraction,
          globalProfileId: String(profile.id),
          globalSupplierId: String(supplier.id),
        };
    } catch (error) {
      diagnosis.classification = "diagnostic_error";
      diagnosis.repairEligible = false;
      diagnosis.failures.push("PARSER_OUTPUT_GROUNDING_FAILED");
      diagnosis.failureDetails.push({
        stage: "grounding",
        code: "PARSER_OUTPUT_GROUNDING_FAILED",
        message:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "PARSER_OUTPUT_GROUNDING_FAILED",
      });
    }
  }
  return { selected, diagnostics };
}

async function loadSupplierCandidates(
  admin: UntypedSupabaseClient,
  tenantId: string,
  venueId: string,
): Promise<SupplierCandidate[]> {
  const [suppliersResult, identitiesResult] = await Promise.all([
    admin
      .from("suppliers")
      .select(
        "id, name, legal_name, tax_id, email, phone, address, global_supplier_id",
      )
      .eq("tenant_id", tenantId)
      .eq("venue_id", venueId),
    admin
      .from("supplier_identity_aliases")
      .select("supplier_id, identity_type, normalized_value, source")
      .eq("tenant_id", tenantId)
      .eq("venue_id", venueId),
  ]);
  if (suppliersResult.error) throw suppliersResult.error;
  if (identitiesResult.error) throw identitiesResult.error;
  const identitiesBySupplier = new Map<
    string,
    SupplierCandidate["identities"]
  >();
  for (const row of (identitiesResult.data ?? []) as DbRow[]) {
    const supplierId = String(row.supplier_id);
    const identities = identitiesBySupplier.get(supplierId) ?? [];
    identities.push({
      type: row.identity_type as NonNullable<
        SupplierCandidate["identities"]
      >[number]["type"],
      value: String(row.normalized_value),
      source: row.source === "user_confirmed" ? "user_confirmed" : "extracted",
    });
    identitiesBySupplier.set(supplierId, identities);
  }
  return ((suppliersResult.data ?? []) as DbRow[]).map((row) => ({
    supplierId: String(row.id),
    name: String(row.name),
    taxId: row.tax_id == null ? null : String(row.tax_id),
    legalName: row.legal_name == null ? null : String(row.legal_name),
    email: row.email == null ? null : String(row.email),
    phone: row.phone == null ? null : String(row.phone),
    address: row.address == null ? null : String(row.address),
    globalSupplierId:
      row.global_supplier_id == null ? null : String(row.global_supplier_id),
    identities: identitiesBySupplier.get(String(row.id)) ?? [],
  }));
}

async function loadInventoryContext(
  admin: UntypedSupabaseClient,
  tenantId: string,
  venueId: string,
  supplierId: string | null,
) {
  const aliasesPromise = supplierId
    ? admin
        .from("supplier_item_aliases")
        .select("alias_type, alias_value, inventory_item_id, packaging_json")
        .eq("tenant_id", tenantId)
        .eq("venue_id", venueId)
        .eq("supplier_id", supplierId)
    : Promise.resolve({ data: [], error: null });
  const [
    itemsResult,
    unitsResult,
    routesResult,
    warehousesResult,
    aliasesResult,
  ] = await Promise.all([
    admin
      .from("inventory_items")
      .select("id, name, base_unit_id, reference_cost, is_active")
      .eq("tenant_id", tenantId)
      .eq("venue_id", venueId),
    admin
      .from("inventory_units")
      .select("id, name, symbol, content_quantity, content_unit_id, is_active")
      .eq("tenant_id", tenantId)
      .eq("venue_id", venueId),
    admin
      .from("inventory_item_warehouse_routes")
      .select("inventory_item_id, warehouse_id, priority, is_enabled")
      .eq("tenant_id", tenantId)
      .eq("venue_id", venueId),
    admin
      .from("inventory_warehouses")
      .select("id, is_active, sort_order")
      .eq("tenant_id", tenantId)
      .eq("venue_id", venueId),
    aliasesPromise,
  ]);
  for (const result of [
    itemsResult,
    unitsResult,
    routesResult,
    warehousesResult,
    aliasesResult,
  ])
    if (result.error) throw result.error;
  return {
    items: ((itemsResult.data ?? []) as DbRow[]).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      baseUnitId: String(row.base_unit_id),
      referenceCost:
        row.reference_cost == null ? null : Number(row.reference_cost),
      active: Boolean(row.is_active),
    })),
    units: ((unitsResult.data ?? []) as DbRow[]).map<InventoryUnitDefinition>(
      (row) => ({
        id: String(row.id),
        name: String(row.name),
        symbol: String(row.symbol),
        contentQuantity: Number(row.content_quantity),
        contentUnitId: String(row.content_unit_id),
      }),
    ),
    routes: ((routesResult.data ?? []) as DbRow[]).map((row) => ({
      inventoryItemId: String(row.inventory_item_id),
      warehouseId: String(row.warehouse_id),
      priority: Number(row.priority),
      enabled: Boolean(row.is_enabled),
    })),
    warehouses: ((warehousesResult.data ?? []) as DbRow[]).map((row) => ({
      id: String(row.id),
      active: Boolean(row.is_active),
      sortOrder: Number(row.sort_order),
    })),
    aliases: ((aliasesResult.data ?? []) as DbRow[]).map((row) => ({
      aliasType: row.alias_type as "ean" | "supplier_reference" | "description",
      aliasValue: String(row.alias_value),
      inventoryItemId: String(row.inventory_item_id),
      packageExpression: learnedPackageExpression(row.packaging_json),
    })),
  };
}

function buildLineRows(
  extraction: SupplierDocumentExtraction,
  document: DocumentRow,
  inventory: Awaited<ReturnType<typeof loadInventoryContext>>,
) {
  const math = validateExtractionMath(extraction);
  return extraction.lines.map((line, index) => {
    const match = matchInventoryItem(line, inventory.items, inventory.aliases);
    const item =
      inventory.items.find(
        (candidate) => candidate.id === match.inventoryItemId,
      ) ?? null;
    const baseUnit =
      inventory.units.find((unit) => unit.id === item?.baseUnitId) ?? null;
    const normalized = baseUnit
      ? normalizePurchaseToBase({
          purchaseQuantity: line.quantity,
          purchaseUnit: line.purchaseUnit,
          packageExpression: match.packageExpression ?? line.packageExpression,
          description: line.description,
          baseUnit,
          units: inventory.units,
        })
      : null;
    const warehouseId = item
      ? chooseDefaultWarehouse(item.id, inventory.routes, inventory.warehouses)
      : null;
    const netCost =
      line.netCost ??
      line.lineTotal ??
      (line.unitPrice === null
        ? null
        : line.quantity * line.unitPrice -
          line.discountAmount +
          line.chargesAmount);
    const normalizedUnitCost =
      normalized && netCost !== null
        ? Math.round((netCost / normalized.baseQuantity) * 1_000_000) /
          1_000_000
        : null;
    const requiresReview =
      !item ||
      !normalized ||
      !warehouseId ||
      normalizedUnitCost === null ||
      !math.coherent ||
      math.invalidLineIndexes.includes(index);
    return {
      supplier_document_id: document.id,
      tenant_id: document.tenant_id,
      venue_id: document.venue_id,
      line_number: index + 1,
      supplier_reference: line.supplierReference,
      description_raw: line.description,
      description_normalized: normalizeAlias(line.description),
      barcode: line.barcode,
      quantity: line.quantity,
      purchase_unit: line.purchaseUnit,
      package_count: normalized?.packaging?.packageCount ?? null,
      package_unit_quantity: normalized?.packaging?.unitQuantity ?? null,
      package_unit_symbol: normalized?.packaging?.unitSymbol ?? null,
      unit_price: line.unitPrice,
      discount_amount: line.discountAmount,
      charges_amount: line.chargesAmount,
      gross_cost: line.grossCost,
      net_cost: netCost,
      line_total: line.lineTotal,
      tax_rate: line.taxRate,
      inventory_item_id: item?.id ?? null,
      warehouse_id: warehouseId,
      base_quantity: normalized?.baseQuantity ?? null,
      normalized_unit_cost: normalizedUnitCost,
      match_status: requiresReview ? "needs_review" : match.status,
      extraction_confidence: line.confidence,
      raw_extraction_metadata: {
        originalExtraction: {
          supplier_reference: line.supplierReference,
          description_raw: line.description,
          barcode: line.barcode,
          quantity: line.quantity,
          purchase_unit: line.purchaseUnit,
          unit_price: line.unitPrice,
          discount_amount: line.discountAmount,
          charges_amount: line.chargesAmount,
          gross_cost: line.grossCost,
          net_cost: netCost,
          line_total: line.lineTotal,
          tax_rate: line.taxRate,
        },
        matchReason: match.reason,
        matchScore: match.score,
        packageExpression: line.packageExpression,
        learnedPackageExpression: match.packageExpression ?? null,
        originalInventoryItemId: item?.id ?? null,
        originalWarehouseId: warehouseId,
      },
    };
  });
}

async function reparseLinesWithSelectedSupplier(
  admin: UntypedSupabaseClient,
  document: DocumentRow,
  allowOverwrite: boolean,
  proposeRepair: (input: ParserRepairInput) => Promise<ParserRepairProposal>,
) {
  if (document.status !== "review" || !document.supplier_id)
    throw new Error(
      "Selecciona un proveedor existente antes de actualizar las líneas.",
    );
  if (!document.ocr_snapshot)
    throw new Error(
      "Este documento no conserva el OCR. No se puede actualizar solo las líneas sin volver a procesarlo.",
    );
  const ocr = ocrDocumentSchema.parse(document.ocr_snapshot);
  const [supplierResult, linesResult] = await Promise.all([
    admin
      .from("suppliers")
      .select("id, name, global_supplier_id")
      .eq("id", document.supplier_id)
      .eq("tenant_id", document.tenant_id)
      .eq("venue_id", document.venue_id)
      .single(),
    admin
      .from("supplier_document_lines")
      .select(
        "id, updated_at, was_corrected, reference_cost_decided, update_reference_cost",
      )
      .eq("supplier_document_id", document.id)
      .order("id"),
  ]);
  for (const result of [supplierResult, linesResult])
    if (result.error) throw result.error;
  if (!supplierResult.data)
    throw new Error("El proveedor seleccionado ya no está disponible.");
  if (
    !allowOverwrite &&
    linesResult.data?.some(
      (line: DbRow) =>
        line.was_corrected ||
        line.reference_cost_decided ||
        line.update_reference_cost,
    )
  ) {
    return json(
      {
        code: "SUPPLIER_DOCUMENT_REPARSE_CONFIRMATION_REQUIRED",
        error:
          "Las líneas tienen correcciones. Confirma que quieres recalcularlas.",
      },
      409,
    );
  }
  const globalResolution = await admin.rpc(
    "resolve_supplier_document_existing_global",
    {
      p_document_id: document.id,
      p_supplier_id: document.supplier_id,
    },
  );
  if (globalResolution.error) throw globalResolution.error;
  supplierResult.data.global_supplier_id = globalResolution.data;
  const profiles: Array<{ id: string; status: string; rules: unknown }> = [];
  if (supplierResult.data.global_supplier_id) {
    const { data, error } = await admin
      .from("global_supplier_document_profiles")
      .select("id, status, rules_json")
      .eq("global_supplier_id", supplierResult.data.global_supplier_id)
      .eq("document_type", document.document_type)
      .in("status", ["verified", "active"])
      .order("success_count", { ascending: false });
    if (error) throw error;
    profiles.push(
      ...(data ?? []).map((profile: DbRow) => ({
        id: String(profile.id),
        status: String(profile.status),
        rules: profile.rules_json,
      })),
    );
  }
  // Historical JSON snapshots have no executable lifecycle status.
  let selected: {
    id: string;
    rules: unknown;
    lines: SupplierDocumentExtraction["lines"];
  } | null = null;
  const diagnostics: ParserDiagnosis[] = [];
  for (const profile of profiles) {
    const diagnosis = diagnoseParser(
      { ...profile, rules_json: profile.rules },
      ocr,
      document.document_type,
    );
    diagnostics.push(diagnosis);
    const parsed = diagnosis.extraction;
    if (
      !parsed ||
      !["success", "applicable_parser_failed"].includes(
        diagnosis.classification,
      ) ||
      diagnosis.failedFields.includes("lines")
    )
      continue;
    const lines = parsed.lines;
    if (!selected || lines.length > selected.lines.length)
      selected = { ...profile, lines };
  }
  // Persist attempts before repair/replacement: incompatible layouts and OCR
  // failures must remain visible even when no proposal can be produced.
  const { data: currentDocument, error: diagnosticsReadError } = await admin
    .from("supplier_documents")
    .select("extraction_metadata")
    .eq("id", document.id)
    .eq("status", "review")
    .maybeSingle();
  if (diagnosticsReadError) throw diagnosticsReadError;
  if (!currentDocument) throw new Error("SUPPLIER_DOCUMENT_REPARSE_STALE");
  document.extraction_metadata = {
    ...currentDocument.extraction_metadata,
    parserDiagnostics: diagnostics,
  };
  const { error: diagnosticsWriteError } = await admin
    .from("supplier_documents")
    .update({ extraction_metadata: document.extraction_metadata })
    .eq("id", document.id)
    .eq("status", "review");
  if (diagnosticsWriteError) throw diagnosticsWriteError;
  if (!selected) {
    const diagnosis = diagnostics
      .filter((entry) => entry.repairEligible)
      .sort((a, b) => b.layoutScore - a.layoutScore)[0];
    if (diagnosis) {
      try {
        const proposal = await proposeRepair({
          ocr,
          documentType: document.document_type,
          diagnosis,
          availableExtraction: diagnosis.extraction,
        });
        const { error } = await admin
          .from("supplier_documents")
          .update({
            extraction_metadata: {
              ...document.extraction_metadata,
              learningExcluded: true,
              learningExclusionReason: "manual_supplier_selection",
              parserDiagnostics: diagnostics,
              parserRepairProposal: proposal,
            },
          })
          .eq("id", document.id)
          .eq("status", "review");
        if (error) throw error;
        if (proposal.rules) {
          const { error: persistenceError } = await admin.rpc(
            "record_supplier_parser_repair_proposal",
            {
              p_document_id: document.id,
              p_proposal: proposal,
            },
          );
          if (persistenceError) throw persistenceError;
        }
      } catch (error) {
        console.error("Could not propose line parser repair", error);
      }
    }
    return json(
      {
        code: "SUPPLIER_DOCUMENT_PROFILE_INCOMPATIBLE",
        error:
          "Este proveedor no tiene un perfil de líneas compatible con el OCR almacenado.",
        parserDiagnostics: diagnostics,
      },
      422,
    );
  }
  const extraction = parseSupplierDocumentExtraction({
    document: {
      type: document.document_type,
      number: null,
      date: null,
      total: null,
    },
    supplier: {
      name: null,
      legalName: null,
      taxId: null,
      email: null,
      phone: null,
      address: null,
    },
    supplierResolution: {
      supplierId: null,
      confidence: "unresolved",
      signals: [],
      reasons: [],
    },
    lines: selected.lines,
    proposedProfile: null,
    confidence: ocr.confidence,
  });
  const inventory = await loadInventoryContext(
    admin,
    document.tenant_id,
    document.venue_id,
    document.supplier_id,
  );
  const { error } = await admin.rpc(
    "replace_supplier_document_lines_from_ocr",
    {
      p_document_id: document.id,
      p_supplier_id: document.supplier_id,
      p_expected_lines: linesResult.data ?? [],
      p_allow_overwrite: allowOverwrite,
      p_lines: buildLineRows(extraction, document, inventory),
      p_profile_id: selected.id,
      p_profile_rules: selected.rules,
    },
  );
  if (error) {
    if (error.message.includes("REPARSE_STALE"))
      throw new Error(
        "Las líneas o el proveedor han cambiado. Recarga el documento antes de actualizar las líneas.",
      );
    if (error.message.includes("REPARSE_CONFIRMATION_REQUIRED"))
      throw new Error(
        "Las líneas tienen nuevas correcciones. Recarga el documento y confirma antes de recalcularlas.",
      );
    throw new Error(error.message);
  }
  return json({
    documentId: document.id,
    status: "review",
    lineCount: extraction.lines.length,
    parserDiagnostics: diagnostics,
  });
}

async function processSupplierDocumentRequest(request: Request) {
  if (request.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST")
    return json({ error: "Método no permitido" }, 405);
  let documentId = "";
  let authorizedDocumentId = "";
  let admin: UntypedSupabaseClient | null = null;
  let isLineReparse = false;
  let ocrDiagnostics: Record<string, unknown> | null = null;
  const aiResponses: SupplierAiTrace[] = [];
  try {
    const env = requiredEnvironment();
    const authorization = request.headers.get("Authorization");
    if (!authorization) return json({ error: "Autorización requerida" }, 401);
    const authClient = createClient<any>(env.supabaseUrl, env.anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    });
    admin = createClient<any>(env.supabaseUrl, env.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: authData, error: authError } =
      await authClient.auth.getUser();
    if (authError || !authData.user)
      return json({ error: "Sesión no válida" }, 401);
    const body = (await request.json()) as Record<string, unknown>;
    isLineReparse = body.action === "reparse_lines";
    documentId = String(body.documentId ?? "");
    let fixtureId = typeof body.fixtureId === "string" ? body.fixtureId : null;
    if (!documentId) return json({ error: "documentId es obligatorio" }, 400);
    const { data: accessibleDocument, error: documentError } = await authClient
      .from("supplier_documents")
      .select(
        "id, tenant_id, venue_id, supplier_id, document_type, storage_bucket, storage_path, original_file_name, original_mime_type, status, ocr_snapshot, extraction_metadata",
      )
      .eq("id", documentId)
      .maybeSingle();
    if (documentError) throw documentError;
    if (!accessibleDocument)
      return json({ error: "Documento no encontrado o sin acceso" }, 404);
    const { error: featureError } = await authClient.rpc(
      "assert_supplier_document_scanning",
      { p_document_id: documentId },
    );
    if (featureError)
      return json(
        {
          error:
            "El escaneo de documentos no está habilitado para este documento o negocio.",
        },
        403,
      );
    authorizedDocumentId = documentId;
    const document = accessibleDocument as DocumentRow;
    fixtureId ??=
      typeof document.extraction_metadata.mockFixtureId === "string"
        ? document.extraction_metadata.mockFixtureId
        : null;
    const storedSelection = document.extraction_metadata.supplierSelection as
      | { kind?: string; supplierId?: string }
      | undefined;
    const manualHintId =
      storedSelection?.kind === "manual_hint"
        ? storedSelection.supplierId
        : null;
    const manualMetadata = manualHintId
      ? {
          supplierSelection: {
            kind: "manual_hint",
            supplierId: manualHintId,
            source: "manual",
          },
          learningExcluded: true,
          learningExclusionReason: "manual_supplier_selection",
        }
      : {};
    ocrDiagnostics = { ...manualMetadata };
    const aiConfig = {
      apiKey: Deno.env.get("OPENAI_API_KEY") ?? "",
      model: Deno.env.get("OPENAI_SUPPLIER_DOCUMENT_MODEL") ?? "",
      onResponse: async (trace: SupplierAiTrace) => {
        aiResponses.push(trace);
        // Store model output before parsing/grounding, including malformed JSON.
        // Diagnostics inherit the document's tenant access and never enter global rules.
        const { error } = await admin!
          .from("supplier_documents")
          .update({
            extraction_metadata: {
              ...ocrDiagnostics,
              ...manualMetadata,
              aiResponses,
              hasStoredOcr: true,
            },
          })
          .eq("id", document.id)
          .neq("status", "confirmed");
        if (error) throw error;
      },
    };
    if (document.status === "confirmed")
      return json({ error: "El documento ya está confirmado" }, 409);
    if (isLineReparse)
      return await reparseLinesWithSelectedSupplier(
        admin,
        document,
        body.allowOverwrite === true,
        (input) =>
          new OpenAiSupplierDocumentProvider({
            ...aiConfig,
            onResponse: async (trace) => {
              aiResponses.push(trace);
            },
          }).repairProfile(input),
      );
    const mockMode = Deno.env.get("SUPPLIER_DOCUMENT_MOCK_MODE") === "true";
    if (fixtureId && !mockMode)
      return json(
        {
          error:
            "Los fixtures solo están disponibles con SUPPLIER_DOCUMENT_MOCK_MODE=true",
        },
        403,
      );
    const binary = fixtureId
      ? {
          bytes: new Uint8Array(),
          contentType: "application/mock",
          fileName: `${fixtureId}.mock`,
        }
      : await loadBinary(admin, document);
    const nativeExtractor: NativePdfTextExtractor =
      new NoopNativePdfTextExtractor();
    const nativePdf =
      binary.contentType === "application/pdf"
        ? await nativeExtractor.extract(binary)
        : null;
    const ocrSelection = {
      provider: Deno.env.get("SUPPLIER_DOCUMENT_OCR_PROVIDER") ?? undefined,
      mockFixtureId: fixtureId,
      azure: {
        endpoint: Deno.env.get("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT") ?? "",
        apiKey: Deno.env.get("AZURE_DOCUMENT_INTELLIGENCE_API_KEY") ?? "",
        apiVersion:
          Deno.env.get("AZURE_DOCUMENT_INTELLIGENCE_API_VERSION") ?? undefined,
        modelId:
          Deno.env.get("AZURE_DOCUMENT_INTELLIGENCE_MODEL_ID") ?? undefined,
      },
      mistral: {
        apiKey: Deno.env.get("MISTRAL_API_KEY") ?? "",
        model: Deno.env.get("MISTRAL_OCR_MODEL") ?? undefined,
      },
    };
    const storedOcr =
      manualHintId && document.ocr_snapshot
        ? ocrDocumentSchema.parse(document.ocr_snapshot)
        : null;
    const { ocr, attempts } = storedOcr
      ? { ocr: storedOcr, attempts: [] }
      : await analyzeOcrWithQuality(
          binary,
          {
            name:
              nativePdf?.provider ??
              (fixtureId
                ? "mock"
                : ocrSelection.provider?.trim().toLowerCase() || "azure"),
            create: () =>
              nativePdf
                ? { name: nativePdf.provider, analyze: async () => nativePdf }
                : createDocumentOcrProvider(ocrSelection),
          },
          () =>
            createDocumentOcrProvider({
              ...ocrSelection,
              mockFixtureId: null,
              provider: "azure",
            }),
        );
    ocrDiagnostics = {
      ...(storedOcr
        ? document.extraction_metadata
        : ocrAttemptMetadata(attempts)),
      ...manualMetadata,
    };
    const { error: snapshotError } = await admin
      .from("supplier_documents")
      .update({
        ocr_snapshot: ocr,
        extraction_metadata: {
          ...document.extraction_metadata,
          ...ocrDiagnostics,
          hasStoredOcr: true,
        },
      })
      .eq("id", document.id)
      .neq("status", "confirmed");
    if (snapshotError) throw snapshotError;
    const [knowledge, supplierCandidates] = await Promise.all([
      loadGlobalKnowledge(admin),
      loadSupplierCandidates(admin, document.tenant_id, document.venue_id),
    ]);
    const ocrSupplierResolution = resolveSupplierFromOcr(
      ocr,
      supplierCandidates,
    );
    const globalCandidates: SupplierCandidate[] = knowledge.suppliers.map(
      (supplier) => ({
        supplierId: String(supplier.id),
        globalSupplierId: String(supplier.id),
        name: String(supplier.name),
        taxId: supplier.tax_id == null ? null : String(supplier.tax_id),
      }),
    );
    const globalOcrResolution = resolveSupplierFromOcr(ocr, globalCandidates);
    const manualSupplier = manualHintId
      ? supplierCandidates.find(
          (candidate) => candidate.supplierId === manualHintId,
        )
      : null;
    if (manualHintId && !manualSupplier)
      throw new Error("El proveedor seleccionado ya no está disponible.");
    const localSupplier =
      ocrSupplierResolution.confidence === "high"
        ? supplierCandidates.find(
            (candidate) =>
              candidate.supplierId === ocrSupplierResolution.supplierId,
          )
        : null;
    const globalSupplier =
      globalOcrResolution.confidence === "high"
        ? globalCandidates.find(
            (candidate) =>
              candidate.supplierId === globalOcrResolution.supplierId,
          )
        : null;
    const conflictingGlobalIdentity =
      localSupplier &&
      globalSupplier &&
      ((localSupplier.globalSupplierId &&
        localSupplier.globalSupplierId !== globalSupplier.globalSupplierId) ||
        (normalizeSupplierTaxId(localSupplier.taxId) &&
          normalizeSupplierTaxId(globalSupplier.taxId) &&
          normalizeSupplierTaxId(localSupplier.taxId) !==
            normalizeSupplierTaxId(globalSupplier.taxId)));
    const routedSupplier =
      manualSupplier ??
      (conflictingGlobalIdentity
        ? null
        : (localSupplier ??
          (!ocrSupplierResolution.reasons.some((reason) =>
            /conflicting|ambiguous/.test(reason),
          )
            ? globalSupplier
            : null)));
    if (!routedSupplier) {
      const { error } = await admin
        .from("supplier_documents")
        .update({
          status: "processing",
          supplier_id: null,
          global_supplier_id: null,
          global_profile_id: null,
          extraction_metadata: {
            ...ocrDiagnostics,
            hasStoredOcr: true,
            mockFixtureId: fixtureId,
            processingPhase: "awaiting_supplier",
            supplierSelection: { kind: "unresolved", supplierId: null },
            supplierResolution: conflictingGlobalIdentity
              ? {
                  supplierId: null,
                  confidence: "unresolved",
                  signals: [],
                  reasons: ["conflicting_global_identity"],
                }
              : ocrSupplierResolution,
          },
        })
        .eq("id", document.id)
        .neq("status", "confirmed");
      if (error) throw error;
      return json({
        documentId: document.id,
        status: "processing",
        processingPhase: "awaiting_supplier",
      });
    }
    const fixture = fixtureId
      ? getSupplierDocumentMockFixture(fixtureId)
      : null;
    let extraction: SupplierDocumentExtraction;
    let parserMode: "deterministic" | "ai";
    let globalProfileId: string | null = null;
    let globalSupplierId: string | null = null;
    let aiProvider: SupplierDocumentAiProvider | null = null;
    let parserDiagnostics: ParserDiagnosis[] = [];
    if (fixture?.knownProfile) {
      extraction = runDeterministicParser(fixture.knownProfile, ocr, {
        documentType: document.document_type,
        supplierName: fixture.extraction.supplier.name,
        supplierTaxId: fixture.extraction.supplier.taxId,
      });
      parserMode = "deterministic";
    } else {
      const attempted = tryKnownProfiles(
        ocr,
        document.document_type,
        knowledge.suppliers,
        knowledge.profiles,
        routedSupplier,
      );
      const known = attempted.selected;
      parserDiagnostics = attempted.diagnostics;
      ocrDiagnostics = { ...ocrDiagnostics, parserDiagnostics };
      if (known) {
        extraction = known.extraction;
        globalProfileId = known.globalProfileId;
        globalSupplierId = known.globalSupplierId;
        parserMode = "deterministic";
      } else {
        aiProvider = fixtureId
          ? new MockSupplierDocumentAiProvider(fixtureId)
          : new OpenAiSupplierDocumentProvider(aiConfig);
        const needsImage =
          !fixtureId &&
          binary.contentType.startsWith("image/") &&
          Deno.env.get("OPENAI_SUPPLIER_DOCUMENT_IMAGE_FALLBACK") === "true" &&
          (ocr.confidence < 0.65 ||
            ocr.pages.every((page) => page.tables.length === 0));
        extraction = await aiProvider.interpret({
          ocr,
          documentType: document.document_type,
          imageDataUrl: needsImage
            ? bytesToDataUrl(binary.bytes, binary.contentType)
            : null,
          supplierCandidates,
          parserRepairPending: parserDiagnostics.some(
            (diagnosis) => diagnosis.repairEligible,
          ),
        });
        parserMode = "ai";
      }
    }
    extraction = parseSupplierDocumentExtraction(
      groundSupplierExtractionInOcr(extraction, ocr),
    );
    const requestedDocumentType = document.document_type;
    const documentTypeCorrected =
      extraction.document.type !== requestedDocumentType;
    let math = validateExtractionMath(extraction);

  let profileValidation =
    parserMode === "ai" ? validateProposedProfile(ocr, extraction) : null;

  let profileGenerationRetried = false;
  let profileGenerationError: string | null = null;
  let interpretationRetried = false;
  let interpretationRetryError: string | null = null;

  if (
    parserMode === "ai" &&
    aiProvider &&
    math.coherent &&
    !profileValidation?.candidate
  ) {
    profileGenerationRetried = true;

    try {
      const proposedProfile = await aiProvider.proposeProfile({
        ocr,
        documentType: extraction.document.type,
        extraction,
      });

      extraction = parseSupplierDocumentExtraction({
        ...extraction,
        proposedProfile,
      });

      profileValidation = validateProposedProfile(ocr, extraction);
    } catch (error) {
      profileGenerationError =
        error instanceof Error ? error.message : "PROFILE_GENERATION_FAILED";
    }
  }

  if (
    parserMode === "ai" &&
    aiProvider &&
    profileValidation?.reason === "PROFILE_OUTPUT_MISMATCH" &&
    profileValidation.parsed
  ) {
    interpretationRetried = true;

    try {
      const revised = parseSupplierDocumentExtraction(
        groundSupplierExtractionInOcr(
          await aiProvider.interpret({
            ocr,
            documentType: extraction.document.type,
            supplierCandidates,
            validationFeedback: {
              reason: profileValidation.reason,
              previousLines: extraction.lines,
              parserLines: profileValidation.parsed.lines,
            },
          }),
          ocr,
        ),
      );

      const candidate = {
        ...revised,
        proposedProfile: extraction.proposedProfile,
      };

      const validation = validateProposedProfile(ocr, candidate);

      if (validation.candidate) {
        extraction = candidate;
        profileValidation = validation;
        math = validateExtractionMath(extraction);
      }
    } catch (error) {
      interpretationRetryError =
        error instanceof Error
          ? error.message
          : "INTERPRETATION_RETRY_FAILED";
    }
  }
    const appliedProfileRules = globalProfileId
    ? (knowledge.profiles.find((profile) => profile.id === globalProfileId)
        ?.rules_json ?? null)
    : (fixture?.knownProfile ?? null);

  const lineParserProfile = profileValidation?.candidate
    ? extraction.proposedProfile
    : appliedProfileRules;

  const parsedRules =
    supplierProfileRulesSchema.safeParse(appliedProfileRules);
    const documentMetadata = await resolveDocumentMetadata({
      ocr,
      rules: parsedRules.success ? parsedRules.data : null,
      extract: fixture
        ? undefined
        : async (input) => {
            const provider =
              aiProvider ?? new OpenAiSupplierDocumentProvider(aiConfig);
            return provider.extractDocumentMetadata
              ? provider.extractDocumentMetadata(input)
              : {};
          },
    });
    const metadataExtraction = Object.fromEntries(
      Object.entries(documentMetadata.metadata).map(([field, entry]) => [
        field,
        {
          ...entry,
          globalProfileId: manualSupplier ? null : globalProfileId,
          ...(manualSupplier ? { learningEligible: false } : {}),
        },
      ]),
    );
    extraction = {
      ...extraction,
      document: {
        ...extraction.document,
        date: documentMetadata.metadata.date.value,
        number: normalizeMetadataValue(
          "number",
          documentMetadata.metadata.number.value,
        ),
      },
    };
    const failedParser = globalProfileId
      ? parserDiagnostics.find(
          (diagnosis) =>
            diagnosis.profileId === globalProfileId && diagnosis.repairEligible,
        )
      : parserDiagnostics
          .filter((diagnosis) => diagnosis.repairEligible)
          .sort((left, right) => right.layoutScore - left.layoutScore)[0];
    let parserRepairProposal: ParserRepairProposal | null = null;
    let parserRepairError: string | null = null;
    if (failedParser && !fixture) {
      try {
        parserRepairProposal = await new OpenAiSupplierDocumentProvider(
          aiConfig,
        ).repairProfile({
          ocr,
          documentType: document.document_type,
          diagnosis: failedParser,
          availableExtraction: extraction,
        });
      } catch (error) {
        parserRepairError =
          error instanceof Error ? error.message : "PROFILE_REPAIR_FAILED";
      }
    }
    const modelSupplierResolution = extraction.supplierResolution;
    const supplierResolution = manualSupplier
      ? {
          supplierId: null,
          confidence: "unresolved" as const,
          signals: [],
          reasons: ["manual_hint"],
        }
      : ocrSupplierResolution.confidence === "high"
        ? ocrSupplierResolution
        : resolveSupplierCandidate(extraction.supplier, supplierCandidates);
    const supplierId =
      manualSupplier?.supplierId ??
      (supplierResolution.confidence === "high"
        ? supplierResolution.supplierId
        : null);
    const selection = manualSupplier
      ? manualMetadata.supplierSelection
      : supplierSelection(extraction, supplierResolution);
    const resolvedSupplier = supplierId
      ? (supplierCandidates.find(
          (candidate) => candidate.supplierId === supplierId,
        ) ?? null)
      : null;
    const repairSupplierId = failedParser
      ? knowledge.profiles.find(
          (profile) => profile.id === failedParser.profileId,
        )?.global_supplier_id
      : null;
    globalSupplierId = manualSupplier
      ? null
      : (globalSupplierId ??
        resolvedSupplier?.globalSupplierId ??
        routedSupplier.globalSupplierId ??
        (repairSupplierId ? String(repairSupplierId) : null));
    if (manualSupplier) globalProfileId = null;
    // Keep proposal snapshots private in lineParserProfile until confirmation.
    // A manual hint stays excluded even when its parser succeeds.
    if (supplierId && extraction.document.number) {
      const { data: duplicate, error } = await admin
        .from("supplier_documents")
        .select("id, status")
        .eq("tenant_id", document.tenant_id)
        .eq("venue_id", document.venue_id)
        .eq("supplier_id", supplierId)
        .eq("document_type", extraction.document.type)
        .ilike("document_number", extraction.document.number.trim())
        .neq("id", document.id)
        .maybeSingle();
      if (error) throw error;
      if (duplicate) {
        await admin
          .from("supplier_documents")
          .update({
            status: "error",
            extraction_metadata: {
              ...ocrDiagnostics,
              aiResponses,
              code: "SUPPLIER_DOCUMENT_DUPLICATE_NUMBER",
              duplicateDocumentId: duplicate.id,
            },
          })
          .eq("id", document.id);
        return json(
          {
            error:
              "Ya existe un documento de este proveedor con el mismo número",
            duplicateDocumentId: duplicate.id,
          },
          409,
        );
      }
    }
    const inventory = await loadInventoryContext(
      admin,
      document.tenant_id,
      document.venue_id,
      supplierId,
    );
    const lineRows = buildLineRows(extraction, document, inventory);
    const { error: deleteError } = await admin
      .from("supplier_document_lines")
      .delete()
      .eq("supplier_document_id", document.id);
    if (deleteError) throw deleteError;
    const { error: insertError } = await admin
      .from("supplier_document_lines")
      .insert(lineRows);
    if (insertError) throw insertError;
    const needsReviewCount = lineRows.filter(
      (line) => line.match_status === "needs_review",
    ).length;
    const { error: updateError } = await admin
      .from("supplier_documents")
      .update({
        supplier_id: supplierId,
        global_supplier_id: globalSupplierId,
        global_profile_id: globalProfileId,
        document_type: extraction.document.type,
        document_number: extraction.document.number,
        document_date: dateValue(extraction.document.date),
        status: "review",
        extraction_metadata: {
          ...ocrDiagnostics,
          ...manualMetadata,
          processingPhase: "complete",
          aiResponses,
          parserMode,
          ocrProvider: ocr.provider,
          ocrModel:
            typeof ocr.metadata.model === "string"
              ? ocr.metadata.model
              : typeof ocr.metadata.modelId === "string"
                ? ocr.metadata.modelId
                : null,
          ocrConfidence: ocr.confidence,
          pageCount: ocr.pages.length,
          tableCount: ocr.pages.reduce(
            (sum, page) => sum + page.tables.length,
            0,
          ),
          math,
          profileValidation:
            failedParser && parserMode === "ai"
              ? { candidate: false, reason: "PROFILE_REPAIR_PENDING" }
              : profileValidation
                ? {
                    candidate: profileValidation.candidate,
                    reason: profileValidation.reason,
                  }
                : null,

          parserDiagnostics,
          parserRepairProposal,
          parserRepairError,
          profileGenerationRetried,
          profileGenerationError,
          interpretationRetried,
          interpretationRetryError,
          metadataExtraction,
          metadataAiError: documentMetadata.aiError,
          metadataAiFailure: documentMetadata.aiFailure,
          profileParsedLineCount:
            profileValidation?.parsed?.lines.length ??
            (parserMode === "deterministic" ? extraction.lines.length : null),
          hasStoredOcr: true,
          linesSupplierId: supplierId,
          linesNeedReparse: false,
          lineParserProfile:
            failedParser && parserMode === "ai" ? null : lineParserProfile,
          rejectedProfile:
            parserMode === "ai" &&
            profileValidation &&
            !profileValidation.candidate
              ? extraction.proposedProfile
              : null,
          mockFixtureId: fixtureId,
          requestedDocumentType,
          detectedDocumentType: extraction.document.type,
          documentTypeCorrected,
          supplierExtraction: supplierExtractionMetadata(extraction),
          supplierSelection: selection,
          modelSupplierResolution,
          supplierResolution,
          ocrSupplierResolution,
          supplierCandidateCount: supplierCandidates.length,
        },
      })
      .eq("id", document.id);
    if (updateError) throw updateError;
    if (parserRepairProposal?.rules) {
      const { error } = await admin.rpc(
        "record_supplier_parser_repair_proposal",
        {
          p_document_id: document.id,
          p_proposal: parserRepairProposal,
        },
      );
      // Failure to store a proposal must not discard an extracted invoice.
      if (error)
        console.error("Could not persist parser repair candidate", error);
    }
    return json({
      documentId: document.id,
      status: "review",
      parserMode,
      lineCount: lineRows.length,
      needsReviewCount,
      supplierResolution,
      profileCandidateCreated: false,
      profileCandidatePending:
        Boolean(parserRepairProposal?.rules) ||
        (!failedParser && Boolean(profileValidation?.candidate)),
    });
  } catch (error) {
    console.error("process-supplier-document failed", error);
    const qualityError = error instanceof OcrQualityError ? error : null;
    const code =
      qualityError?.code ??
      (error instanceof ProviderConfigurationError
        ? error.code
        : "SUPPLIER_DOCUMENT_PROCESSING_FAILED");
    const message = error instanceof Error ? error.message : "Error interno";
    if (admin && authorizedDocumentId && !isLineReparse) {
      await admin
        .from("supplier_documents")
        .update({
          status: "error",
          ...(qualityError ? { ocr_snapshot: null } : {}),
          extraction_metadata: {
            ...(qualityError
              ? ocrAttemptMetadata(qualityError.attempts)
              : ocrDiagnostics),
            aiResponses,
            ...(qualityError ? { hasStoredOcr: false } : {}),
            ...(qualityError
              ? {
                  parserDiagnosticSummary: {
                    classification: qualityError.attempts.some((attempt) =>
                      attempt.sanityReasons.some(
                        (reason) => reason !== "ocr_provider_error",
                      ),
                    )
                      ? "ocr_insufficient"
                      : "ocr_unavailable",
                    stage: "ocr",
                    attempts: qualityError.attempts,
                  },
                }
              : {}),
            code,
            message,
          },
        })
        .eq("id", authorizedDocumentId)
        .neq("status", "confirmed");
    }
    const status = qualityError
      ? 422
      : error instanceof ProviderConfigurationError
        ? 503
        : 500;
    return json({ error: message, code }, status);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST")
    return json({ error: "Método no permitido" }, 405);
  const backgroundRequest = request.clone();
  try {
    const env = requiredEnvironment();
    const authorization = request.headers.get("Authorization");
    if (!authorization) return json({ error: "Autorización requerida" }, 401);
    const authClient = createClient<any>(env.supabaseUrl, env.anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    });
    const { data: authData, error: authError } =
      await authClient.auth.getUser();
    if (authError || !authData.user)
      return json({ error: "Sesión no válida" }, 401);
    const body = (await request.json()) as Record<string, unknown>;
    if (body.action === "reparse_lines")
      return await processSupplierDocumentRequest(backgroundRequest);
    const documentId = String(body.documentId ?? "");
    const fixtureId =
      typeof body.fixtureId === "string" ? body.fixtureId : null;
    if (!documentId) return json({ error: "documentId es obligatorio" }, 400);
    const { data: accessibleDocument, error: documentError } = await authClient
      .from("supplier_documents")
      .select(
        "id, status, tenant_id, venue_id, extraction_metadata, ocr_snapshot",
      )
      .eq("id", documentId)
      .maybeSingle();
    if (documentError) throw documentError;
    if (!accessibleDocument)
      return json({ error: "Documento no encontrado o sin acceso" }, 404);
    const { error: featureError } = await authClient.rpc(
      "assert_supplier_document_scanning",
      { p_document_id: documentId },
    );
    if (featureError)
      return json(
        {
          error:
            "El escaneo de documentos no está habilitado para este documento o negocio.",
        },
        403,
      );
    if (accessibleDocument.status === "confirmed")
      return json({ error: "El documento ya está confirmado" }, 409);
    if (fixtureId && Deno.env.get("SUPPLIER_DOCUMENT_MOCK_MODE") !== "true") {
      return json(
        {
          error:
            "Los fixtures solo están disponibles con SUPPLIER_DOCUMENT_MOCK_MODE=true",
        },
        403,
      );
    }
    const metadata = accessibleDocument.extraction_metadata ?? {};
    if (body.action === "resume_with_supplier") {
      if (
        accessibleDocument.status !== "processing" ||
        metadata.processingPhase !== "awaiting_supplier" ||
        !accessibleDocument.ocr_snapshot
      ) {
        return json(
          {
            error:
              "El documento ya no está esperando proveedor. Recárgalo antes de continuar.",
          },
          409,
        );
      }
      const hintId =
        typeof body.manualHintSupplierId === "string"
          ? body.manualHintSupplierId
          : "";
      const { data: supplier, error: supplierError } = await authClient
        .from("suppliers")
        .select("id")
        .eq("id", hintId)
        .eq("tenant_id", accessibleDocument.tenant_id)
        .eq("venue_id", accessibleDocument.venue_id)
        .maybeSingle();
      if (supplierError) throw supplierError;
      if (!supplier)
        return json({ error: "Selecciona un proveedor de este local." }, 400);
      const admin = createClient<any>(env.supabaseUrl, env.serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: claimed, error } = await admin
        .from("supplier_documents")
        .update({
          extraction_metadata: {
            ...metadata,
            processingPhase: "extracting",
            supplierSelection: {
              kind: "manual_hint",
              supplierId: supplier.id,
              source: "manual",
            },
            learningExcluded: true,
            learningExclusionReason: "manual_supplier_selection",
          },
        })
        .eq("id", documentId)
        .eq("status", "processing")
        .eq("extraction_metadata->>processingPhase", "awaiting_supplier")
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (!claimed)
        return json(
          { error: "El documento ya está continuando su procesamiento." },
          409,
        );
    } else if (
      metadata.processingPhase === "awaiting_supplier" &&
      accessibleDocument.status === "processing"
    ) {
      return json(
        {
          documentId,
          status: "processing",
          processingPhase: "awaiting_supplier",
        },
        202,
      );
    }
    if (accessibleDocument.status === "error") {
      const admin = createClient<any>(env.supabaseUrl, env.serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error } = await admin
        .from("supplier_documents")
        .update({ status: "processing" })
        .eq("id", documentId)
        .eq("status", "error");
      if (error) throw error;
    }
    EdgeRuntime.waitUntil(
      processSupplierDocumentRequest(backgroundRequest).then(
        async (response) => {
          if (!response.ok)
            console.error(
              "background supplier document processing failed",
              response.status,
              await response.text(),
            );
        },
      ),
    );
    return json({ documentId, status: "processing" }, 202);
  } catch (error) {
    console.error("could not start supplier document processing", error);
    return json(
      { error: error instanceof Error ? error.message : "Error interno" },
      500,
    );
  }
});
