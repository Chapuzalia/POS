/** Only explicit authentication failures invalidate an existing local session. */
export function isInvalidAuthError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const { name, code, message } = error as { name?: string; code?: string; message?: string }
  if (name === 'AuthSessionMissingError') return true
  if (code && [
    'bad_jwt', 'user_not_found', 'user_banned', 'session_not_found', 'session_expired',
    'refresh_token_not_found', 'refresh_token_already_used',
  ].includes(code)) return true
  // Older GoTrue versions return this explicit rejection without an error code.
  return name === 'AuthApiError' && /invalid refresh token/i.test(message ?? '')
}

/** Read-only continuity check, never a substitute for server authentication. */
export function hasPersistedSessionForUser(raw: string | null, userId: string) {
  try {
    const session = raw ? JSON.parse(raw) : null
    return Boolean(session?.user?.id === userId && session.access_token && session.refresh_token)
  } catch {
    return false
  }
}
