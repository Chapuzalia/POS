# Stripe Billing de Tickit: implementación y puesta en marcha sandbox

La ampliación preparada en `Staging` añade [promociones gratuitas por addon con inicio inmediato](stripe-billing-promotions.md), conservando las excepciones y contratos anteriores. Esa guía detalla la política sin prorrateo, los calendarios modificables y el despliegue Self-Hosted en Coolify.

## Corrección de Checkout y recuperación en Staging (20-10-2026)

Cambios preparados en la rama `Staging`, sin desplegar esta corrección ni aplicar su migración remota. No se ha modificado producción.

- Checkout omite `payment_method_types` y utiliza los métodos dinámicos del Dashboard. Conserva suscripción, precios/cantidades, descuentos, metadatos de sesión/suscripción, recogida fiscal, actualización del cliente y redirecciones.
- El gateway distingue rechazos de validación/autenticación/permisos de resultados inciertos. Conflictos de idempotencia, HTTP 409/429/5xx, `Stripe-Should-Retry`, respuestas ilegibles y fallos de transporte conservan el bloqueo. Solo guarda estado HTTP, tipo/código/parámetro e ID de petición sanitizados; nunca mensajes ni cuerpos de Stripe.
- `apply_error` registra el diagnóstico y la auditoría bajo los bloqueos de cuenta y operación. Un primer rechazo definitivo sin recurso económico registrado pasa a `failed`. Un reintento tras incertidumbre o un rechazo de fases después de crear el calendario conserva `applying`. Las claves de idempotencia y la ventana de 23 horas se mantienen.
- La mora se conserva exclusivamente para una suscripción `past_due`/`unpaid`. `manual`, sin suscripción, deja `delinquent_since=null` en la siguiente conciliación. `revision` aumenta únicamente si cambia el estado comercial persistido; los timestamps y errores técnicos de conciliación no invalidan presupuestos.

Migración compatible nueva: `20261020213005_stripe_billing_failure_reconciliation.sql`. Sustituye `billing_transition(text,jsonb)` conservando firma, permisos invoker, comprobaciones de rol, acciones N-1, bloqueo por empresa y token de conciliación. No consume los contracts pendientes de tickets, contabilidad o fiscalidad, ajenos a Billing.

Se revisaron las llamadas de productos/precios/cupones, previews, suscripciones/cancelaciones, calendarios y Portal frente a la API fijada. No se identificaron otras incompatibilidades en esos parámetros: ya se utilizan `phases.duration`, `discounts.source.coupon`, periodos de los items y `invoices/create_preview`; no se envían los campos de billing cycle anchor modificados por Endive. La validación real de esta corrección cubre preview y Checkout; no constituye aceptación completa de todos los flujos de calendario y Portal.

Recuperación efectuada exclusivamente en el proyecto Staging `irsdd2liytrh7dttjr5rzj3j`:

1. Se comprobó la operación `6ac21565-25a9-40cb-8e30-73b1c5b1bc4b`: `applying`, sin resultado ni suscripción enlazada, cuenta `manual`, `revision=5`, falsa fecha de mora. La escritura de esa fecha y el incremento rutinario proceden del `sync_commit` anterior.
2. En el Sandbox `acct_1USgwlLmYqvOek4i`, se verificó el cliente y su metadata de empresa. Las consultas completas de sesiones Checkout y suscripciones (todos los estados, también por cliente) devolvieron cero recursos y `has_more=false`. Se repitió la comprobación usando la clave test del runtime de Staging y API `2026-09-30.endive` antes de recuperar.
3. Se comprobó que el registro no hubiera cambiado durante la verificación y se invocó la transición existente `billing_transition/apply_result` para pasar a `failed`. El resultado conserva el rechazo HTTP 400 comunicado y la evidencia de ausencia de recursos. No se borraron registros ni se ejecutaron UPDATE SQL manuales. La cuenta continúa manual; la limpieza de la mora espera a desplegar la migración y conciliar.
4. Una prueba independiente con cliente sintético, la versión exacta `2026-09-30.endive` y parámetros equivalentes confirmó preview y creación de Checkout. Stripe devolvió métodos dinámicos `card`, `klarna`, `link`, `amazon_pay` y `satispay`. La sesión se expiró inmediatamente, sin suscripción ni cargo. Los recursos de prueba se conservan en Sandbox, etiquetados `tickit_billing_smoke`.

