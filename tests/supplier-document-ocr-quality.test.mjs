import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import * as core from '../supabase/functions/_shared/supplier-documents/core.ts'
import * as providers from '../supabase/functions/_shared/supplier-documents/providers.ts'
import * as fixtures from '../supabase/functions/_shared/supplier-documents/fixtures.ts'
import * as quality from '../supabase/functions/_shared/supplier-documents/ocrQuality.ts'

const { analyzeOcrWithQuality, validateOcrSanity, OcrQualityError, OCR_QUALITY_MESSAGE } = quality
const fixture = fixtures.getSupplierDocumentMockFixture('known-supplier')
const binary = { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg', fileName: 'factura.jpg' }
const repeatedBlock = 'Coca-Cola Corporation\nSan Francisco, California\n(415) 661-1001\n'

function ocrText(text, provider = 'mistral', confidence = 0.96) {
  const ocr = structuredClone(fixture.ocr)
  ocr.text = text
  ocr.provider = provider
  ocr.confidence = confidence
  ocr.pages = [{ ...ocr.pages[0], text, confidence, blocks: [], words: [], tables: [] }]
  return ocr
}
const normal = (provider = 'mistral') => ({ ...structuredClone(fixture.ocr), provider })
const corrupt = () => ocrText(repeatedBlock.repeat(200))

test('OCR normal y todos los fixtures existentes superan el sanity check sin depender de confidence', () => {
  assert.equal(validateOcrSanity(normal()).valid, true)
  assert.equal(validateOcrSanity({ ...normal(), confidence: 0.20 }).valid, true)
  for (const fixture of fixtures.supplierDocumentMockFixtures) {
    assert.deepEqual(validateOcrSanity(fixture.ocr).reasons, [], fixture.id)
  }
})

test('rechaza la misma secuencia cientos de veces incluso con confidence 0.96', () => {
  const check = validateOcrSanity(corrupt())
  assert.equal(check.valid, false)
  assert.equal(check.metrics.confidence, 0.96)
  assert.ok(check.reasons.includes('excessive_repeated_content'))
  assert.ok(check.reasons.includes('very_low_content_diversity'))
  assert.equal(check.metrics.maximumLineRepetitions, 200)
})

test('normaliza mayúsculas y espacios y detecta bloques aunque se pierdan los saltos de línea', () => {
  const text = Array.from({ length: 100 }, (_, index) => index % 2
    ? '   COCA-COLA   CORPORATION  San  Francisco, California   (415) 661-1001 '
    : repeatedBlock.replaceAll('\n', ' ')).join(' ')
  const check = validateOcrSanity(ocrText(text))
  assert.equal(check.valid, false)
  assert.ok(check.reasons.includes('excessive_repeated_sequences'))
})

test('una cabecera repetida tres veces y tablas normales largas no son corrupción', () => {
  const pages = Array.from({ length: 3 }, (_, page) => [
    'DISTRIBUCIONES NORTE S.L. CIF B12345678',
    `Factura 12345. Página ${page + 1}`,
    ...Array.from({ length: 50 }, (_, row) => `REF-${page}-${row} Producto ${row} de la familia ${page} | ${row + 1} | ${row * 7 + 3},00`),
    'Dto. Fijo 1,00', 'Punto Verde 0,03', 'SUBUNIDADES/NETO 48 0,85 41,19',
  ].join('\n'))
  const ocr = ocrText(pages.join('\n'))
  ocr.pages = pages.map((text, index) => ({ ...ocr.pages[0], text, pageNumber: index + 1 }))
  assert.deepEqual(validateOcrSanity(ocr).reasons, [])
})

test('la cabecera de muchas páginas no se cuenta como una repetición patológica', () => {
  const pages = Array.from({ length: 30 }, (_, index) => `Proveedor habitual nombre largo\nDirección comercial Calle Mayor 123 Madrid\nFactura página ${index + 1}\nProducto referencia A${index} cantidad ${index + 2} total ${index + 10}`)
  const ocr = ocrText(pages.join('\n'))
  ocr.pages = pages.map((text, index) => ({ ...ocr.pages[0], text, pageNumber: index + 1 }))
  assert.deepEqual(validateOcrSanity(ocr).reasons, [])
})

test('JSON dominante de detecciones visuales repetidas es inválido, no cualquier llave o ejemplo aislado', () => {
  const detections = Array.from({ length: 12 }, (_, index) => ({
    box_2d: [0, index, 100, index + 10], label: 'aside_text', caption: `Texto detectado ${index}`,
  }))
  for (const text of [JSON.stringify(detections), `\`\`\`json\n${JSON.stringify(detections, null, 2)}\n\`\`\``]) {
    assert.ok(validateOcrSanity(ocrText(text)).reasons.includes('dominant_visual_detection_json'))
  }
  assert.equal(validateOcrSanity(ocrText(`${fixture.ocr.text}\nReferencia {ABC}\n${JSON.stringify(detections[0])}`)).valid, true)
})

test('no diluye una página corrupta dentro de otras páginas válidas', () => {
  const ocr = normal()
  const bad = corrupt().pages[0]
  ocr.pages.push({ ...bad, pageNumber: 2 })
  // Simulate a provider whose summary omits the corrupt page.
  const check = validateOcrSanity(ocr)
  assert.equal(check.valid, false)
  assert.equal(check.metrics.suspiciousPages[0].pageNumber, 2)
})

test('vacío, casi vacío y símbolos sin contenido alfanumérico son inválidos', () => {
  for (const text of ['', '  \n\t', 'Total 12', '| - {} '.repeat(100)]) {
    assert.equal(validateOcrSanity(ocrText(text)).valid, false, text.slice(0, 20))
  }
  const ocr = normal()
  ocr.pages.push({ ...ocr.pages[0], pageNumber: 2, text: '', tables: [], words: [] })
  assert.equal(validateOcrSanity(ocr).valid, true, 'una página vacía final no invalida la factura')
})

test('usa páginas o tablas cuando no hay texto agregado sin duplicar representaciones', () => {
  const ocr = normal()
  ocr.text = ''
  assert.equal(validateOcrSanity(ocr).valid, true)
  ocr.pages[0].text = ''
  ocr.pages[0].words = []
  assert.equal(validateOcrSanity(ocr).valid, true)
})

test('el umbral de repetición es conservador: once apariciones no bastan; doce dominantes sí', () => {
  const line = 'Distribuciones regionales alimentarias proveedor comercial nombre completo domicilio avenida principal número cuarenta localidad Barcelona\n'
  assert.equal(validateOcrSanity(ocrText(line.repeat(11))).valid, true)
  assert.ok(validateOcrSanity(ocrText(line.repeat(12))).reasons.includes('excessive_repeated_content'))
})

function fakeProvider(name, output, calls) {
  return { name, analyze: async (input) => {
    assert.strictEqual(input, binary)
    calls.push(name)
    if (output instanceof Error) throw output
    return output
  } }
}

test('Mistral válido no construye ni llama a Azure y conserva exactamente su OCR', async () => {
  const calls = []
  const ocr = normal()
  const result = await analyzeOcrWithQuality(binary, {
    name: 'mistral', create: () => fakeProvider('mistral', ocr, calls),
  }, () => { throw new Error('Azure no debe construirse') })
  assert.strictEqual(result.ocr, ocr)
  assert.deepEqual(calls, ['mistral'])
  assert.equal(result.attempts.length, 1)
})

test('Mistral inválido llama una vez a Azure; solo su OCR aceptado sale del flujo', async () => {
  const calls = []
  const azure = normal('azure')
  const result = await analyzeOcrWithQuality(binary, {
    name: 'mistral', create: () => fakeProvider('mistral', corrupt(), calls),
  }, () => fakeProvider('azure', azure, calls))
  assert.strictEqual(result.ocr, azure)
  assert.deepEqual(calls, ['mistral', 'azure'])
  assert.deepEqual(result.attempts.map(({ provider, accepted }) => ({ provider, accepted })), [
    { provider: 'mistral', accepted: false }, { provider: 'azure', accepted: true },
  ])
  assert.ok(result.attempts[0].metrics.repeatedLineCoverage > 0.8)
  assert.doesNotMatch(JSON.stringify(result.attempts), /Coca-Cola|San Francisco|661-1001/)
})

test('ambos inválidos detienen el flujo sin tercer intento y con error público seguro', async () => {
  const calls = []
  await assert.rejects(analyzeOcrWithQuality(binary, {
    name: 'mistral', create: () => fakeProvider('mistral', corrupt(), calls),
  }, () => fakeProvider('azure', ocrText('', 'azure'), calls)), (error) => {
    assert.ok(error instanceof OcrQualityError)
    assert.equal(error.code, 'OCR_QUALITY_TOO_LOW')
    assert.equal(error.message, OCR_QUALITY_MESSAGE)
    assert.equal(error.attempts.length, 2)
    assert.ok(error.attempts.every((attempt) => !attempt.accepted))
    return true
  })
  assert.deepEqual(calls, ['mistral', 'azure'])
})

test('Azure configurado como principal no provoca un fallback inverso ni un bucle', async () => {
  const calls = []
  await assert.rejects(analyzeOcrWithQuality(binary, {
    name: 'azure', create: () => fakeProvider('azure', corrupt(), calls),
  }, () => { throw new Error('No repetir Azure') }), OcrQualityError)
  assert.deepEqual(calls, ['azure'])
})

test('una respuesta estructuralmente rota permite fallback pero un error de servicio no genera coste extra', async () => {
  const calls = []
  const result = await analyzeOcrWithQuality(binary, {
    name: 'mistral', create: () => fakeProvider('mistral', new Error('MISTRAL_OCR_EMPTY'), calls),
  }, () => fakeProvider('azure', normal('azure'), calls))
  assert.equal(result.ocr.provider, 'azure')
  assert.deepEqual(result.attempts[0].sanityReasons, ['invalid_ocr_structure'])
  await assert.rejects(analyzeOcrWithQuality(binary, {
    name: 'mistral', create: () => fakeProvider('mistral', new Error('MISTRAL_OCR_FAILED:503:SECRET BODY'), []),
  }, () => { throw new Error('No fallback por indisponibilidad') }), (error) => {
    assert.equal(error.attempts.length, 1)
    assert.doesNotMatch(JSON.stringify(error), /SECRET BODY/)
    return true
  })
})

test('Azure sin credenciales o con fallo no expone datos técnicos y mantiene ambos intentos', async () => {
  for (const azureError of [new providers.ProviderConfigurationError('Azure', ['SECRET_VARIABLE']), new Error('AZURE_OCR_START_FAILED:500:SECRET BODY')]) {
    await assert.rejects(analyzeOcrWithQuality(binary, {
      name: 'mistral', create: () => fakeProvider('mistral', corrupt(), []),
    }, () => { throw azureError }), (error) => {
      assert.equal(error.message, OCR_QUALITY_MESSAGE)
      assert.equal(error.attempts.length, 2)
      assert.doesNotMatch(JSON.stringify(error), /SECRET_VARIABLE|SECRET BODY/)
      return true
    })
  }
})

test('adaptadores reales: markdown aberrante de Mistral activa Azure prebuilt-layout con el mismo archivo', async (t) => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    requests.push(String(url))
    if (String(url) === 'https://api.mistral.ai/v1/ocr') {
      assert.equal(JSON.parse(init.body).document.image_url, 'data:image/jpeg;base64,AQID')
      return Response.json({ model: 'mistral-ocr-test', pages: [{
        index: 0, markdown: JSON.stringify(Array.from({ length: 20 }, () => ({
          box_2d: [1, 2, 3, 4], label: 'aside_text', caption: 'Coca-Cola Corporation San Francisco, California (415) 661-1001',
        }))), dimensions: { width: 1000, height: 1500 }, confidence_scores: { average_page_confidence_score: 0.96 },
      }] })
    }
    if (init.method === 'POST') {
      assert.equal(String(url), 'https://azure.example.test/documentintelligence/documentModels/prebuilt-layout:analyze?api-version=2024-11-30')
      assert.deepEqual(new Uint8Array(await init.body.arrayBuffer()), binary.bytes)
      return new Response(null, { status: 202, headers: { 'operation-location': 'https://azure.example.test/operations/1' } })
    }
    assert.equal(String(url), 'https://azure.example.test/operations/1')
    return Response.json({ status: 'succeeded', analyzeResult: {
      content: fixture.ocr.text,
      pages: [{ pageNumber: 1, width: 1000, height: 1500, lines: fixture.ocr.text.split('\n').map((content) => ({ content })), words: [{ content: 'Factura', confidence: 0.9 }] }],
    } })
  })
  const selection = { provider: 'mistral', mistral: { apiKey: 'mistral-test' }, azure: { endpoint: 'https://azure.example.test', apiKey: 'azure-test' } }
  const result = await analyzeOcrWithQuality(binary, {
    name: 'mistral', create: () => providers.createDocumentOcrProvider(selection),
  }, () => providers.createDocumentOcrProvider({ ...selection, provider: 'azure' }))
  assert.equal(result.ocr.provider, 'azure')
  assert.equal(result.ocr.text, fixture.ocr.text)
  assert.ok(result.attempts[0].sanityReasons.includes('dominant_visual_detection_json'))
  assert.equal(requests.length, 3, 'un POST Mistral, un POST Azure y una consulta de resultado')
})

