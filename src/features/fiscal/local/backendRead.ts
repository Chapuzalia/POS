type ReadResult<T> = {
  data: T | null
  error: { code: string; message: string; details: string; hint: string } | null
}

/** Bound read-only preparation, including time spent waiting for auth refresh. */
export async function readFiscalBackend<T>(
  request: (signal: AbortSignal) => PromiseLike<ReadResult<T>>,
  timeoutMs = 3_000,
): Promise<ReadResult<T>> {
  const unavailable: ReadResult<T> = { data: null, error: {
    code: '', message: 'Network error: fiscal backend unavailable', details: '', hint: '',
  } }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return unavailable
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<ReadResult<T>>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(unavailable) }, timeoutMs)
  })
  try {
    return await Promise.race([request(controller.signal), timeout])
  } catch (error) {
    if (error instanceof TypeError || (error instanceof DOMException
      && ['AbortError', 'TimeoutError'].includes(error.name))) return unavailable
    throw error
  } finally {
    clearTimeout(timer)
  }
}