Despliegue preparado para Staging:

1. Revisar/commit de la corrección en `Staging`. Ejecutar el workflow `Check and deploy staging` con el destino aislado y su baseline verificados. El despliegue normal hace backup y aplica primero las migraciones; no ejecutar estas instrucciones contra main/producción.
2. Aplicar la migración nueva y después publicar las tres Edge Functions `billing`, `billing-webhook` y `billing-reconcile`, que comparten el servicio. Conservar los secretos test y el origen de Staging.
3. Conciliar la empresa afectada desde la aplicación: comprobar `manual`, sin suscripción y `delinquent_since=null`. Repetir la conciliación y verificar que `revision` no cambia. Crear un presupuesto nuevo; el anterior queda como historial de fallo y no se reutiliza.
4. Confirmar el Checkout nuevo en Sandbox, probar rechazo/timeout y supervisar operaciones y auditoría. Un timeout conserva su ID y clave; nunca se libera una operación incierta por ausencia momentánea de recursos.

Regresión: `tests/stripe-billing-recovery.test.mjs` cubre rechazo definitivo, privacidad del diagnóstico, respuesta perdida tras crear sesión, recuperación con la misma clave, bloqueo de operaciones solapadas, rechazo durante reintento, caducidad, fases parcialmente creadas, aislamiento por empresa, recursos ya registrados, mora y revisión estable. Usa el servicio real con PostgreSQL embebido y un doble de Stripe.

Validación local de la corrección: 1007 pruebas pasan con `rtk pnpm dlx pnpm@10.15.1 test`; lint y build pasan con la misma versión fijada. Lint conserva las cuatro advertencias anteriores de CRM/restaurante; build avisa de la ausencia del token de publicación de Sentry. Las tres funciones pasan `deno check` y el diff pasa `git diff --check`. El test de la migración comprueba el expand con el analizador del proyecto y ejecuta su rutina sobre PostgreSQL embebido.

