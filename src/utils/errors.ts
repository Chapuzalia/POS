export function getReadableError(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  if (error && typeof error === 'object') {
    const supabaseError = error as {
      code?: unknown
      details?: unknown
      error?: unknown
      error_description?: unknown
      hint?: unknown
      message?: unknown
      name?: unknown
      status?: unknown
    }
    const parts = [
      supabaseError.message,
      supabaseError.error_description,
      supabaseError.details,
      supabaseError.hint,
      supabaseError.code ? `Codigo: ${String(supabaseError.code)}` : null,
      supabaseError.status ? `Estado: ${String(supabaseError.status)}` : null,
      supabaseError.error,
      supabaseError.name,
    ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0)

    if (parts.length) {
      return parts.join(' - ')
    }

    try {
      return JSON.stringify(error)
    } catch {
      return 'Error desconocido.'
    }
  }

  return String(error)
}
