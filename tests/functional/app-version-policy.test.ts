import { describe, expect, it } from 'vitest'
import { resolveAppVersionStatus } from '../../src/config/appVersion'

describe('additive deployed version manifest', () => {
  it('keeps existing compatible PWAs usable when currentVersion identifies a newer build', () => {
    const older = 'a'.repeat(40)
    const current = 'b'.repeat(40)
    const policy = { currentVersion: current, supportedVersions: [older, current] }
    expect(resolveAppVersionStatus(older, policy)).toBe('compatible')
    expect(resolveAppVersionStatus(current, policy)).toBe('compatible')
    expect(resolveAppVersionStatus('c'.repeat(40), policy)).toBe('update-required')
  })
})