// Execute the real Edge entry point with in-memory storage/providers; no database,
// credentials, network calls or changes to the parser/matching implementations.
const edgeSource = await readFile(new URL('../supabase/functions/process-supplier-document/index.ts', import.meta.url), 'utf8')
const compiledEdge = ts.transpileModule(edgeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText

async function processWithOcr(mistral, azure, interpretationError = null) {
  const document = {
    id: 'document', tenant_id: 'tenant', venue_id: 'venue', supplier_id: null,
    document_type: 'delivery_note', status: 'processing', storage_bucket: 'documents', storage_path: 'document.jpg',
    original_file_name: 'document.jpg', original_mime_type: 'image/jpeg', extraction_metadata: {},
    ocr_snapshot: corrupt(), // Previous corrupt snapshot must not survive rejection.
  }
  const writes = []
  const calls = { ocr: [], ai: 0, parser: 0, matching: 0, profiles: 0 }
  const tablesRead = []
  const lineRows = []
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'user' } }, error: null }) },
    storage: { from: () => ({ download: async () => ({ data: new Blob([binary.bytes]), error: null }) }) },
    from(table) {
      let write = null
      let insert = null
      const query = {
        select() { tablesRead.push(table); return this },
        eq() { return this }, neq() { return this }, in() { return this }, order() { return this }, ilike() { return this },
        update(value) { write = value; return this },
        insert(value) { insert = value; return this },
        delete() { return this },
        maybeSingle() { return this }, single() { return this },
        then(resolve, reject) {
          if (write && table === 'supplier_documents') { writes.push(structuredClone(write)); Object.assign(document, write) }
          if (insert && table === 'supplier_document_lines') lineRows.push(...insert)
          const data = table === 'supplier_documents' ? structuredClone(document) : []
          return Promise.resolve({ data, error: null }).then(resolve, reject)
        },
      }
      return query
    },
  }
  const wrappedCore = {
    ...core,
    runDeterministicParser(...args) { calls.parser++; return core.runDeterministicParser(...args) },
    resolveSupplierCandidate(...args) { calls.matching++; return core.resolveSupplierCandidate(...args) },
  }
  const wrappedProviders = {
    ...providers,
    createDocumentOcrProvider(selection) {
      assert.equal(selection.azure.endpoint, 'azure-endpoint')
      assert.equal(selection.azure.modelId, 'prebuilt-layout')
      const name = selection.provider
      return { name, analyze: async () => {
        calls.ocr.push(name)
        const output = name === 'mistral' ? mistral : azure
        if (output instanceof Error) throw output
        return output
      } }
    },
    OpenAiSupplierDocumentProvider: class {
      async interpret() {
        calls.ai++
        if (interpretationError) throw interpretationError
        return structuredClone(fixture.extraction)
      }
      async proposeProfile() { calls.profiles++; return fixture.knownProfile }
    },
  }
  const modules = {
    'https://esm.sh/@supabase/supabase-js@2.110.0': { createClient: () => client },
    '../_shared/supplier-documents/core.ts': wrappedCore,
    '../_shared/supplier-documents/providers.ts': wrappedProviders,
    '../_shared/supplier-documents/fixtures.ts': fixtures,
    '../_shared/supplier-documents/ocrQuality.ts': quality,
  }
  let handler
  const tasks = []
  const env = { SUPABASE_URL: 'url', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', SUPPLIER_DOCUMENT_OCR_PROVIDER: 'mistral', AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: 'azure-endpoint', AZURE_DOCUMENT_INTELLIGENCE_MODEL_ID: 'prebuilt-layout' }
  new Function('require', 'exports', 'Deno', 'EdgeRuntime', 'console', compiledEdge)(
    (name) => { assert.ok(modules[name], name); return modules[name] }, {},
    { env: { get: (key) => env[key] }, serve: (callback) => { handler = callback } },
    { waitUntil: (task) => tasks.push(task) }, { error() {} },
  )
  const response = await handler(new Request('https://example.test/process', {
    method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId: document.id }),
  }))
  assert.equal(response.status, 202)
  await Promise.all(tasks)
  return { document, writes, calls, tablesRead, lineRows }
}

