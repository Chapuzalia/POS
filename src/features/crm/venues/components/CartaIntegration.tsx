import { useState } from 'react'
import { requireSupabase } from '../../shared/services/crmServiceSupport'
import { Button } from '../../../../components/ui/Button'

export function CartaIntegration({ venueId, disabled }: { venueId: string; disabled: boolean }) {
  const [busy, setBusy] = useState(false)
  const [key, setKey] = useState('')
  const [message, setMessage] = useState('')
  async function configure(enabled: boolean) {
    setBusy(true)
    setMessage('')
    setKey('')
    try {
      const { data, error } = await requireSupabase().rpc('tickit_carta_configure', {
        p_venue_id: venueId,
        p_enabled: enabled,
      })
      if (error) throw error
      setKey(data?.apiKey ?? '')
      setMessage(
        enabled
          ? 'Credencial creada. Cópiala ahora y pégala en Integraciones de Tickit Carta. La credencial anterior deja de funcionar.'
          : 'Conexión revocada. La carta ya no puede acceder al POS.',
      )
    } catch {
      setMessage('No se pudo cambiar la conexión. Comprueba tus permisos y vuelve a intentarlo.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="grid gap-3 border-t border-[var(--crm-border-subtle)] p-5">
      <h3 className="font-semibold">Tickit Carta</h3>
      <p className="text-sm">
        Conecta el catálogo y recibe pedidos en las comandas abiertas de tus mesas.
      </p>
      <p className="text-sm">
        Identificador del local: <code>{venueId}</code>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled || busy} onClick={() => void configure(true)}>
          Crear / renovar credencial
        </Button>
        <Button disabled={disabled || busy} onClick={() => void configure(false)}>
          Revocar conexión
        </Button>
      </div>
      {key ? (
        <label className="grid gap-1 text-sm">
          Credencial (se muestra una vez)
          <input
            readOnly
            value={key}
            className="w-full rounded border p-2"
            onFocus={(e) => e.target.select()}
          />
        </label>
      ) : null}
      <p className="text-sm">
        Prepara y descarga el QR de cada mesa desde Mesas y zonas en Tickit Carta. Allí también
        encontrarás el enlace para las etiquetas NFC.
      </p>
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
    </section>
  )
}
