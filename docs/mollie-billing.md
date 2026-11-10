# Facturación de Tickit POS con Mollie

Sustituye a Stripe (`stripe-billing.md`, `stripe-sepa.md`, `stripe-onboarding.md` y `stripe-billing-promotions.md` quedan como histórico). Sin Mollie Connect: un único perfil Mollie de Alteil cobra a los negocios. Integración REST (`fetch`, sin SDK), igual que Loyalty y Events. Admite cobros reales con una clave `live_`.

## Configuración (Edge Functions)

La clave de Mollie y la conexión con Odoo también se pueden guardar desde **Superadmin → Configuración** (tabla `platform_billing_secrets`, solo service role). Lo guardado ahí sustituye a `MOLLIE_API_KEY`/`ODOO_*`; las claves nunca se devuelven al navegador (solo origen y últimos 4 caracteres). Los datos de Odoo guardados solo se usan si están completos (URL, base de datos y clave). `BILLING_APP_URL` y `BILLING_WEBHOOK_URL` siguen siendo variables de entorno.

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

- **Ampliación** (misma periodicidad, sin retirar nada): el propietario paga **con tarjeta en Mollie Checkout** la parte proporcional del aumento neto (`(nuevo − actual) × tiempo restante / periodo`) + IVA (pago `oneoff`, `metadata.tickit_kind=proration`, vuelta a `/crm/plan?billing=return`). Mientras el Checkout está abierto no cambia nada (ni acceso ni importe de la suscripción, y no cuenta como «cobro en trámite»). Al pagarse, la conciliación aplica el contrato y actualiza el importe de la suscripción. Si caduca, se cancela o falla, la ampliación se descarta sin deuda. Una ampliación sin importe (p. ej. reasignar un complemento) se aplica al momento. Las ampliaciones antiguas en curso cobradas por SEPA siguen su flujo anterior.
- **Reducción, retirada de complementos/locales o cambio de periodicidad**: sin cargo; se programa para la renovación. Con la misma periodicidad se actualiza ya el importe en Mollie (afecta solo al siguiente cobro) y el acceso cambia en la fecha de renovación. Mensual ↔ anual crea una suscripción nueva que empieza exactamente en la renovación con el mismo mandato y cancela la anterior. Las reducciones de acceso se siguen aplazando mientras haya caja u órdenes abiertas.
- **Locales y terminales que sobran**: si el nuevo plan admite menos locales (o dispositivos) de los activos, Mi Plan pide elegir cuáles se desactivan. El contrato lleva `access` (`deactivateVenueIds`, `deactivateDeviceIds` —incluye los terminales de esos locales—, `reactivateVenueIds`, `reactivateDeviceIds`) y la proyección SQL (`billing_transition`, migración `20261109200000`) los aplica en la renovación: local inactivo, sus dispositivos y sus asignaciones de TPV inactivos. El local sigue visible en el CRM como «inactivo» con sus datos. La capacidad (`max_venues` y el trigger de alta) cuenta solo locales activos, y reactivar un local o dispositivo fuera de la proyección se comprueba contra el límite del plan.
- **Reactivación**: al contratar más locales, Mi Plan ofrece reactivar locales inactivos en el mismo cambio. Vuelven con los terminales que la facturación había desactivado (no los retirados a mano), cuando el cambio se paga o se aplica.
- **Funcionalidades que se pierden**: la vista previa lista lo que deja de estar disponible (locales, terminales, funcionalidades de empresa y complementos por local) y el propietario debe aceptarlo (`acceptLosses`) antes de confirmar. Los datos se conservan.
- **Excepciones temporales (`cycles`)** y **promociones**: el contrato vigente en cada fecha se calcula igual que antes; la conciliación ajusta el importe de la suscripción para que el siguiente cobro coincida con el contrato vigente ese día. Sin prorrateos en las fases.
- No hay reembolsos de periodos pagados.

## Bajas

- **Al vencimiento** (propietario desde Mi Plan → «Dar de baja», o superadmin): se cancela la suscripción en Mollie (no hay más cobros) y el plan sigue hasta `period_end`; después pasa a `canceled`. Sustituye un cambio programado. No se puede volver a contratar dentro del periodo pagado (se cobraría dos veces).
- **Inmediata** (superadmin): cancela ya, sin reembolso.

