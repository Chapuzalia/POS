import { requireSupabase } from '../../shared/services/crmServiceSupport'

export const CRM_PASSWORD_MIN_LENGTH = 8

export async function updateCurrentCrmPassword(password: string) {
  if (password.length < CRM_PASSWORD_MIN_LENGTH) {
    throw new Error(`La contraseña debe tener al menos ${CRM_PASSWORD_MIN_LENGTH} caracteres.`)
  }

  const client = requireSupabase()
  const { data: userData, error: userError } = await client.auth.getUser()

  if (userError) throw userError
  if (!userData.user) throw new Error('La sesión del usuario CRM ya no es válida.')

  const { error } = await client.auth.updateUser({ password })
  if (error) throw error
}
