import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

test('typecheck de la revisión de proveedor y sus dependencias con la configuración de la app', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const configFile = ts.readConfigFile(path.join(root, 'tsconfig.app.json'), ts.sys.readFile)
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root)
  const program = ts.createProgram([
    path.join(root, 'src/features/crm/supplier-documents/pages/SupplierReceiptsPage.tsx'),
  ], config.options)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }))
})

test('typecheck de la Edge Function y providers sin red ni runtime Deno', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const entry = path.join(root, 'supabase/functions/process-supplier-document/index.ts')
  const virtualGlobals = path.join(root, '__supplier_edge_globals__.d.ts').replaceAll('\\', '/')
  const globals = 'declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): void };'
  const options = {
    noEmit: true, strict: true, skipLibCheck: true, allowImportingTsExtensions: true,
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  }
  const host = ts.createCompilerHost(options)
  const fileExists = host.fileExists.bind(host)
  host.fileExists = (name) => name.replaceAll('\\', '/') === virtualGlobals || fileExists(name)
  const readSource = host.getSourceFile.bind(host)
  host.getSourceFile = (name, languageVersion, ...rest) => name.replaceAll('\\', '/') === virtualGlobals
    ? ts.createSourceFile(name, globals, languageVersion)
    : readSource(name, languageVersion, ...rest)
  host.resolveModuleNames = (names, containingFile) => names.map((name) => ts.resolveModuleName(
    name.startsWith('https://esm.sh/@supabase/supabase-js@') ? '@supabase/supabase-js' : name,
    containingFile, options, host,
  ).resolvedModule)
  const program = ts.createProgram([entry, virtualGlobals], options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }))
})
