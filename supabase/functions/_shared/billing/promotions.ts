import { buildContract } from './domain.ts'
import type { AddonPromotion, CommercialException, Contract, Interval, Product, Selection, Version } from './domain.ts'

export type PromotionPhase = { start: number; end: number; contract: Contract; discounts: Array<{ coupon: string }> | '' }
export type PromotionPreview = {
  id: string; key: string; freeUnits: number; activationAt: string; endsAt: string; firstChargeAt: string | null
  regularUnitCents: number; firstAddonChargeCents: number; firstInvoiceCents: number; prorated: false
}

// Calendar months, UTC, clamped at month end (Jan 31 + 1 month = Feb 28/29).
export function addMonths(at: number, months: number) {
  const date = new Date(at * 1000), day = date.getUTCDate()
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + months)
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  date.setUTCDate(Math.min(day, lastDay))
  return Math.floor(date.getTime() / 1000)
}

export function shiftRenewal(renewal: number, cycles: number, interval: Interval, anchor = renewal) {
  const date = new Date(renewal * 1000), origin = new Date(anchor * 1000)
  const offset = (date.getUTCFullYear() - origin.getUTCFullYear()) * 12 + date.getUTCMonth() - origin.getUTCMonth()
  return addMonths(anchor, offset + cycles * (interval === 'year' ? 12 : 1))
}

export function renewalOnOrAfter(at: number, renewal: number, interval: Interval, anchor = renewal) {
  for (let n = 0; n <= 500; n++) {
    const boundary = shiftRenewal(renewal, n, interval, anchor)
    if (boundary >= at) return boundary
  }
  throw new Error('BILLING_INVALID_PROMOTION_DATE')
}

export function resolvePromotions(requested: AddonPromotion[], previous: AddonPromotion[], selection: Selection, now: number, renewal: number, interval: Interval, anchor = renewal) {
  const ids = new Set<string>(), keys = new Set<string>()
  return requested.map(promotion => {
    if (ids.has(promotion.id) || keys.has(promotion.key) || !Number.isSafeInteger(promotion.freeUnits) || promotion.freeUnits < 1 || !Number.isSafeInteger(promotion.duration) || promotion.duration < 1 || promotion.duration > 36 || !promotion.consent.trim()) throw new Error('BILLING_INVALID_PROMOTION')
    ids.add(promotion.id); keys.add(promotion.key)
    const existing = previous.find(row => row.id === promotion.id)
    if (existing) {
      for (const field of ['key','freeUnits','start','durationUnit','duration','consent'] as const) if (promotion[field] !== existing[field]) throw new Error('BILLING_INVALID_PROMOTION_IMMUTABLE')
      return existing
    }
    const addon = selection.addons.find(row => row.key === promotion.key)
    if (!addon || addon.quantity < promotion.freeUnits) throw new Error('BILLING_INVALID_PROMOTION_ADDON')
    const startsAt = promotion.start === 'immediate' ? now : renewal
    // Immediate cycles include the remaining current period plus N complete cycles.
    const endsAt = promotion.durationUnit === 'months' ? addMonths(startsAt, promotion.duration) : shiftRenewal(renewal, promotion.duration, interval, anchor)
    return { ...promotion, startsAt, endsAt, consentRecordedAt: new Date(now * 1000).toISOString() }
  })
}

export function promotionPhases(products: Product[], versions: Version[], selection: Selection, exception: CommercialException, current: Contract, effective: number, phaseStart: number, now: number, renewal: number) {
  const boundaries = [...new Set([phaseStart, ...(effective > now ? [effective] : []), ...(exception.promotions ?? []).flatMap(p => [p.startsAt ?? 0, p.endsAt ?? 0]).filter(at => at > now)])].sort((a,b) => a-b)
  // A final standard phase releases the schedule while keeping the subscription.
  boundaries.push(addMonths(boundaries.at(-1) ?? renewal, (versions.find(v => v.id === selection.planVersionId)?.interval === 'year' ? 12 : 1)))
  if (boundaries.length - 1 > 10) throw new Error('BILLING_INVALID_PROMOTION_PHASE_LIMIT')
  return boundaries.slice(0,-1).map((start,index): PromotionPhase => ({ start, end: boundaries[index+1], contract: Math.max(start, now) < effective ? current : buildContract(products, versions, selection, exception, Math.max(start, now)), discounts: '' }))
}
