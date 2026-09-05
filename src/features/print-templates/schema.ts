import { z } from 'zod'
import { PRINT_TEMPLATE_TYPES } from './types.ts'

const conditionFields = {
  id: z.string().trim().min(1).max(100),
  when: z.string().trim().min(1).max(200).optional(),
  unless: z.string().trim().min(1).max(200).optional(),
}

const styleFields = {
  align: z.enum(['left', 'center', 'right']).optional(),
  bold: z.boolean().optional(),
  size: z.enum(['normal', 'large']).optional(),
}

export const printTemplateTypeSchema = z.enum(PRINT_TEMPLATE_TYPES)

export const printTemplateBlockSchema: z.ZodType<import('./types.ts').PrintTemplateBlock> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ ...conditionFields, ...styleFields, type: z.literal('text'), value: z.string().max(1_000) }).strict(),
    z.object({ ...conditionFields, ...styleFields, type: z.literal('row'), label: z.string().max(500), value: z.string().max(500) }).strict(),
    z.object({ ...conditionFields, type: z.literal('separator'), character: z.string().max(1).optional() }).strict(),
    z.object({ ...conditionFields, type: z.literal('spacer'), lines: z.number().int().min(1).max(10).optional() }).strict(),
    z.object({ ...conditionFields, type: z.literal('repeat'), source: z.string().trim().min(1).max(200), blocks: z.array(printTemplateBlockSchema).min(1).max(200) }).strict(),
    z.object({ ...conditionFields, type: z.literal('qr'), value: z.string().max(4_096), qrSize: z.number().int().min(1).max(16).optional() }).strict(),
  ]),
)

export const printTemplateDefinitionSchema = z.object({
  version: z.literal(1),
  blocks: z.array(printTemplateBlockSchema).min(1).max(200),
}).strict().superRefine((definition, context) => {
  let total = 0
  const visit = (blocks: import('./types.ts').PrintTemplateBlock[], depth: number) => {
    if (depth > 8) {
      context.addIssue({ code: 'custom', message: 'La plantilla supera el máximo de ocho niveles anidados.', path: ['blocks'] })
      return
    }
    total += blocks.length
    for (const block of blocks) if (block.type === 'repeat') visit(block.blocks, depth + 1)
  }
  visit(definition.blocks, 0)
  if (total > 1_000) context.addIssue({ code: 'custom', message: 'La plantilla supera el máximo de 1.000 bloques.', path: ['blocks'] })
})
