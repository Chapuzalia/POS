import type { PrinterLayout } from '../local-printing/types.ts'
import {
  adaptTextToCharacterSet,
  centerReceiptText,
  createSeparator,
  formatWrappedReceiptRow,
  wrapReceiptText,
} from '../local-printing/services/receiptFormatters.ts'
import type {
  PrintTemplateBlock,
  PrintTemplateContext,
  PrintTemplateDefinition,
  RenderedTemplateElement,
} from './types.ts'

const variablePattern = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/gu
const safePathPattern = /^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/u

export function renderPrintTemplate(
  definition: PrintTemplateDefinition,
  context: PrintTemplateContext,
  layout: PrinterLayout,
) {
  const elements: RenderedTemplateElement[] = []
  renderBlocks(definition.blocks, context, context, layout, elements, 0)
  if (!elements.length) elements.push({ type: 'text', value: '' })
  if (elements.length > 1_000) throw new Error('La plantilla genera más de 1.000 instrucciones de impresión.')
  return {
    elements,
    lines: elements.map((element) => {
      if (element.type === 'qr') return element.data
      if (!element.value) return ''
      if (element.align === 'center') return centerReceiptText(element.value, layout.columns, layout.characterSet)
      if (element.align === 'right') return element.value.padStart(layout.columns)
      return element.value
    }),
  }
}

export function renderPrintTemplateWithFallback(
  definition: PrintTemplateDefinition,
  fallback: PrintTemplateDefinition,
  context: PrintTemplateContext,
  layout: PrinterLayout,
) {
  try {
    const rendered = renderPrintTemplate(definition, context, layout)
    if (rendered.elements.some((element) => element.type === 'qr' || element.value.trim())) return rendered
  } catch {
    // Invalid venue overrides fall through to the safe built-in document.
  }
  return renderPrintTemplate(fallback, context, layout)
}

function renderBlocks(
  blocks: PrintTemplateBlock[],
  root: PrintTemplateContext,
  scope: unknown,
  layout: PrinterLayout,
  output: RenderedTemplateElement[],
  depth: number,
) {
  if (depth > 8) throw new Error('La plantilla supera el máximo de ocho niveles anidados.')
  for (const block of blocks) {
    if (!isVisible(block, root, scope)) continue
    if (block.type === 'repeat') {
      const collection = resolvePath(block.source, root, scope)
      if (!Array.isArray(collection)) continue
      for (const item of collection) renderBlocks(block.blocks, root, item, layout, output, depth + 1)
      continue
    }
    if (block.type === 'separator') {
      output.push({ type: 'text', value: createSeparator(layout.columns, block.character) })
      continue
    }
    if (block.type === 'spacer') {
      for (let index = 0; index < (block.lines ?? 1); index += 1) output.push({ type: 'text', value: '' })
      continue
    }
    if (block.type === 'qr') {
      const data = interpolate(block.value, root, scope).trim()
      if (data) output.push({ type: 'qr', data, size: block.qrSize ?? 6, errorCorrection: 'M' })
      continue
    }
    if (block.type === 'row') {
      const label = interpolate(block.label, root, scope)
      const value = interpolate(block.value, root, scope)
      for (const line of formatWrappedReceiptRow({ label, value, width: layout.columns, characterSet: layout.characterSet })) {
        output.push(styledText(line, block, layout.characterSet))
      }
      continue
    }
    const value = interpolate(block.value, root, scope)
    for (const line of wrapTemplateText(value, layout)) {
      output.push(styledText(line, block, layout.characterSet))
    }
  }
}

function styledText(value: string, block: Extract<PrintTemplateBlock, { type: 'text' | 'row' }>, characterSet: string): RenderedTemplateElement {
  return {
    type: 'text',
    value: adaptTextToCharacterSet(value, characterSet),
    ...(block.align && block.align !== 'left' ? { align: block.align } : {}),
    ...(block.bold ? { bold: true } : {}),
    ...(block.size && block.size !== 'normal' ? { size: block.size } : {}),
  }
}

function wrapTemplateText(value: string, layout: PrinterLayout) {
  const safe = adaptTextToCharacterSet(value, layout.characterSet)
  const prefix = safe.match(/^ +/u)?.[0] ?? ''
  if (!prefix) return wrapReceiptText(safe, layout.columns, layout.characterSet)
  const width = Math.max(1, layout.columns - prefix.length)
  return wrapReceiptText(safe.slice(prefix.length), width, layout.characterSet).map((line) => `${prefix}${line}`)
}

function isVisible(block: PrintTemplateBlock, root: PrintTemplateContext, scope: unknown) {
  if (block.when && !truthy(resolvePath(block.when, root, scope))) return false
  if (block.unless && truthy(resolvePath(block.unless, root, scope))) return false
  return true
}

function truthy(value: unknown) {
  return Array.isArray(value) ? value.length > 0 : Boolean(value)
}

export function interpolatePrintTemplate(value: string, root: PrintTemplateContext, scope: unknown = root) {
  return interpolate(value, root, scope)
}

function interpolate(value: string, root: PrintTemplateContext, scope: unknown) {
  return value.replace(variablePattern, (_match, path: string) => printable(resolvePath(path, root, scope)))
}

function printable(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : ''
}

function resolvePath(path: string, root: PrintTemplateContext, scope: unknown) {
  if (!safePathPattern.test(path)) return undefined
  if (path.split('.').some((segment) => ['__proto__', 'prototype', 'constructor'].includes(segment))) return undefined
  const fromScope = readPath(scope, path)
  return fromScope === undefined ? readPath(root, path) : fromScope
}

function readPath(value: unknown, path: string) {
  let current = value
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}
