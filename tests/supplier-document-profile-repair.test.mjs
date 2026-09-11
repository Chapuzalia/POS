import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { getSupplierDocumentMockFixture } from '../supabase/functions/_shared/supplier-documents/fixtures.ts'
import { proposeConfirmedProfileRepair } from '../supabase/functions/_shared/supplier-documents/profileRepair.ts'
import { runDeterministicParser } from '../supabase/functions/_shared/supplier-documents/core.ts'
import * as repair from '../supabase/functions/_shared/supplier-documents/profileRepair.ts'

function input() {
  const fixture = getSupplierDocumentMockFixture('known-supplier')
  const extraction = runDeterministicParser(fixture.knownProfile, fixture.ocr, {
    documentType: fixture.extraction.document.type, supplierName: fixture.extraction.supplier.name,
    supplierTaxId: fixture.extraction.supplier.taxId,
  })
  return { document: { status: 'confirmed', extraction_metadata: {}, ocr_snapshot: fixture.ocr,
    document_type: extraction.document.type, document_number: extraction.document.number,
    document_date: extraction.document.date },
  supplier: { name: extraction.supplier.name, legal_name: extraction.supplier.legalName, tax_id: extraction.supplier.taxId },
  lines: extraction.lines.map((line) => ({
    supplier_reference: line.supplierReference, description_raw: line.description, barcode: line.barcode,
    quantity: line.quantity, purchase_unit: line.purchaseUnit, unit_price: line.unitPrice,
    discount_amount: line.discountAmount, charges_amount: line.chargesAmount, gross_cost: line.grossCost,
    net_cost: line.netCost, line_total: line.lineTotal, tax_rate: line.taxRate,
  })), rules: fixture.knownProfile,
  profile: { id: 'profile', status: 'verified', rules_json: { ...fixture.knownProfile, documentDateLabel: 'Etiqueta antigua' } } }
}

function proposal(target) {
  return repair.parseParserRepairProposal({
    decision: 'repair', reason: 'La fecha usa la etiqueta Fecha', evidence: ['Fecha 01/09/2026'],
    changes: [{ field: 'documentDateLabel', valueJson: JSON.stringify('Fecha') }], newRulesJson: null,
  }, target)
}

test('la reparación usa OCR guardado y entrega una propuesta vinculada al perfil diagnosticado', async () => {
  const data = input()
  let calls = 0
  const result = await proposeConfirmedProfileRepair({ ...data, propose: async (target) => {
    calls++
    assert.deepEqual(target.ocr, data.document.ocr_snapshot)
    assert.equal(target.correctedExtraction.lines[0].quantity, data.lines[0].quantity)
    assert.equal(target.diagnosis.profileId, data.profile.id)
    assert.ok(target.diagnosis.failedFields.includes('date'))
    return proposal(target)
  } })
  assert.equal(calls, 1)
  assert.equal(result.decision, 'repair')
  assert.equal(result.parentProfileId, data.profile.id)
  assert.deepEqual(result.changedFields, ['documentDateLabel'])
  assert.equal(result.rules.documentDateLabel, data.rules.documentDateLabel)
})

test('una reparación de metadata no puede modificar las reglas de líneas', async () => {
  const data = input()
  await assert.rejects(proposeConfirmedProfileRepair({ ...data, propose: async (target) =>
    repair.parseParserRepairProposal({ decision: 'repair', reason: 'Cambio fuera de ámbito',
      evidence: ['Fecha 01/09/2026'], changes: [{ field: 'columns', valueJson: JSON.stringify([]) }], newRulesJson: null,
    }, target) }), /PROFILE_REPAIR_SCOPE_INVALID/)
})

test('selección manual, documentos sin confirmar y cantidades inválidas no consumen GPT', async () => {
  for (const mode of ['manual', 'reparsed', 'review', 'quantity']) {
    const data = input()
    if (mode === 'manual') data.document.extraction_metadata.learningExcluded = true
    if (mode === 'reparsed') data.document.extraction_metadata.linesReparsedAt = '2026-09-07'
    if (mode === 'review') data.document.status = 'review'
    if (mode === 'quantity') data.lines[0].quantity = -1
    let calls = 0
    await assert.rejects(proposeConfirmedProfileRepair({ ...data, propose: async () => { calls++; return data.rules } }))
    assert.equal(calls, 0)
  }
})

test('una propuesta sin evidencia literal del OCR se rechaza', async () => {
  const data = input()
  await assert.rejects(proposeConfirmedProfileRepair({ ...data, propose: async (target) =>
    repair.parseParserRepairProposal({ decision: 'repair', reason: 'Fecha inventada',
      evidence: ['Fecha 31/12/2099'], changes: [{ field: 'documentDateLabel', valueJson: JSON.stringify('Fecha') }], newRulesJson: null,
    }, target) }), /PROFILE_REPAIR_EVIDENCE_INVALID/)
})

test('endpoint autentica, respeta RLS y guarda la propuesta con su diagnóstico', async () => {
  const source = await readFile(new URL('../supabase/functions/repair-supplier-document-profile/index.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  for (const mode of ['unauthorized', 'forbidden', 'not_pending', 'valid']) {
    const data = input()
    let handler
    const tasks = []
    const writes = []
    let aiCalls = 0
    const user = {
      auth: { getUser: async () => ({ data: { user: mode === 'unauthorized' ? null : { id: 'user' } } }) },
      from: () => ({ select() { return this }, eq() { return this },
        maybeSingle: async () => ({ data: mode === 'forbidden' ? null : { id: 'doc' } }) }),
      rpc: async () => ({ error: null }),
    }
    const admin = { rpc: async (name, args) => {
      writes.push({ name, args })
      return { data: name === 'claim_supplier_profile_repair' && mode !== 'not_pending'
        ? { ...data, token: 'token' } : null, error: null }
    } }
    const modules = {
      'https://esm.sh/@supabase/supabase-js@2.110.0': { createClient: (_url, key) => key === 'service' ? admin : user },
      '../_shared/supplier-documents/profileRepair.ts': repair,
      '../_shared/supplier-documents/providers.ts': { OpenAiSupplierDocumentProvider: class {
        async repairProfile(target) { aiCalls++; return proposal(target) }
      } },
    }
    const env = { SUPABASE_URL: 'url', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' }
    new Function('require', 'exports', 'Deno', 'EdgeRuntime', 'console', compiled)(
      (name) => modules[name], {}, { env: { get: (key) => env[key] }, serve: (callback) => { handler = callback } },
      { waitUntil: (task) => tasks.push(task) }, { error() {} })
    const response = await handler(new Request('https://example.test/repair', { method: 'POST',
      headers: { Authorization: 'Bearer test' }, body: JSON.stringify({ documentId: 'doc' }) }))
    await Promise.all(tasks)
    assert.equal(response.status, { unauthorized: 401, forbidden: 404, not_pending: 200, valid: 202 }[mode])
    assert.equal(aiCalls, mode === 'valid' ? 1 : 0)
    if (mode === 'valid') {
      assert.equal(writes[1].name, 'finish_supplier_profile_repair')
      assert.equal(writes[1].args.p_rules.documentDateLabel, data.rules.documentDateLabel)
      assert.equal(writes[1].args.p_proposal.sourceProfileId, data.profile.id)
      assert.equal(writes[1].args.p_proposal.diagnosis.repairEligible, true)
      assert.equal(writes[1].args.p_error, null)
      assert.equal(writes[1].args.p_token, 'token')
    } else assert.equal(writes.length, mode === 'not_pending' ? 1 : 0)
  }
})
