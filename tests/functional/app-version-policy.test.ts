import { describe, expect, it } from 'vitest'
import { resolveAppVersionStatus } from '../../src/config/appVersion'

describe('additive deployed version manifest', () => {
  const older = 'a'.repeat(40)
  const current = 'b'.repeat(40)

  it('offers an update to supported PWAs when currentVersion identifies a newer build', () => {
    const policy = { currentVersion: current, supportedVersions: [older, current] }
    expect(resolveAppVersionStatus(older, policy)).toBe('update-available')
    expect(resolveAppVersionStatus(current, policy)).toBe('compatible')
    expect(resolveAppVersionStatus('c'.repeat(40), policy)).toBe('update-required')
  })

  it('keeps legacy manifests without currentVersion compatible', () => {
    expect(resolveAppVersionStatus(older, { supportedVersions: [older, current] })).toBe('compatible')
  })
})