test('ambos rechazados: la Edge persiste error, dos intentos y ningún snapshot; no llega a GPT/parser/matching/perfiles', async () => {
  const result = await processWithOcr(corrupt(), ocrText('', 'azure'))
  assert.equal(result.document.status, 'error')
  assert.equal(result.document.extraction_metadata.code, 'OCR_QUALITY_TOO_LOW')
  assert.equal(result.document.extraction_metadata.message, OCR_QUALITY_MESSAGE)
  assert.equal(result.document.ocr_snapshot, null)
  assert.equal(result.document.extraction_metadata.ocrAttempts.length, 2)
  assert.deepEqual(result.calls, { ocr: ['mistral', 'azure'], ai: 0, parser: 0, matching: 0, profiles: 0 })
  assert.ok(result.tablesRead.every((table) => table === 'supplier_documents'))
  assert.equal(result.lineRows.length, 0)
  assert.ok(result.writes.every((write) => !write.ocr_snapshot))
})

test('fallback aceptado: la Edge continúa a revisión y persiste exclusivamente Azure con ambos intentos', async () => {
  const azure = normal('azure')
  const result = await processWithOcr(corrupt(), azure)
  assert.equal(result.document.status, 'review')
  assert.deepEqual(result.document.ocr_snapshot, azure)
  assert.deepEqual(result.calls.ocr, ['mistral', 'azure'])
  assert.equal(result.calls.ai, 1)
  assert.equal(result.document.extraction_metadata.ocrProvider, 'azure')
  assert.equal(result.document.extraction_metadata.ocrFallbackUsed, true)
  assert.deepEqual(result.document.extraction_metadata.ocrAttempts.map((attempt) => attempt.accepted), [false, true])
  assert.ok(result.writes.filter((write) => write.ocr_snapshot).every((write) => write.ocr_snapshot.provider === 'azure'))
})

