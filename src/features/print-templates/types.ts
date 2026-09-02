export const PRINT_TEMPLATE_TYPES = [
  'simplified_invoice',
  'invoice',
  'cash_closure',
  'production',
  'kds',
  'test',
] as const

export type PrintTemplateType = typeof PRINT_TEMPLATE_TYPES[number]
export type PrintTemplateAlign = 'left' | 'center' | 'right'
export type PrintTemplateSize = 'normal' | 'large'

type ConditionalBlock = {
  id: string
  when?: string
  unless?: string
}

type StyledBlock = ConditionalBlock & {
  align?: PrintTemplateAlign
  bold?: boolean
  size?: PrintTemplateSize
}

export type PrintTemplateBlock =
  | (StyledBlock & { type: 'text'; value: string })
  | (StyledBlock & { type: 'row'; label: string; value: string })
  | (ConditionalBlock & { type: 'separator'; character?: string })
  | (ConditionalBlock & { type: 'spacer'; lines?: number })
  | (ConditionalBlock & { type: 'repeat'; source: string; blocks: PrintTemplateBlock[] })
  | (ConditionalBlock & { type: 'qr'; value: string; qrSize?: number })

export type PrintTemplateDefinition = {
  version: 1
  blocks: PrintTemplateBlock[]
}

export type PrintTemplateContext = Record<string, unknown>

export type RenderedTemplateElement =
  | { type: 'text'; value: string; align?: PrintTemplateAlign; bold?: boolean; size?: PrintTemplateSize }
  | { type: 'qr'; data: string; size?: number; errorCorrection?: 'L' | 'M' | 'Q' | 'H' }

export type ResolvedPrintTemplate = {
  definition: PrintTemplateDefinition
  isCustom: boolean
  source: 'custom' | 'database-default' | 'safe-default'
  type: PrintTemplateType
}
