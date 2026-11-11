import { Capacitor } from '@capacitor/core'
import { Button } from '../../components/ui'
import { billingCard } from './TenantBillingPanel'

/**
 * Las tiendas de apps no permiten contratar ni pagar la suscripción con un método externo
 * (App Store 3.1.1): en la app nativa solo se informa, sin enlaces ni botones de pago.
 */
export const billingManagedOnWeb = Capacitor.isNativePlatform()

export function NativeBillingNotice({ activationRequired = false }: { activationRequired?: boolean }) {
  return <section aria-label="Suscripción" className={`${billingCard} !grid !gap-3`}>
    <h2 className="!m-0 !text-xl !font-bold !tracking-tight !text-[var(--crm-text)]">Mi plan</h2>
    <p className="!m-0 !text-sm !text-[var(--crm-text-secondary)]">
      {activationRequired
        ? 'Para activar el negocio, completa la contratación desde la web de Tickit con la cuenta del propietario.'
        : 'La suscripción, los pagos y las facturas se gestionan desde la web de Tickit.'}
    </p>
    {activationRequired ? <Button className="!w-fit" onClick={() => window.location.reload()}>Ya lo he activado</Button> : null}
  </section>
}
