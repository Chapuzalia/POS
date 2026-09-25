export type SuperadminAuthorizationResult =
  | { authorized: true; userId: string }
  | { authorized: false; status: 401 | 403 | 500; error: string }

export function authorizeSuperadmin(
  userId: string | null,
  authError: unknown,
  profile: { is_superadmin?: boolean } | null,
  profileError: unknown,
): SuperadminAuthorizationResult {
  if (authError || !userId) return { authorized: false, status: 401, error: 'Sesion no valida' }
  if (profileError) return { authorized: false, status: 500, error: 'No se pudo validar el permiso de superadmin' }
  if (!profile) return { authorized: false, status: 403, error: 'Solo un superadmin puede realizar esta accion' }
  if (profile.is_superadmin !== true) return { authorized: false, status: 403, error: 'Solo un superadmin puede realizar esta accion' }
  return { authorized: true, userId }
}