## Forma de pago

Las cuotas se cobran por domiciliación SEPA y las ampliaciones con tarjeta en el momento. Mi Plan muestra los últimos 4 dígitos del IBAN domiciliado y permite **cambiar el IBAN** (`change-mandate`, solo propietario): se crea un mandato nuevo (`TICKIT-M-<requestId>`, idempotente por `requestId`), la suscripción pasa a usarlo y se revocan los mandatos SEPA anteriores. No se permite con un adeudo en trámite ni con una operación en curso. El IBAN se envía a Mollie y no se guarda ni se registra.

## Impagos

Mollie no reintenta. Si una renovación falla o se devuelve, el propietario ve «Pagar cuota pendiente», que crea un pago con tarjeta por ese importe (`metadata.tickit_covers`). Al pagarse, se limpia la deuda. Si Mollie suspende la suscripción (mandato inválido) la cuenta pasa a `unpaid` y requiere gestión de soporte.

## Webhook y conciliación

Mollie envía solo `id=tr_…`, sin firma. `billing-webhook` valida el formato, relee el pago en la API, localiza el negocio por `customerId` y concilia. Cada estado se registra como `mollie:<tr>:<estado>:<devuelto>` en el registro técnico; los reintentos y las llamadas falsas no cambian nada. Un error devuelve 503 y Mollie reintenta. El cron `billing-reconcile` aplica los cambios por fecha (renovaciones, fin de periodo, promociones) aunque no llegue un webhook; debe ejecutarse al menos a diario.

La conciliación comprueba que suscripciones y pagos pertenecen al cliente y al negocio (`metadata.tickit_tenant_id`).

## Facturas (Odoo)

Mollie no emite facturas de suscripción: el emisor fiscal es el Odoo de Alteil (19 Community, Veri\*Factu). Cada pago se guarda en `billing_invoices` y la conciliación, dentro de su reclamación de sincronización y antes de `sync_commit`, lo refleja en Odoo (`_shared/billing/odoo-sync.ts`, API JSON-2 en `odoo.ts`):

| Pago | Odoo | `billing_odoo_documents.state` |
| --- | --- | --- |
| Checkout abierto o SEPA en trámite | Pedido de venta = **proforma** pendiente de pago (`client_order_ref = tr_…`) | `proforma` |
| Liquidado | Confirmar el pedido → factura → comprobar que el total coincide al céntimo con Mollie → validar (numera Odoo) → registrar el cobro en el diario `MOLL` | `invoiced` |
| Caducado, cancelado o fallido sin liquidar | Cancelar la proforma (no se crea ninguna si Odoo no llegó a verla) | `canceled` |
| Devuelto por completo | Factura (si faltaba) y **rectificativa** validada. Es definitivo: si Mollie revierte la devolución, la rectificativa se mantiene y hay que revisarla a mano | `refunded` |
| Devuelto en parte | Nada automático: `failed`/`ODOO_REVIEW_REQUIRED` para revisarlo a mano en Odoo | `failed` |
| Error de Odoo | Nada; se reintenta en la siguiente conciliación | `failed` + código |

- Siempre se busca antes de crear (pedido por `client_order_ref`, factura entre las del pedido, rectificativa por `reversed_entry_id`), así que los reintentos no duplican nada. Como mucho se procesan 10 pagos por conciliación y no se inicia ninguna llamada a Odoo pasados 45 s, para no superar la reclamación de 2 minutos. Los pagos que más veces han fallado van al final.
- Odoo nunca bloquea la facturación: un fallo o Odoo sin configurar no cambia el acceso, el contrato ni la deuda.
- Si el total de Odoo no coincide con el bruto de Mollie, la factura queda en borrador sin número (`ODOO_TOTAL_MISMATCH`).
- Tickit refleja el estado en `billing_invoices`: `fiscal_export_status` (`pending_review`/`exported`/`failed`), `number` (número de Odoo) y `fiscal_external_reference` (`sale.order:<id>` o `account.move:<id>`). El cliente de Odoo se busca o se crea por NIF (prefijo `ES` para NIF/NIE/CIF españoles) y su ID se guarda en `billing_accounts.odoo_partner_id`.
- `billing_odoo_documents` tiene RLS activada y ninguna política: solo la service role puede leerla.
- **Mi Plan** muestra el número, el estado fiscal y los botones «Descargar PDF» / «Descargar rectificativa». La acción `invoice-document` (solo para el propietario o el superadmin, y solo para pagos de su negocio) obtiene el PDF del portal de Odoo desde el servidor; el token del portal no llega al navegador. Odoo no envía correos.
- El alta recoge razón social, NIF, correo y domicilio fiscal. El propietario y Superadmin pueden actualizar el perfil desde Mi Plan; cada cobro conserva su propia instantánea. Odoo solo reutiliza contactos con la referencia del negocio y todos los datos fiscales coincidentes; no modifica contactos utilizados por otras facturas. Los clientes N-1 pueden contratar con el formato anterior, pero no se emiten documentos con una instantánea incompleta.
- El resumen de Superadmin avisa si Odoo está desactivado o si hay documentos pendientes de emisión.