Referencias: [métodos dinámicos](https://docs.stripe.com/payments/payment-methods/dynamic-payment-methods), [errores e idempotencia](https://docs.stripe.com/error-low-level), [cambios de API](https://docs.stripe.com/changelog).

## Estado de entrega inicial (referencia)

Implementación local, sin migraciones remotas ni despliegues. Se ha consultado el MCP oficial con `livemode=false` en **Entorno de prueba de Alteil Solutions SL**. En la comprobación del 20 de octubre de 2026 no había configuraciones de Customer Portal ni endpoints webhook en ese sandbox.

El código rechaza claves live y respuestas `livemode=true`. La autenticación del MCP de Codex no proporciona credenciales a las Edge Functions. Hace falta configurar los secretos de ejecución indicados abajo y aplicar la migración en un entorno aislado para probar cobros simulados reales.

## Reutilización de la arquitectura

- Empresa: `tenants`; locales: `venues`; dispositivos: `devices`.
- Autorización: `profiles.is_superadmin`, membresía activa `tenant_memberships`, propietario para facturación propia. Managers/cashiers no reciben acceso financiero.
- Derechos existentes: `platform_features`, `tenant_feature_assignments`, `venue_addon_assignments`. Se conservan aliases N-1.
- Superadmin: entrada Facturación, cargada de forma diferida dentro de la navegación existente.
- CRM: se conserva el resumen actual de recursos de Mi Plan y se añade la gestión comercial propia.
- El refresco existente de funcionalidades usa una lectura local por local para sesiones con venue. Conserva su intervalo de 60 segundos, deduplicación y comportamiento offline. No hay consultas a Stripe desde ventas, impresión, caja o fiscalidad.

La revisión dirigida no encontró un catálogo monetario versionado existente. No se han sembrado Business a 149 €, ni los importes históricos de reservas, producción, compras, hardware o locales como tarifas definitivas. Los addons existentes se importan como borradores inactivos, sin precios; Superadmin debe introducir y aprobar las condiciones comerciales vigentes. No se inventan otros planes.

## Contratos y reglas comerciales

`billing_products` guarda la identidad comercial estable. `billing_price_versions` guarda tarifa mensual **o** anual, funcionalidades, límites, dependencias y unidades incluidas. Cada cambio de precio o contenido crea otra versión: los contratos actuales conservan sus versiones, precios Stripe y snapshots.

Un contrato contiene un plan y hasta 19 líneas adicionales. Tickit calcula cantidades contratadas, incluidas y facturables; Stripe recibe una sola suscripción consolidada. La asignación de cada addon a locales o dispositivos permanece en el snapshot de Tickit. Los IDs enviados desde el navegador se contrastan con empresa, catálogo, intervalo, máximo y uso real. El navegador no puede enviar importes ni price IDs.

Para nuevas contrataciones solo se admite la última tarifa publicada de cada producto/intervalo. Los clientes actuales pueden conservar las versiones de su propio contrato; no pueden enviar IDs de tarifas históricas ajenas para obtener precios anteriores. Superadmin puede seleccionar una tarifa histórica como condición comercial explícita y auditada.

La autogestión conserva las excepciones ya aprobadas del cliente. Solo Superadmin puede introducirlas, sustituirlas o retirarlas; cambiar unidades desde CRM no elimina por accidente un acuerdo comercial.

Una funcionalidad incluida globalmente en el plan no vuelve a cobrarse como addon. Las inclusiones con cupo usan `included[addonKey]` y descuentan las unidades antes de generar los items. Cambiar de plan conserva la selección y asignaciones de addons; si cambia el intervalo, se requiere tarifa compatible para cada addon.

- Aumento: inmediato con `always_invoice`, fecha de prorrateo fijada y `pending_if_incomplete`.
- Reducción, retirada o reasignación que quita acceso: próxima renovación mediante Subscription Schedules.
- Un cambio mixto con reducciones se programa completo. Los cambios de intervalo también se programan.
- Cancelación inmediata sin reembolso/prorrateo, o cancelación al vencimiento: ambas requieren vista previa y confirmación.
- Excepción permanente: unidades gratuitas, precio particular, descuento o límites especiales, sin cambiar tarifas generales.
- Excepción temporal: ciclos completos desde la siguiente renovación, con fase de restauración de condiciones generales. No se admiten fechas arbitrarias ni concesiones temporales antes del primer alta.

`billing_operations` persiste la vista previa durante cinco minutos y serializa cambios por empresa. Antes de confirmar se comprueba de nuevo Stripe y el importe. Si la operación económica queda incierta, permanece `applying`: la recuperación reutiliza su misma clave de idempotencia durante menos de 23 horas. Después se exige conciliación manual antes de ejecutar otra operación, para no fiarse de una clave que Stripe puede haber caducado. No se reconstruyen cargos con IDs nuevos.

Hay como máximo un cambio económico pendiente por empresa. Un calendario o pago pendiente bloquea cambios solapados; esta restricción es deliberada para evitar carreras entre calendarios y ampliaciones. Un Checkout abandonado puede continuarse desde el historial; cuando expira, su operación se libera por conciliación.

## Persistencia, seguridad y continuidad

Migración nueva: `supabase/migrations/20261020174341_stripe_billing_foundation.sql`, generada con `supabase migration new`, clasificada expand y comprobada con el analizador del proyecto. No cambia migraciones históricas. Se ha revisado `contracts-pending.yml`; sus limpiezas de tickets, exportación contable y fiscalidad son ajenas a esta integración y no se consumen junto con este expand compatible.

Tablas nuevas:

| Tabla | Uso |
| --- | --- |
| `billing_products` | Catálogo estable, estado y ámbito |
| `billing_price_versions` | Tarifas y reglas inmutables |
| `billing_accounts` | Cliente/suscripción Stripe, contrato económico y permisos efectivos, gracia y conciliación |
| `billing_operations` | Presupuestos, estados intermedios, calendarios, excepciones e idempotencia |
| `billing_invoices` | Histórico financiero y snapshots del emisor y pagador |
| `billing_stripe_events` | Identidad del evento, estado, intentos y fallo sanitizado |
| `billing_audit` | Actor, momento, motivo y efectos confirmados |

Todas tienen RLS. Las escrituras se reservan a `service_role`; las cuentas y facturas propias tienen lectura para el owner mediante RLS. Las lecturas administrativas pasan por la Edge Function, que valida el rol con datos de servidor, no con `user_metadata`.

La transición de estado se ejecuta en una transacción SQL con bloqueo de la cuenta y revisiones optimistas. La conciliación tiene un token de exclusión con caducidad; una respuesta antigua no puede sobrescribir otra más reciente. Los webhooks verifican HMAC del cuerpo original, tolerancia temporal y modo sandbox. Se persisten IDs, no cuerpos webhook con PII. Los eventos duplicados se ignoran y los desordenados vuelven a consultar el estado actual de Stripe.

Los clientes manuales mantienen sus derechos hasta el primer contrato confirmado. Un `pending_update`, impago, cancelación o fallo de Stripe no borra derechos operativos ni información. La gracia configurable produce estados comerciales `current`, `grace` y `restricted`; tras ella se restringen nuevas ampliaciones en mora, no ventas ni caja.

Una bajada confirmada que reduzca acceso mientras haya cajas o comandas abiertas difiere su proyección de permisos hasta el cierre operativo. `billed_contract` ya refleja las condiciones económicas nuevas para no inflar MRR; `contract` mantiene temporalmente los derechos anteriores. La supervisión muestra la espera. No se cierran cajas, no se modifican ventas y no se tocan números de ticket ni documentos fiscales.

Las pantallas antiguas de asignación no pueden saltarse un contrato Stripe. Los locales nuevos reciben desactivadas las funcionalidades con asignación comercial por local, hasta contratar/asignar sus unidades. Tickit Assist conserva su contrato por empresa y su interruptor operativo existente por local; los productos por dispositivo amplían capacidad, no crean permisos por dispositivo que el sistema actual no sabe aplicar.

## API y pantallas

`POST /functions/v1/billing`, JWT verificado dentro con `auth.getUser()`:

| Acción | Autorización y comportamiento |
| --- | --- |
| `catalog` | Usuario autenticado; solo versiones publicadas para no administradores |
| `overview` | Superadmin; MRR, ARR, estados, clientes y supervisión |
| `get` | Superadmin u owner de esa empresa; datos, locales, recursos, facturas e historial |
| `catalog-save`, `catalog-publish` | Superadmin; nueva tarifa y publicación en Stripe test |
| `quote`, `confirm` | Superadmin u owner; selección validada, importes y confirmación |
| `quote-cancel` | Superadmin; previsualización de cancelación |
| `portal` | Superadmin u owner; sesión para el cliente de esa empresa |
| `settings` | Superadmin; ficha interna de facturación y días de gracia |
| `reconcile` | Superadmin u owner de esa empresa |
| `reconcile-batch`, `retry-event`, `retry-operation` | Superadmin; recuperación sin duplicar efectos |

`POST /functions/v1/billing-webhook`: firma Stripe obligatoria, sin JWT de usuario. Eventos relevantes: Checkout completado/expirado/pago asíncrono, creación/actualización/baja de suscripción, actualización pendiente aplicada/expirada, factura pagada/fallida/con autenticación y cambios de calendario. Los eventos desconocidos se registran e ignoran.

`POST /functions/v1/billing-reconcile`: secreto de scheduler independiente, mínimo 32 caracteres. Procesa hasta diez cuentas por lote, ordenadas por último intento para que una cuenta fallida no bloquee a las demás. El endpoint administrativo procesa veinte. El planificador periódico se configura fuera de la migración, en el entorno elegido.

`get_current_billing_venue_features(tenant,venue)` es la nueva lectura de funcionalidades persistidas para sesiones POS; valida acceso al local y usa los índices existentes. El fallback N-1 conserva la lectura anterior si la RPC todavía no está desplegada. No modifica RPCs de venta.

Superadmin incluye resumen, búsqueda por empresa/NIF y filtro de estado, detalle, editor de catálogo con funcionalidades/límites/inclusiones, excepciones, confirmación de importes, cancelaciones, facturas, auditoría y reintentos. CRM permite configurar el contrato propio y abrir Portal. El portal se rechaza si su configuración permite modificar o cancelar suscripciones: esos cambios se gestionan en Tickit.

MRR/ARR: contrato consolidado activo o `past_due`, sin impuestos ni prorrateos; año = precio mensual por doce o tarifa anual, y MRR = ARR/12 con redondeo final. Pruebas y cuentas manuales quedan fuera. Cobrado = facturas pagadas del mes; se muestran importes con y sin impuestos, separados de lo contratado. No equivale a liquidaciones bancarias y no incluye conciliación de reembolsos/abonos. Las cuentas de MRR se paginan; los datos auxiliares del dashboard tienen un límite visible de 1000 filas y avisan si se alcanza. El histórico por empresa muestra las últimas 100 facturas y 50 operaciones; el Portal ofrece el histórico completo.

## Variables de entorno

Solo en Edge Functions, nunca con prefijo `VITE_` ni dentro del repositorio:

| Variable | Contenido |
| --- | --- |
| `SUPABASE_URL` | Proyecto aislado local o staging |
| `SUPABASE_ANON_KEY` | Clave pública para validar la sesión |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave del servidor para transiciones autorizadas |
| `STRIPE_TEST_SECRET_KEY` | Clave `sk_test_…` o `rk_test_…` con los permisos necesarios |
| `STRIPE_TEST_WEBHOOK_SECRET` | Firma `whsec_…` del endpoint test o de Stripe CLI |
| `STRIPE_TEST_PORTAL_CONFIGURATION_ID` | Configuración `bpc_…` del mismo sandbox |
| `BILLING_APP_URL` | Origen de la aplicación, sin slash final; p. ej. `http://localhost:5173` |
| `BILLING_RECONCILE_SECRET` | Secreto aleatorio de al menos 32 caracteres, solo scheduler |

El navegador usa las variables públicas Supabase ya existentes. No necesita Stripe.js ni una clave secreta. No se han añadido dependencias de frontend ni modificado el lockfile de pnpm.

## Configurar y verificar sandbox

1. Preparar una base **aislada** con el baseline actual de Tickit. Revisar/aplicar allí la migración nueva; no ejecutar `db push` contra producción. Las pruebas SQL incluidas ya ejercitan el expand en PostgreSQL embebido, sin servicios externos.
2. Configurar los secretos anteriores fuera de Git. La autorización MCP no los sustituye.
3. Ejecutar las tres funciones localmente o desplegarlas únicamente en un staging autorizado. Confirmar que `/crm` redirige a la entrada CRM habitual.
4. En Stripe test, configurar los datos legales del emisor y la política tributaria aplicable. No se ha supuesto ni codificado un IVA, ni activado Stripe Tax automáticamente. Antes de cobrar realmente, validar cómo se aplicarán impuestos y exenciones a Checkout y a las suscripciones.
5. Crear una configuración Portal test que permita actualizar métodos de pago/datos de facturación y consultar facturas. Deshabilitar `subscription_update` y `subscription_cancel`. Guardar su ID en el secreto correspondiente. La ficha interna de Tickit no sustituye al Portal para modificar datos fiscales del cliente Stripe ya creado.
6. Crear el endpoint test `/functions/v1/billing-webhook` con API version `2026-09-30.endive`, registrar los eventos indicados y guardar su secreto. Para desarrollo con Stripe CLI autenticada en el sandbox, `stripe listen --forward-to http://127.0.0.1:54321/functions/v1/billing-webhook`; usar su secreto de escucha para la función local.
7. En Superadmin crear/activar el plan, introducir los precios confirmados e inclusiones, guardar cada intervalo como versión independiente y publicar. Configurar también addon de local/dispositivo adicional si se van a comercializar esas unidades.
8. Abrir una empresa manual de prueba, completar ficha interna, elegir plan/addons/asignaciones, revisar importes y confirmar Checkout. Usar únicamente métodos de pago de prueba oficiales. Verificar que el retorno de Checkout por sí solo no activa derechos: debe procesarse el webhook o conciliación.
9. Programar un POST periódico autenticado a `billing-reconcile` con su secreto. Ajustar frecuencia y número de lotes al número de cuentas y a los límites de ejecución de las Edge Functions.
10. Realizar los veinte escenarios del requisito contra el sandbox real, incluidas renovaciones y fallo/recuperación. Las pruebas automatizadas locales de abajo no sustituyen esta aceptación externa. Para escenarios compatibles, usar Test Clocks siguiendo sus limitaciones oficiales; Checkout se valida también con su flujo normal de prueba. No se han ejecutado Test Clocks reales en esta sesión.

Documentación primaria consultada: [Stripe MCP](https://docs.stripe.com/mcp), [actualizar suscripción](https://docs.stripe.com/api/subscriptions/update), [vista previa de factura](https://docs.stripe.com/api/invoices/create_preview), [pending updates](https://docs.stripe.com/billing/subscriptions/pending-updates), [Subscription Schedules](https://docs.stripe.com/api/subscription_schedules/update), [changelog estable](https://docs.stripe.com/changelog), [Test Clocks](https://docs.stripe.com/billing/testing/test-clocks).

## Verificación y límites de la evidencia

Resultado final: **990 pruebas pasan**, de las que 37 son nuevas para esta integración; build correcto; lint sin errores; comprobación Deno correcta en las tres funciones. Una repetición dentro del sandbox de Windows falló al crear repositorios Git temporales del harness de migraciones; la repetición completa fuera de esa restricción pasó. La pasada final de tests/build/lint se ejecutó con pnpm 10.15.1 mediante el lanzador temporal `rtk pnpm dlx pnpm@10.15.1`, sin cambiar dependencias ni lockfiles.

Comandos ejecutados:

```text
rtk pnpm test
rtk pnpm lint
rtk pnpm build
rtk pnpm dlx pnpm@10.15.1 test
rtk pnpm dlx pnpm@10.15.1 lint
rtk pnpm dlx pnpm@10.15.1 build
rtk pnpm dlx deno check supabase/functions/billing/index.ts supabase/functions/billing-webhook/index.ts supabase/functions/billing-reconcile/index.ts
rtk git diff --check
```

La prueba visual se ejecutó con un montaje temporal fuera del repositorio, Vite y Playwright/Edge, sustituyendo solo el servicio de facturación por fixtures. No se han ejecutado advisors de un Supabase remoto ni se ha aplicado allí SQL.

- `tests/stripe-billing-domain.test.mjs`: importes enteros, inclusiones, multilocal, dispositivos, reglas de cambio, firma HMAC, fallos de transporte y métricas.
- `tests/stripe-billing-sql.test.mjs`: migración, inmutabilidad, RLS de cuentas/facturas, permisos de rutinas, exclusión por empresa, eventos duplicados/reintentos, fencing, asignaciones y continuidad durante un turno abierto.
- `tests/stripe-billing-service.test.mjs`: servicio real contra PostgreSQL embebido y **doble de Stripe**; Checkout pendiente/pagado, ampliación fallida/recuperada, eventos invertidos, cambio de local al vencimiento con mismos precios, recuperación de operación incierta, cancelación y excepción temporal/restauración.
- `tests/stripe-billing-auth.test.mjs`: handler real y contratos Zod; acceso a otra empresa, manager, excepciones no autorizadas, precios o campos manipulados.
- `tests/stripe-billing-feature-refresh.test.mjs`: una lectura persistida por refresco y fallback N-1 solo cuando falta la RPC; ningún acceso a Stripe.
- El prorrateo monetario definitivo se delega a Stripe; localmente se comprueban los parámetros y su fecha estable, no se reproduce una simulación fiscal de Stripe.
- Se han ejecutado lint, tests completos y build; las funciones pasan `deno check`. Lint conserva cuatro advertencias previas en CRM/restaurant; build avisa de que falta el token de publicación de Sentry, pero compila.
- QA visual local en Edge headless, con servicios sustituidos por datos ficticios: resumen → catálogo → cliente → cantidad de addon → local → presupuesto → modal, más CRM móvil 390×844. Escritorio 1440×1000. Identidad, contenido, ausencia de overlay, consola, interacción y desbordamiento horizontal comprobados. Browser plugin no disponible; se usó Playwright incluido en el runtime. No hubo acceso al backend real desde ese montaje.

## Facturación de Alteil y activación futura de producción

Las facturas de suscripción se almacenan aparte del SIF del restaurante, con snapshots de emisor/pagador y `fiscal_export_status='pending_review'`. Ese es el punto de integración para un adaptador fiscal propio de Alteil. No se afirma que un PDF Stripe cumpla automáticamente las obligaciones españolas y no se ha añadido Verifactu a esta integración.

Antes de producción quedan: tarifas y contenidos comerciales definitivos; política tributaria y revisión del circuito fiscal de Alteil; configuración y aceptación externa de Checkout/Portal/webhooks/calendarios; monitorización y scheduler; revisión de la migración sobre copia representativa; y decisión de permitir live mediante un cambio separado y revisado. Cambiar una clave no activa live en esta implementación. Cualquier migración, despliegue, configuración o dato de producción exige autorización explícita adicional conforme a AGENTS.md.
