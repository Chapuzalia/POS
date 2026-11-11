# Alta de negocios con Stripe

> **Histórico.** La facturación usa Mollie desde 2026-11: ver [mollie-billing.md](mollie-billing.md).

El modal de Superadmin permite mantener el alta manual o preparar una suscripción
con un plan y extras del catálogo publicado. No crea suscripciones ni cobra al dar
de alta. El servidor calcula importes y límites desde las versiones del catálogo;
el navegador solo envía identificadores, cantidades y asignaciones. Los extras por
local se asignan al primer local. Las unidades adicionales quedan disponibles para
futuros locales.

El botón Generar utiliza aleatoriedad criptográfica y crea una contraseña de ocho
caracteres. Se puede mostrar u ocultar. La bienvenida se envía mediante Resend
después de completar el alta. No se guardan contraseñas en tablas de facturación,
colas de envío ni logs.

## Correo de bienvenida

`manage-pos-users` utiliza `RESEND_WELCOME_API_KEY`, disponible únicamente en el
servidor. No se añaden variables de entorno para las plantillas.
El enlace de acceso usa el origen de `BILLING_APP_URL`, ya existente, con ruta
`/crm`; no se acepta un enlace enviado por el navegador. Requiere HTTPS, salvo
localhost en desarrollo. El subdominio remitente debe estar verificado en Resend.

Las altas Stripe usan la plantilla publicada de Resend
`23a9523e-2c39-405f-8cf4-99dfa8ba8160`, identificada en `_shared/welcome-email.ts`.
El servidor envía únicamente destinatario y `template` con las variables
`OWNER_NAME`, `BUSINESS_NAME`, `USER_EMAIL`, `INITIAL_PASSWORD` y `LOGIN_URL`.
Son valores escapados para los nodos y atributos HTML de la plantilla; no deben
reutilizarse como variables del asunto o encabezados, donde aparecerían entidades
HTML. El asunto actual es fijo. No se envían `html`, `text` ni adjuntos en este flujo.
Diseño, logo y textos de Mi Plan/pago/SEPA se gestionan en Resend. La plantilla
debe tener también sus valores predeterminados de remitente, asunto y Reply-to:
`Tickit <bienvenida@notificaciones.tickitpos.com>`,
`Bienvenido a Tickit · Tus datos de acceso` e `info@tickitpos.com`.
El servidor no los sobrescribe, por lo que pueden editarse en Resend y publicarse.
Si la plantilla falta, no está publicada o Resend la rechaza, se informa del fallo;
no se sustituye por otro correo local.

Por decisión del usuario, las altas manuales conservan su correo actual en código,
con esos mismos remitente/asunto/Reply-to y el texto de acceso inmediato. Incluye
HTML escapado y texto plano. El HTML usa tablas con estilos inline, cabecera
corporativa y el logo oficial `public/logo_black.png` adjunto mediante CID. Su copia base64
en `_shared/welcome-email-logo.ts` conserva los bytes originales y se verifica en
tests. No depende de que el cliente de correo pueda acceder a imágenes de
Staging. La visualización final depende del soporte y ajustes de cada cliente.

La petición a Resend tiene un tiempo máximo de ocho segundos y un único reintento
para fallos de transporte o respuestas transitorias, conservando el mismo cuerpo
y la clave `tickit-welcome/<ownerId>/v1`. Resend mantiene su idempotencia durante
24 horas; aquí los reintentos solo se hacen dentro de la petición de alta. No se
crean una cola persistente ni un endpoint de reenvío de contraseñas.

La respuesta de alta añade `welcomeEmailStatus` sin cambiar los campos N-1:
`sent` (Resend aceptó el envío, no acredita entrega en bandeja), `failed`
(rechazo confirmado), `unknown` (resultado incierto) o `not_configured`.
Un fallo de correo no revierte el negocio ni sus usuarios. Superadmin muestra una
advertencia para comprobar Resend o entregar las credenciales por otro medio,
evitando volver a crear el negocio. Un servidor antiguo sin ese campo no se
presenta como envío correcto.

Para activar en el entorno autorizado, desplegar `manage-pos-users` junto con
`_shared/welcome-email.ts`, `_shared/welcome-email-logo.ts` y el frontend. No necesita otra migración. En el stack
self-hosted, la clave debe llegar al entorno efectivo de `supabase-edge-functions`;
una variable declarada en Coolify sin mapearla al servicio no es suficiente.
Usar el controlador de despliegue existente y validar primero en Staging con una
cuenta de prueba cuyo destinatario haya autorizado el envío. No utilizar
`supabase functions deploy` para este stack self-hosted.

