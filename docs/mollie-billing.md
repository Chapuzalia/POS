# Facturación de Tickit POS con Mollie

Sustituye a Stripe (`stripe-billing.md`, `stripe-sepa.md`, `stripe-onboarding.md` y `stripe-billing-promotions.md` quedan como histórico). Sin Mollie Connect: un único perfil Mollie de Alteil cobra a los negocios. Integración REST (`fetch`, sin SDK), igual que Loyalty y Events. Admite cobros reales con una clave `live_`.

## Configuración (Edge Functions)

| Variable | Uso |
| --- | --- |
| `MOLLIE_API_KEY` | Clave `live_…` para cobros reales o `test_…` para el sandbox (`MOLLIE_TEST_API_KEY` se sigue leyendo si `MOLLIE_API_KEY` no existe). El gateway rechaza cualquier respuesta cuyo `mode` no coincida con la clave, para que una clave live nunca opere sobre IDs del sandbox. |
| `BILLING_APP_URL` | URL pública del CRM (redirect tras el Checkout). |
| `BILLING_WEBHOOK_URL` | URL pública HTTPS de `billing-webhook`. En Supabase self-hosted `SUPABASE_URL` es interna, por eso es explícita. Mollie rechaza localhost. |
| `BILLING_RECONCILE_SECRET` | Igual que antes, para el cron `billing-reconcile`. |

`STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_WEBHOOK_SECRET` y `STRIPE_TEST_PORTAL_CONFIGURATION_ID` dejan de usarse.

En el dashboard de Mollie: activar **tarjeta** y **SEPA Direct Debit**, y la creación de mandatos SEPA por API (puede requerir que Mollie la habilite). No hay que registrar webhooks: cada pago y suscripción lleva su `webhookUrl`.

## Modelo

Mollie no tiene productos ni precios. El catálogo (planes, complementos, versiones, excepciones, promociones) sigue en Tickit y cada contrato calcula `recurringCents` (neto, céntimos enteros, con descuentos e importes personalizados). Mollie cobra `recurringCents + 21 % IVA` (redondeo por cuota). Publicar una tarifa ya no llama a ningún proveedor.

Por compatibilidad expand-only, las columnas `stripe_customer_id`, `stripe_subscription_id`, `stripe_price_id`, `stripe_invoice_id`, `stripe_params` y la tabla `billing_stripe_events` se reutilizan con IDs de Mollie (`cst_`, `sub_`, `tr_`, `mollie:tr_…`). `source='stripe'` significa «cobrado por pasarela». Renombrarlas requiere una migración contract posterior. No hay migración nueva: el SQL (`billing_transition`, activación, purga) no cambia.

## Alta: primera cuota con tarjeta, siguientes por SEPA

1. El propietario revisa el plan y rellena razón social, NIF, titular e IBAN y acepta el mandato.
2. `confirm` crea el cliente Mollie (uno por negocio), crea un mandato `directdebit` por API (`mandateReference = TICKIT-<op>`; el IBAN se valida con mod-97, se envía a Mollie y no se guarda ni se registra) y un pago `sequenceType=first`, `method=creditcard`, que devuelve la URL del Checkout.
3. Cuando el pago está `paid`, la conciliación crea la suscripción: mismo importe, intervalo del contrato, `startDate` = fecha de pago + 1 periodo y `mandateId` = mandato SEPA. Se busca por `metadata.tickit_operation_id` antes de crearla: un pago nunca abre dos suscripciones.
4. Se proyecta el contrato y se activa el negocio (trigger existente: `active` + `paid`).

Una tarjeta fallida o caducada caduca la operación y el negocio sigue limitado a Mi Plan. «Modificar plan» solo libera un Checkout `open` si Mollie acepta cancelarlo; si no, hay que esperar a que caduque, para no cobrar sin servicio.

## Cobros SEPA en trámite

Un adeudo aceptado queda `pending` varios días. Mientras tanto **no se corta el acceso**: la cuenta sigue `active`, `last_payment_status='pending'` («Cobro en trámite»), sin `delinquent_since`, y no se aplica restricción ni bajada. Para no apilar riesgo, no se aceptan nuevos cambios de plan hasta que el banco liquide. Solo una devolución o un fallo crean deuda (`past_due`, días de gracia y después restricción). Una baja no anula un adeudo ya aceptado: se sigue cobrando.