test('factura normal: el mismo parser produce las mismas líneas con Mistral sin Azure', async () => {
  const result = await processWithOcr(normal(), null)
  assert.equal(result.document.status, 'review')
  assert.deepEqual(result.calls.ocr, ['mistral'])
  assert.equal(result.document.extraction_metadata.ocrFallbackUsed, false)
  assert.equal(result.lineRows.length, fixture.extraction.lines.length)
  assert.deepEqual(result.lineRows.map((line) => line.description_raw), fixture.extraction.lines.map((line) => line.description))
  assert.deepEqual(result.lineRows.map((line) => line.quantity), fixture.extraction.lines.map((line) => line.quantity))
  assert.deepEqual(result.lineRows.map((line) => line.line_total), fixture.extraction.lines.map((line) => line.lineTotal))
})

test('un fallo posterior del parser conserva el diagnóstico OCR y el snapshot aceptado', async () => {
  const azure = normal('azure')
  const result = await processWithOcr(corrupt(), azure, new Error('INTERPRETATION_FAILED'))
  assert.equal(result.document.status, 'error')
  assert.equal(result.document.extraction_metadata.ocrAttempts.length, 2)
  assert.deepEqual(result.document.ocr_snapshot, azure)
})

test('UI de calidad usa mensaje seguro y Volver a escanear abre captura sin reintentar el mismo OCR', async () => {
  const page = await readFile(new URL('../src/features/crm/supplier-documents/pages/SupplierReceiptsPage.tsx', import.meta.url), 'utf8')
  assert.match(page, /ocrQualityFailed \? OCR_QUALITY_MESSAGE : error/)
  const button = page.match(/ocrQualityFailed \? \([\s\S]*?Volver a escanear/)?.[0] ?? ''
  assert.match(button, /setDetail\(null\)/)
  assert.match(button, /setScreen\("capture"\)/)
  assert.doesNotMatch(button, /retrySupplierDocumentProcessing/)
})
