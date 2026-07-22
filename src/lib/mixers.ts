import type { ProductLineSelection, TicketLineMixer, TicketLineModifier } from '../types'

const mixerModifierPrefix = 'mixer:'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuid(value: string) {
  return uuidPattern.test(value)
}

export function isLegacyMixerModifier(modifier: TicketLineModifier) {
  return modifier.groupId === 'mixer' || modifier.id.startsWith(mixerModifierPrefix)
}

export function splitLegacyMixerModifiers(
  modifiers: TicketLineModifier[] | null | undefined,
  mixerProductId: string | null = null,
  mixer: TicketLineMixer | null = null,
): ProductLineSelection {
  const safeModifiers = Array.isArray(modifiers) ? modifiers : []
  const legacyMixer = safeModifiers.find(isLegacyMixerModifier)
  const legacyProductId = legacyMixer?.id.startsWith(mixerModifierPrefix)
    ? legacyMixer.id.slice(mixerModifierPrefix.length)
    : null
  const resolvedProductId = mixerProductId ?? (legacyProductId && isUuid(legacyProductId) ? legacyProductId : null)

  return {
    modifiers: safeModifiers.filter((modifier) => !isLegacyMixerModifier(modifier)),
    components: resolvedProductId && (mixer || legacyMixer) ? [{
      id: `legacy-component:${resolvedProductId}`,
      type: 'mixer',
      selectionGroupId: null,
      selectionGroupName: 'Mixer',
      productId: resolvedProductId,
      variantId: mixer?.variantId ?? null,
      productName: mixer?.name ?? legacyMixer?.name ?? 'Mixer',
      variantName: '',
      quantity: 1,
      priceDeltaCents: mixer?.priceCents ?? legacyMixer?.priceCents ?? 0,
      sortOrder: 0,
    }] : [],
    mixerProductId: resolvedProductId,
    mixer: mixer ?? (resolvedProductId && legacyMixer ? {
      productId: resolvedProductId,
      name: legacyMixer.name,
      priceCents: legacyMixer.priceCents,
    } : null),
  }
}

export function getLineAdditionNames(
  modifiers: TicketLineModifier[],
  mixer: TicketLineMixer | null | undefined,
) {
  return [...modifiers.map((modifier) => modifier.name), ...(mixer ? [mixer.name] : [])]
}
