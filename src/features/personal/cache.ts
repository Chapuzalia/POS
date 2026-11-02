import type { TenantContext } from '../../types'
import { personalStateSchema } from '../../../apps/api/src/personal-contracts'
import type { PersonalState } from '../../../apps/api/src/personal-contracts'

export function personalCacheKey(context: TenantContext) {
  return `club-pos:personal:v1:pos:${context.tenantId}:${context.venueId}:${context.deviceId}:${context.userId}`
}

export function readPersonalCache(storage: Pick<Storage, 'getItem'>, key: string): PersonalState | null {
  try {
    const parsed = personalStateSchema.safeParse(JSON.parse(storage.getItem(key) ?? 'null'))
    return parsed.success ? parsed.data : null
  } catch { return null }
}

export function savePersonalCache(storage: Pick<Storage, 'setItem'>, key: string, state: PersonalState) {
  storage.setItem(key, JSON.stringify(personalStateSchema.parse(state)))
}
