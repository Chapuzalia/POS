import { z } from 'zod'

export const pinVerifierSchema = z.object({
  algorithm: z.literal('PBKDF2-SHA256'),
  iterations: z.literal(210000),
  salt: z.string().regex(/^[a-f0-9]{32}$/),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export const personalRuleSchema = z.object({
  allow: z.boolean(),
  max_percent: z.number().min(0).max(100).optional(),
  max_cents: z.number().int().safe().nonnegative().optional(),
}).strict()
export const staffSnapshotSchema = z.object({
  employee_id: z.uuid(), full_name: z.string().min(2).max(120),
  status: z.enum(['active', 'inactive', 'departed']), version: z.number().int().positive(),
  role_id: z.uuid().nullable(), venue_ids: z.array(z.uuid()).max(1000),
  policy_expires_at: z.iso.datetime({ offset: true }),
  policies: z.record(z.string(), z.record(z.string(), personalRuleSchema)),
  pin_verifier: pinVerifierSchema.nullable().optional(),
}).strict()
export const personalStateSchema = z.object({
  enabled: z.boolean(), connectionId: z.uuid().nullable(),
  staff: z.array(staffSnapshotSchema).max(10000),
}).strict()
export type PersonalRule = z.infer<typeof personalRuleSchema>
export type StaffSnapshot = z.infer<typeof staffSnapshotSchema>
export type PersonalState = z.infer<typeof personalStateSchema>