## Cambios a mitad de periodo

- **Ampliación** (misma periodicidad, sin retirar nada): cargo inmediato de la parte proporcional del aumento neto (`(nuevo − actual) × tiempo restante / periodo`) + IVA, `sequenceType=recurring` sobre el mandato de la suscripción, y nuevo importe en la suscripción. Con SEPA, el acceso se amplía al aceptarse el adeudo; el contrato pagado (`billed_contract`) cambia al liquidarse. Si el cargo falla, se retira la ampliación y se restaura el importe anterior (no genera deuda).
- **Reducción, retirada de complementos/locales o cambio de periodicidad**: sin cargo; se programa para la renovación. Con la misma periodicidad se actualiza ya el importe en Mollie (afecta solo al siguiente cobro) y el acceso cambia en la fecha de renovación. Mensual ↔ anual crea una suscripción nueva que empieza exactamente en la renovación con el mismo mandato y cancela la anterior. Las reducciones de acceso se siguen aplazando mientras haya caja u órdenes abiertas.
- **Excepciones temporales (`cycles`)** y **promociones**: el contrato vigente en cada fecha se calcula igual que antes; la conciliación ajusta el importe de la suscripción para que el siguiente cobro coincida con el contrato vigente ese día. Sin prorrateos en las fases.
- No hay reembolsos de periodos pagados.

## Bajas

- **Al vencimiento** (propietario o superadmin): se cancela la suscripción en Mollie (no hay más cobros) y el plan sigue hasta `period_end`; después pasa a `canceled`. Sustituye un cambio programado. No se puede volver a contratar dentro del periodo pagado (se cobraría dos veces).
- **Inmediata** (superadmin): cancela ya, sin reembolso.

## Impagos

Mollie no reintenta. Si una renovación falla o se devuelve, el propietario ve «Pagar cuota pendiente», que crea un pago con tarjeta por ese importe (`metadata.tickit_covers`). Al pagarse, se limpia la deuda. Si Mollie suspende la suscripción (mandato inválido) la cuenta pasa a `unpaid` y requiere gestión de soporte.

## Webhook y conciliación

Mollie envía solo `id=tr_…`, sin firma. `billing-webhook` valida el formato, relee el pago en la API, localiza el negocio por `customerId` y concilia. Cada estado se registra como `mollie:<tr>:<estado>:<devuelto>` en el registro técnico; los reintentos y las llamadas falsas no cambian nada. Un error devuelve 503 y Mollie reintenta. El cron `billing-reconcile` aplica los cambios por fecha (renovaciones, fin de periodo, promociones) aunque no llegue un webhook; debe ejecutarse al menos a diario.

La conciliación comprueba que suscripciones y pagos pertenecen al cliente y al negocio (`metadata.tickit_tenant_id`).

## Facturas

Mollie no emite facturas de suscripción. Cada pago se guarda en `billing_invoices` (total, base sin IVA, estado, fecha de cobro) con `fiscal_export_status='pending_review'`, sin número ni PDF: la factura fiscal se emite fuera (gestoría/ERP) a partir de esos registros.

## Paso a cobros reales

1. Prueba antes un alta, una renovación SEPA y una baja completas con la clave `test_` en staging.
2. En el perfil live de Mollie: tarjeta, SEPA Direct Debit y creación de mandatos por API activados.
3. Configura `MOLLIE_API_KEY=live_…` y `BILLING_WEBHOOK_URL` del entorno de producción y redespliega las Edge Functions `billing`, `billing-webhook`, `billing-reconcile` y `manage-pos-users`.
4. Las cuentas enlazadas a clientes del sandbox (`cst_` creados con la clave test) fallarán con `BILLING_MODE_MISMATCH`: desenlázalas y repite el alta.

## Cuentas Stripe antiguas

Las cuentas sandbox enlazadas a `cus_…` devuelven `BILLING_LEGACY_PROVIDER` y no se concilian. Para migrarlas hay que desenlazarlas (datos de staging) y repetir el alta. El borrado de negocios ignora esos IDs.

## Pendiente

Prealerta SEPA al cliente antes de cada adeudo (Mollie no la envía), cambio de IBAN sin baja y nueva alta, reactivar una baja programada, IVA inverso intracomunitario y emisión automática de facturas.
