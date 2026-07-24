import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('configuracion permite cambiar la contraseña del usuario CRM conectado', async () => {
  const [page, service] = await Promise.all([
    readFile(new URL('../src/features/crm/venues/pages/VenueSettingsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/settings/services/accountSettingsService.ts', import.meta.url), 'utf8'),
  ])

  assert.match(page, /Seguridad de la cuenta/)
  assert.match(page, /tenantContext\.userName/)
  assert.match(page, /autoComplete="new-password"/)
  assert.match(page, /newPassword !== passwordConfirmation/)
  assert.match(page, /updateCurrentCrmPassword\(newPassword\)/)
  assert.match(page, /Contraseña actualizada/)

  assert.match(service, /CRM_PASSWORD_MIN_LENGTH = 8/)
  assert.match(service, /auth\.getUser\(\)/)
  assert.match(service, /auth\.updateUser\(\{ password \}\)/)
  assert.doesNotMatch(service, /serviceRole|manage-pos-users/)
})
