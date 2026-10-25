import { z } from 'zod'

const component = z
  .object({
    id: z.uuid(),
    selectionGroupId: z.uuid(),
    productId: z.uuid(),
    variantId: z.uuid().optional(),
    quantity: z.number().int().min(1).max(100),
    modifiers: z
      .array(z.object({ id: z.uuid() }).strict())
      .max(30)
      .default([]),
  })
  .strict()
export const orderSchema = z
  .object({
    sessionToken: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.uuid(),
    lines: z
      .array(
        z
          .object({
            productId: z.uuid(),
            variantId: z.uuid(),
            quantityMilli: z.number().int().min(1).max(9999000),
            modifierOptionIds: z
              .array(z.uuid())
              .max(30)
              .refine((ids) => new Set(ids).size === ids.length),
            components: z.array(component).max(50).default([]),
            note: z.string().trim().max(500).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict()
export const sessionSchema = z.object({ tableToken: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const tableLinkSchema = z.object({ tableId: z.uuid() }).strict()
