const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export async function forwardPersonalActivation(
  request: Request,
  config: { url: string; anonKey: string },
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const reply = (error: string, status: number) => Response.json({ error }, { status })
  const authorization = request.headers.get('authorization') ?? ''
  if (!authorization.startsWith('Bearer ')) return reply('Inicia sesión en el POS.', 401)
  let destination: URL
  try {
    destination = new URL(config.url)
    if (destination.protocol !== 'https:' || destination.username || destination.password || destination.search || destination.hash || destination.pathname !== '/' || !config.anonKey) throw new Error('Invalid endpoint')
  } catch {
    return reply('La activación de Personal todavía no está configurada.', 503)
  }
  let input: { tenantId: string; password: string }
  try {
    const reader = request.body?.getReader()
    if (!reader) return reply('Elige una contraseña de Personal de al menos 6 caracteres.', 400)
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > 8192) {
          await reader.cancel()
          return reply('Solicitud demasiado grande.', 413)
        }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    const data = JSON.parse(new TextDecoder().decode(bytes))
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['tenantId', 'password'].includes(key)) || typeof data.tenantId !== 'string' || !uuid.test(data.tenantId) || typeof data.password !== 'string' || data.password.length < 6 || data.password.length > 1024) return reply('Elige una contraseña de Personal de al menos 6 caracteres.', 400)
    input = { tenantId: data.tenantId, password: data.password }
  } catch { return reply('Solicitud de activación no válida.', 400) }
  try {
    const result = await fetcher(new URL('/functions/v1/pos-activate', destination), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
      headers: { authorization, apikey: config.anonKey, 'content-type': 'application/json', 'user-agent': 'TickitPOS-PersonalActivation/1.0' },
      body: JSON.stringify(input),
    })
    const data = await result.json()
    if (!result.ok) return reply(typeof data?.error === 'string' && data.error.length < 400 ? data.error : 'No se pudo activar Personal.', [400, 401, 403, 409, 429, 503].includes(result.status) ? result.status : 502)
    const personalUrl = new URL(data.personalUrl)
    if (!uuid.test(data.connectionId) || !uuid.test(data.organizationId) || personalUrl.protocol !== 'https:' || personalUrl.username || personalUrl.password) return reply('Personal devolvió una respuesta no válida.', 502)
    return Response.json({ connectionId: data.connectionId, organizationId: data.organizationId, personalUrl: personalUrl.origin })
  } catch { return reply('No se pudo contactar con Personal. Reintenta la activación.', 502) }
}
