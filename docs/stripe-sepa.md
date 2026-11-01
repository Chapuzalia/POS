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

### Compatibilidad de Checkout con Endive

La API fijada `2026-09-30.endive` ya no admite enviar `payment_method_types`.
Las ofertas nuevas guardan `checkoutPolicy=fiscal_sepa_v2` y omiten la lista de
métodos de pago. Stripe utiliza los métodos compatibles habilitados en el Dashboard;
hay que conservar tarjeta y SEPA activados. Se mantienen los datos fiscales
obligatorios y el IVA del 21 %. Stripe describe el cambio en su
[guía del error payment_method_types](https://support.stripe.com/questions/fix-the-payment-method-types-error).

Las ofertas v1 sin confirmar requieren un presupuesto nuevo. Las operaciones ya
iniciadas mantienen sus parámetros y su clave original: una sesión anterior puede
haberse creado aunque su respuesta se perdiera. No convertir automáticamente una
operación `applying` a v2 ni reutilizar su clave con parámetros diferentes.

Para recuperar un rechazo v1 de este incidente:

1. Desplegar primero `billing` y sus módulos compartidos, además del frontend,
   mediante el controlador existente. No necesita migración. Desplegar también los
   consumidores del servicio compartido (`billing-webhook` y `billing-reconcile`).
2. Con acceso administrativo y en el entorno autorizado, volver a leer la operación
   y el cliente. Exigir `applying`, política v1, sin suscripción enlazada ni IDs de
   Checkout/calendario/factura en el resultado, y diagnóstico Stripe `status=400`,
   `type=invalid_request_error`, `param=payment_method_types`, `outcome=rejected`.
3. Consultar Stripe con la misma cuenta y modo test, recorriendo toda la paginación.
   Comprobar que el cliente no tiene sesiones Checkout, suscripciones ni facturas.
   Si existen recursos o un resultado incierto, detener esta recuperación y conciliar
   manualmente. Evitar acciones concurrentes sobre la cuenta durante la comprobación.
4. Solo tras esas comprobaciones y la autorización del entorno, utilizar la transición
   administrativa existente `apply_error`, con el tenant y la operación comprobados,
   el diagnóstico conservado y `release=true`. La transición conserva el historial,
   audita la acción y pasa la operación a `failed`; no borrar filas ni cambiar el
   contrato, los permisos o el cliente Stripe. Verificar el estado resultante.
5. Solicitar una oferta nueva y confirmar que su política es v2. El propietario puede
   abrir el nuevo Checkout; la activación sigue dependiendo del pago o mandato
   verificado. No usar «Recuperar operación» sobre el intento v1 rechazado, pues
   conserva intencionadamente la petición original incompatible.

El frontend lee también las respuestas HTTP de error y muestra únicamente mensajes
públicos de una lista compartida con `billing`; los textos desconocidos, respuestas
de gateway y errores de red conservan un mensaje genérico sin diagnósticos internos.

### Configuración y despliegue

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