### Estilos del PDF en Odoo

El motor de PDF debe poder descargar directamente los recursos de Odoo. En el servidor actual, la URL pública HTTP devuelve una redirección 308 a HTTPS y `wkhtmltopdf` pierde los estilos; la misma prueba con `http://127.0.0.1:8069` conserva columnas y tablas. El cambio preparado es crear el parámetro de Odoo `report.url = http://127.0.0.1:8069`, manteniendo el diseño Wave y la URL pública. Esta configuración requiere aprobación de producción y no se aplica desde los webhooks ni las descargas del cliente.

Después de aplicarlo se comprobará un PDF nuevo. Los PDF oficiales ya guardados se reutilizan y no se regeneran como parte de este cambio. No se modifican las facturas históricas de prueba.

### Configuración

| Variable (Edge Functions) | Uso |
| --- | --- |
| `ODOO_URL` | URL de Odoo, p. ej. `https://invoicing.int.alteilsolutions.com`. |
| `ODOO_DB` | Base de datos (`Alteil`). |
| `ODOO_API_KEY` | Clave API de un usuario técnico con permisos de Facturación y Ventas. |

Sin las tres variables no se envía nada a Odoo. En Odoo deben existir:

1. Producto de servicio con referencia interna **`TICKIT-SUB`** («Suscripción Tickit POS»), impuesto «21% S» y facturación según cantidad pedida.
2. Diario bancario con código **`MOLL`** («Mollie»).
3. La opción «Factura proforma» activada en Ventas → Ajustes.

Redespliega `billing`, `billing-webhook` y `billing-reconcile` después de configurar los secretos.

### Paso a actividad real

Mientras Odoo esté en pruebas, staging y producción envían al mismo Odoo (el origen del pedido indica `Tickit test`/`Tickit live`). Antes de empezar la actividad real: reiniciar Odoo (numeración, clientes y documentos de prueba), configurar Veri\*Factu en real (certificado, obligatorio y fuera del entorno de pruebas), y retirar los `ODOO_*` de staging o apuntarlos a una copia.

## Paso a cobros reales

1. Prueba antes un alta, una renovación SEPA y una baja completas con la clave `test_` en staging.
2. En el perfil live de Mollie: tarjeta, SEPA Direct Debit y creación de mandatos por API activados.
3. Configura `MOLLIE_API_KEY=live_…` y `BILLING_WEBHOOK_URL` del entorno de producción y redespliega las Edge Functions `billing`, `billing-webhook`, `billing-reconcile` y `manage-pos-users`.
4. Las cuentas enlazadas a clientes del sandbox (`cst_` creados con la clave test) fallarán con `BILLING_MODE_MISMATCH`: desenlázalas y repite el alta.

## Cuentas Stripe antiguas

Las cuentas sandbox enlazadas a `cus_…` devuelven `BILLING_LEGACY_PROVIDER` y no se concilian. Para migrarlas hay que desenlazarlas (datos de staging) y repetir el alta. El borrado de negocios ignora esos IDs.

## Pendiente

Prealerta SEPA al cliente antes de cada adeudo (Mollie no la envía), pagar las renovaciones con tarjeta en lugar de SEPA, reactivar una baja programada, cancelar desde Tickit un Checkout de ampliación abierto (caduca solo en Mollie), IVA inverso intracomunitario (Odoo factura todo con el 21 %) y conciliación en Odoo de las liquidaciones y devoluciones de Mollie con el banco.
