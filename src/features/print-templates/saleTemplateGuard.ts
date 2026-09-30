import { getSafeDefaultPrintTemplate, SALE_TEMPLATE_SLOTS, type SaleTemplateSlot } from './defaults.ts'
import type { PrintTemplateBlock, PrintTemplateDefinition, PrintTemplateType } from './types.ts'

/** Tipos de plantilla con estructura fiscal obligatoria. */
export const REGULATED_SALE_TEMPLATE_TYPES = ['simplified_invoice', 'invoice'] as const
export type RegulatedSaleTemplateType = (typeof REGULATED_SALE_TEMPLATE_TYPES)[number]

type PrintTemplateTextBlock = Extract<PrintTemplateBlock, { type: 'text' }>
type SlotCustomizations = Record<SaleTemplateSlot, PrintTemplateBlock[]>

const MAX_CUSTOM_TEXT_BLOCKS = 20
const MAX_CUSTOM_TEXT_LENGTH = 240
const templateVariablePattern = /\{\{|\}\}/u
const reservedLiteralMarkers = ['verifactu']
const slotIdPattern = /^custom-text:([a-z_]+):(\d+)$/u
const insertionAnchors: Record<SaleTemplateSlot, string | undefined> = {
  top: 'fiscal-top-gap',
  after_issuer: 'venue-address',
  after_document: 'ticket-date',
  before_items: 'customer-country',
  after_items: 'items',
  after_totals: 'totals',
  bottom: undefined,
}

export function isRegulatedSaleTemplateType(type: PrintTemplateType): type is RegulatedSaleTemplateType {
  return type === 'simplified_invoice' || type === 'invoice'
}

function normalizeLiteral(value: string) {
  return value.replace(/\s+/gu, ' ').trim().toLowerCase()
}

function collectStructuralLiterals(blocks: PrintTemplateBlock[], into: Set<string>, depth = 0) {
  if (depth > 8) return
  for (const block of blocks) {
    if (block.type === 'text') into.add(normalizeLiteral(block.value))
    else if (block.type === 'row') {
      into.add(normalizeLiteral(block.label))
      into.add(normalizeLiteral(block.value))
    } else if (block.type === 'repeat') collectStructuralLiterals(block.blocks, into, depth + 1)
  }
}

function collectStructuralIds(blocks: PrintTemplateBlock[], into: Set<string>, depth = 0) {
  if (depth > 8) return
  for (const block of blocks) {
    into.add(block.id)
    if (block.type === 'repeat') collectStructuralIds(block.blocks, into, depth + 1)
  }
}

function normalizeSlot(id: string): SaleTemplateSlot | null {
  const match = slotIdPattern.exec(id)
  return match && SALE_TEMPLATE_SLOTS.includes(match[1] as SaleTemplateSlot) ? match[1] as SaleTemplateSlot : null
}

export function extractSafeSaleCustomization(
  definition: PrintTemplateDefinition | undefined,
  structural: PrintTemplateDefinition,
): SlotCustomizations {
  const customizations = Object.fromEntries(SALE_TEMPLATE_SLOTS.map((slot) => [slot, []])) as unknown as SlotCustomizations
  if (!definition) return customizations

  const usedLiterals = new Set<string>()
  collectStructuralLiterals(structural.blocks, usedLiterals)
  const structuralIds = new Set<string>()
  collectStructuralIds(structural.blocks, structuralIds)
  const usedIds = new Set<string>()
  let count = 0

  for (const block of definition.blocks) {
    if (count >= MAX_CUSTOM_TEXT_BLOCKS || block.type !== 'text') continue
    const literal = block.value.trim()
    const normalized = normalizeLiteral(literal)
    if (!literal || literal.length > MAX_CUSTOM_TEXT_LENGTH || templateVariablePattern.test(literal)
      || block.when || block.unless || reservedLiteralMarkers.some((marker) => normalized.includes(marker)) || usedLiterals.has(normalized)) continue

    const requestedSlot = normalizeSlot(block.id)
    const slot = requestedSlot ?? 'bottom'
    const id = !structuralIds.has(block.id) && !usedIds.has(block.id)
      ? block.id
      : `custom-text:${slot}:${customizations[slot].length + 1}`
    const safeBlock: PrintTemplateTextBlock = { id, type: 'text', value: literal }
    if (block.align) safeBlock.align = block.align
    if (block.bold) safeBlock.bold = true
    if (block.size) safeBlock.size = block.size
    customizations[slot].push(safeBlock)
    usedLiterals.add(normalized)
    usedIds.add(id)
    count += 1
  }
  return customizations
}

function assembleSaleTemplate(structural: PrintTemplateDefinition, customizations: SlotCustomizations): PrintTemplateDefinition {
  const blocks: PrintTemplateBlock[] = []
  for (const block of structural.blocks) {
    blocks.push(block)
    for (const slot of SALE_TEMPLATE_SLOTS) {
      if (insertionAnchors[slot] === block.id) blocks.push(...customizations[slot])
    }
  }
  blocks.push(...customizations.bottom)
  return { version: 1, blocks }
}

export function resolveSafeTemplateDefinition(
  type: PrintTemplateType,
  definition: PrintTemplateDefinition | undefined,
): PrintTemplateDefinition {
  const structural = getSafeDefaultPrintTemplate(type)
  if (!isRegulatedSaleTemplateType(type)) return definition ?? structural
  return assembleSaleTemplate(structural, extractSafeSaleCustomization(definition, structural))
}
