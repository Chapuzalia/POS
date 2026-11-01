# Datos fiscales y domiciliación SEPA

Los nuevos Checkouts de suscripción permiten tarjeta y domiciliación SEPA en EUR.
Solicitan dirección de facturación, razón social e identificador fiscal mediante
`tax_id_collection.enabled=true` y `required=if_supported`. España está soportada;
se recoge el NIF empresarial (`es_cif`) o el NIF-IVA (`eu_vat`) ofrecido por Stripe.
Un cliente que ya tiene un identificador guardado puede no ver el formulario de
nuevo. Stripe valida el formato; esto no acredita la validez fiscal del dato.
Se conserva el IVA manual fijo del 21 % y no se activa Stripe Tax.

La ficha de facturación de Tickit recibe nombre, email e identificador de la factura
autoritativa de Stripe; cada factura conserva su propio snapshot fiscal. No se
reconstruyen documentos históricos a partir de la ficha actual.

## Activación y ampliaciones

Con tarjeta, el pago confirmado sigue siendo la condición de activación. Con SEPA,
el alta y las ampliaciones conceden acceso cuando el servidor verifica que:

- La suscripción está activa y sus líneas coinciden con el contrato aprobado.
- La factura está abierta y su pago en EUR está en estado `processing`.
- Customer, suscripción, factura, PaymentIntent, método SEPA y cargo corresponden
  a la misma operación. El alta comprueba también la sesión Checkout completada
  y sus metadatos de tenant/operación.
- El cargo referencia un mandato SEPA activo, reutilizable y aceptado online.

El retorno del navegador y el contenido del webhook no sirven como prueba de
autorización: se consultan recursos actuales de Stripe. Se guarda una prueba con
identificadores y fecha, sin IBAN, IP, user agent ni client secret.

Mi Plan muestra «SEPA autorizado · cobro en trámite». No se presenta como pagado
ni se suma a cobrado hasta que la factura sea `paid`. La operación permanece
pendiente y bloquea otra modificación económica hasta resolverse, evitando cargos
solapados. Webhooks y conciliación periódica verifican el estado posterior.

Las ampliaciones SEPA usan `allow_incomplete` con `always_invoice`: Stripe cambia
la suscripción e inicia el cobro inmediatamente. No admite la protección de
`pending_if_incomplete` que se mantiene para tarjeta. Si el rechazo ocurre antes
de verificar la autorización, no se conceden los derechos nuevos; el contrato
económico refleja las líneas realmente aplicadas por Stripe. Si el banco devuelve
un cobro después de conceder acceso, se conserva la política existente de mora y
continuidad operativa. No se ha añadido suspensión automática ni una reversión
económica que pueda producir nuevos prorrateos o cargos.

Las reducciones y cambios de intervalo mantienen su programación al vencimiento.
Los reintentos inciertos conservan los parámetros e idempotencia originales. Un
presupuesto de alta anterior a esta política requiere recalcularse antes de su
primera confirmación; una operación ya iniciada conserva su sesión anterior.
Para probar los nuevos campos y métodos hay que abrir un Checkout nuevo.

## Preparación de Staging

1. En el mismo sandbox de Stripe usado por Tickit, activar **SEPA Direct Debit**
   en la configuración de métodos de pago y conservar tarjeta habilitada.
2. Si la clave es restringida, permitir lectura de Invoice Payments, PaymentIntents,
   Payment Methods y Mandates, además de los permisos Billing ya existentes.
3. Revisar y aplicar primero la migración nueva
   `20261101184016_billing_sepa_authorization.sql`. Es un expand nullable que
   reemplaza las rutinas de transición/activación con su compatibilidad anterior.
   Se revisó `contracts-pending.yml`: sus contratos de tickets, contabilidad y
   fiscalidad no corresponden a este expand y no se consumen aquí.
4. Desplegar `billing`, `billing-webhook` y `billing-reconcile` con sus módulos
   compartidos; `manage-pos-users` incorpora el texto de bienvenida actualizado.
   Publicar el frontend después de las funciones. Usar el controlador de
   despliegue self-hosted del proyecto.
5. Añadir a la selección de eventos del endpoint webhook existente:
   `payment_intent.processing`, `payment_intent.succeeded`,
   `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.failed` y
   `checkout.session.async_payment_failed`. Conservar los eventos de Checkout,
   suscripción, factura y calendarios ya configurados y el scheduler de conciliación.
6. Mantener API `2026-09-30.endive`, secretos test y origen de Staging. El bloqueo
   de claves live sigue vigente; este cambio no activa producción.

## Aceptación

Comprobar con un negocio nuevo en sandbox: identificador fiscal obligatorio para
dirección española, razón social/dirección reflejadas en Stripe y la factura;
tarjeta y SEPA disponibles; alta bloqueada antes de autorizar; acceso durante
`processing`; factura pendiente y cobrado cero; posterior pago de la misma factura;
ampliación SEPA inmediata; rechazo antes y después de la activación; reintento sin
duplicar el cargo; operación solapada rechazada. Usar los datos de prueba oficiales
de Stripe y verificar también el webhook y el scheduler desplegados.

`tests/functional/stripe-sepa.test.ts` ejecuta el servicio real y PostgreSQL
embebido con un doble de Stripe. Cubre esos estados, las vinculaciones de recursos,
aislamiento, fencing, permisos, compatibilidad de reintentos y sincronización fiscal.
La comprobación local no sustituye esta aceptación contra la API sandbox real.
No se han aplicado migraciones remotas ni desplegado este cambio.

Referencias oficiales: [datos fiscales en Checkout](https://docs.stripe.com/tax/checkout/tax-ids),
[SEPA](https://docs.stripe.com/payments/sepa-debit),
[pending updates](https://docs.stripe.com/billing/subscriptions/pending-updates),
[Invoice Payment](https://docs.stripe.com/api/invoice-payment/object) y
[actualizar una suscripción](https://docs.stripe.com/api/subscriptions/update).
