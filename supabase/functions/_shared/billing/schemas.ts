import { z } from 'npm:zod@4.4.3'

const quantity = z.number().int().min(0).max(100_000)
const key = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/)
const recordQuantity = z.record(key, quantity)
const billingAddressSchema = z.object({
  street: z.string().trim().min(1).max(200), postalCode: z.string().trim().min(1).max(20),
  city: z.string().trim().min(1).max(100), province: z.string().trim().max(100), countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
}).strict()
const billingProfileSchema = z.object({ legalName: z.string().trim().min(1).max(200), taxId: z.string().trim().min(1).max(40), email: z.email(), address: billingAddressSchema }).strict()
export const selectionSchema = z.object({
  planVersionId: z.uuid(),
  addons: z.array(z.object({ key, versionId: z.uuid(), quantity, venueIds: z.array(z.uuid()).max(1000), deviceIds: z.array(z.uuid()).max(1000) }).strict()).max(19),
}).strict()
export const exceptionSchema = z.object({
  freeUnits: recordQuantity,
  limits: z.object({ venues: quantity.optional(), devices: quantity.optional() }).strict(),
  discountBasisPoints: z.number().int().min(0).max(10_000),
  customAmounts: z.record(key, z.number().int().min(0).max(100_000_000)),
  cycles: z.number().int().min(1).max(36).nullable(),
  reason: z.string().trim().min(1).max(500),
  promotions: z.array(z.object({
    id: z.uuid(), key, freeUnits: quantity.min(1), start: z.enum(['immediate','period_end']),
    durationUnit: z.enum(['months','cycles']), duration: quantity.min(1).max(36),
    consent: z.string().trim().min(1).max(500),
    startsAt: z.number().int().positive().optional(), endsAt: z.number().int().positive().optional(),
    consentRecordedAt: z.string().optional(),
  }).strict()).max(8).optional(),
}).strict()
export const productSchema = z.object({
  key, kind: z.enum(['plan','addon']), name: z.string().trim().min(1).max(120), description: z.string().max(2000),
  scope: z.enum(['tenant','venue','device']), featureKey: key.nullable(), resource: z.enum(['venues','devices']).nullable(),
  active: z.boolean(), sortOrder: z.number().int().min(0).max(10000),
}).strict().refine(product => product.scope !== 'device' || product.featureKey === null, 'Los permisos actuales son por empresa/local; los dispositivos solo pueden ampliar capacidad.')
  .refine(product => product.featureKey !== 'tickit_assist' || product.scope === 'tenant', 'Tickit Assist conserva su contrato por empresa y sus controles operativos por local.')
  .refine(product => product.featureKey !== 'tickit_personal' || product.scope === 'tenant', 'Tickit Personal se contrata por empresa.')
  .refine(product => product.kind !== 'plan' || (product.scope === 'tenant' && product.featureKey === null && product.resource === null), 'El plan base se contrata por empresa.')
  .refine(product => product.scope !== 'venue' || product.featureKey === null || ['analytics_advanced','restaurant','reservations','production','inventory','costing','purchases','document_ai','promotions','cashlogy'].includes(product.featureKey), 'La funcionalidad no admite asignación comercial por local.')
export const versionSchema = z.object({
  interval: z.enum(['month','year']), amountCents: z.number().int().min(0).max(100_000_000),
  features: z.array(key).max(100), limits: z.object({ venues: quantity.min(1), devices: quantity }).strict(),
  included: recordQuantity, maximum: quantity.nullable(), requires: z.array(key).max(20),
}).strict()
export const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('overview') }).strict(),
  z.object({ action: z.literal('catalog') }).strict(),
  z.object({ action: z.literal('integrations') }).strict(),
  // Omitted fields keep the saved value; keys are write-only.
  z.object({ action: z.literal('integrations-save'),
    mollieApiKey: z.string().trim().regex(/^(live|test)_[A-Za-z0-9]{20,64}$/).optional(),
    odooUrl: z.url({ protocol: /^https$/ }).max(300).optional(),
    odooDb: z.string().trim().min(1).max(100).optional(),
    odooApiKey: z.string().trim().min(16).max(200).optional(),
  }).strict(),
  z.object({ action: z.literal('catalog-save'), product: productSchema, version: versionSchema.nullable(), reason: z.string().min(1).max(500) }).strict(),
  z.object({ action: z.literal('catalog-publish'), versionId: z.uuid() }).strict(),
  z.object({ action: z.literal('get'), tenantId: z.uuid() }).strict(),
  z.object({ action: z.literal('save-profile'), tenantId: z.uuid(), profile: billingProfileSchema }).strict(),
  z.object({ action: z.literal('save-onboarding'), tenantId: z.uuid(), selection: selectionSchema }).strict(),
  z.object({ action: z.literal('restart-checkout'), tenantId: z.uuid() }).strict(),
  z.object({ action: z.literal('portal'), tenantId: z.uuid() }).strict(),
  z.object({ action: z.literal('reconcile'), tenantId: z.uuid() }).strict(),
  z.object({ action: z.literal('invoice-document'), tenantId: z.uuid(), paymentId: z.string().regex(/^tr_[A-Za-z0-9]{4,40}$/), document: z.enum(['main', 'refund']) }).strict(),
  z.object({ action: z.literal('reconcile-batch') }).strict(),
  z.object({ action: z.literal('retry-event'), eventId: z.string().regex(/^(evt_|mollie:tr_)/).max(150) }).strict(),
  // The IBAN is forwarded to Mollie to create the SEPA mandate; it is never stored or logged.
  z.object({ action: z.literal('confirm'), tenantId: z.uuid(), operationId: z.uuid(),
    legal: z.object({ version: z.string().max(40), terms: z.boolean(), dpa: z.boolean(), businessRepresentative: z.boolean() }).strict().optional(),
    sepa: z.object({ accountHolder: z.string().trim().min(2).max(70), iban: z.string().max(42) }).strict().optional(),
    // Older installed clients may still send only name and NIF.
    payer: billingProfileSchema.partial({ email: true, address: true }).optional(),
    acceptLosses: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('change-mandate'), tenantId: z.uuid(), requestId: z.uuid(),
    sepa: z.object({ accountHolder: z.string().trim().min(2).max(70), iban: z.string().max(42) }).strict() }).strict(),
  z.object({ action: z.literal('retry-operation'), tenantId: z.uuid(), operationId: z.uuid() }).strict(),
  z.object({ action: z.literal('quote'), tenantId: z.uuid(), selection: selectionSchema, exception: exceptionSchema.nullable(), reason: z.string().trim().min(1).max(500),
    // Optional for N-1 clients: venues/devices to switch off at renewal or back on.
    access: z.object({ deactivateVenueIds: z.array(z.uuid()).max(1000), deactivateDeviceIds: z.array(z.uuid()).max(1000), reactivateVenueIds: z.array(z.uuid()).max(1000) }).strict().optional() }).strict(),
  z.object({ action: z.literal('quote-cancel'), tenantId: z.uuid(), immediate: z.boolean(), reason: z.string().trim().min(1).max(500) }).strict(),
  z.object({ action: z.literal('settings'), tenantId: z.uuid(), graceDays: quantity.max(365), legalName: z.string().max(200), taxId: z.string().max(40), email: z.email().or(z.literal('')), reason: z.string().min(1).max(500) }).strict(),
])