La adopción de la plantilla solo cambia `_shared/welcome-email.ts` en el bundle de
`manage-pos-users`; no necesita un nuevo frontend, migración ni secreto. Validar
en Staging un alta Stripe y otra manual con destinatario de prueba autorizado,
incluidos enlace, logo y credenciales renderizadas. No se ha enviado correo real
ni desplegado esta adaptación desde la sesión local.

## Acceso y pago inicial

Los negocios nuevos con Stripe nacen con
`tenants.billing_activation_required=true`. Su selección comercial se guarda en
`billing_accounts.onboarding_contract`, separada de los permisos efectivos. El
propietario inicia sesión normalmente y solo ve Mi Plan: resumen de plan, extras,
capacidad, precio recurrente sin IVA y pago. Modificar plan contratado abre el
editor sencillo; guardar vuelve al resumen. Los importes finales con el IVA del
21 % se revisan antes de abrir Checkout.

El bloqueo se aplica también a RLS, a los helpers de autorización de negocio y a
la API de gestión de usuarios/locales que usa service role. La lectura de tenant,
membresía y facturación propia sigue disponible para iniciar sesión y pagar. Las
pantallas operativas del CRM no se montan mientras haya bloqueo.

Un Checkout abierto debe caducar en Stripe antes de permitir cambios en la
selección. Un pago que ya se está procesando no se libera para crear otro. Las
ediciones invalidan los presupuestos anteriores bajo el bloqueo de cuenta y las
operaciones económicas conservan la exclusión e idempotencia existentes.

La redirección del navegador no activa el negocio. El webhook o la conciliación
debe confirmar una suscripción activa y contrato reconocido, con factura pagada o
con [autorización SEPA verificada y cobro en trámite](stripe-sepa.md). Una prueba
gratuita sin pago ni esa autorización no retira el bloqueo inicial. Mi Plan comprueba
el estado inmediatamente al volver de Checkout y continúa comprobándolo cada diez
segundos mientras esté pendiente; ofrece también actualización manual como respaldo.
Tras activarse se recarga la sesión
para leer las funcionalidades efectivas. Los negocios manuales y las
suscripciones existentes mantienen su comportamiento y continuidad operativa.

## Preparación y despliegue

Migración nueva: `20261101164502_tenant_stripe_onboarding.sql`, generada con la CLI.
Se añaden columnas compatibles y controles para el nuevo estado, sin modificar
migraciones históricas. Se ha revisado `supabase/contracts-pending.yml`: las
retiradas de tickets, contabilidad y fiscalidad no pertenecen a este cambio y no
se consumen en un expand de altas.

Aplicar primero la migración, después `manage-pos-users`, `billing`,
`billing-webhook` y `billing-reconcile`, y finalmente el frontend. Las cuentas
manuales no envían la nueva columna al crearse. El cliente admite servidores N-1
sin la RPC nueva, pero estos no pueden crear altas con pago pendiente.

La migración instala policies restrictivas en las tablas públicas que tienen
`tenant_id` y RLS, conservando sus policies de aislamiento actuales. Su bloque
`DO` de instalación es señalado por el checker como `ANONYMOUS DO BLOCK`: requiere
revisión y autorización exacta en el pipeline antes de aplicarlo; los comentarios
no lo autoautorizan. Las tablas futuras con autorización independiente deberán
preservar este bloqueo.

Se conserva el modo sandbox y la versión de API de Stripe existente. No se han
aplicado migraciones remotas, enviado correos, creado recursos reales en Stripe ni
desplegado cambios. Quedan pendientes la aceptación contra Stripe sandbox real y
los permisos explícitos para cualquier actuación sobre producción.

## Verificación

- Vitest: generación de contraseña, navegación restringida, validación del catálogo,
  asignación inicial de extras, pago fallido, activación pagada, prueba gratuita,
  Checkout caducado, pago en proceso, presupuestos obsoletos y aislamiento SQL.
- Regresión del endpoint de accesos: propietarios pendientes no pueden listar
  cuentas ni crear locales o usuarios por la API privilegiada.
- Bienvenida: remitente/respuesta, credenciales escapadas, enlace de confianza,
  separación manual/Stripe, configuración ausente, rechazos, incertidumbre,
  idempotencia y ausencia de envíos tras un alta fallida. Un fallo de correo
  conserva el alta completada.
- `pnpm test`, `pnpm lint`, `pnpm build` y comprobación Deno de las funciones.
- QA local con Playwright/Edge en 1440×1000 y 390×844 y servicios sustituidos por
  datos ficticios. Recorrido: alta Stripe y generación de contraseña; Mi Plan →
  modificar extra → guardar → revisar importe → enlace Checkout. Sin errores de
  consola ni desbordamiento horizontal. Browser plugin no disponible.
