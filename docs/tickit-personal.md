# Integración Tickit Personal

El módulo Personal forma parte del servidor `@tickit/api` que ya utiliza Tickit Carta. No necesita otro servidor: Carta conserva `/v1/*` y Personal utiliza `/personal/link` y `/personal/events`, con su propio contrato HMAC y credenciales. El endpoint que se introduce en Personal es `https://<dominio-api-existente>/personal`.

## Activación

1. Aplicar por el procedimiento habitual la migración POS `20261102163328_tickit_personal_integration.sql` y la migración Personal `20261102164434_personal_pos_offline_pin.sql`. Desplegar el frontend y API del POS, la Edge Function `manage-pos-users`, y el frontend y worker de Personal. La preparación local no aplica cambios a producción.
2. En Superadmin, publicar la tarifa mensual/anual del producto **Tickit Personal** usando el catálogo Stripe existente. Se contrata por empresa. La migración crea el addon sin inventar importes ni publicar precios. Se mantienen las asignaciones manuales para los negocios que todavía no utilizan facturación gestionada.
3. El owner puede activar desde CRM → Integraciones → Tickit Personal eligiendo una contraseña para Personal de al menos 6 caracteres, igual o distinta a la del POS. Se valida la sesión, el addon y el rol owner; después se crea su acceso a Personal y se vinculan automáticamente la empresa y sus locales. Si el correo ya existe en Personal, se exige su contraseña de Personal y no se sobrescribe la cuenta. Las contraseñas posteriores son independientes. Los reintentos reutilizan el vínculo, sin crear empresas duplicadas.
   Para la vinculación manual, el owner prepara una conexión en Personal con el ID de empresa POS como empresa externa y el endpoint anterior. El dominio de la API debe estar autorizado en `POS_ALLOWED_HOSTS` de Personal.
4. En CRM → Integraciones → Tickit Personal, introducir los identificadores de conexión y empresa de Personal, su clave compartida y la correspondencia de locales. Guardar y confirmar la vinculación desde Personal. Cada local se corresponde con un único local de la otra aplicación. Los locales sin correspondencia mantienen su operativa habitual.
5. En Personal, guardar de nuevo los PIN existentes (6–12 dígitos), configurar los permisos POS de los roles y solicitar reconciliación. Los PIN bcrypt existentes no se pueden convertir al nuevo verificador. No es necesario cambiar el valor del PIN.
6. Iniciar sesión en cada dispositivo con conexión una vez para descargar la plantilla y comprobar la selección de trabajador.

Los accesos de dispositivos, owner y managers del CRM siguen gestionándose en POS. Las fichas, asignaciones, roles y PIN de trabajadores se gestionan en Personal.

### Configuración de la activación automática

Desplegar la función POS `activate-personal` y configurar en su runtime `PERSONAL_SUPABASE_URL` (URL HTTPS pública de Supabase Personal) y `PERSONAL_SUPABASE_ANON_KEY` (su clave pública). Utiliza las variables `SUPABASE_URL` y `SUPABASE_ANON_KEY` existentes para verificar la sesión POS. No necesita una service role de Personal en POS ni variables nuevas del frontend.

En Personal aplicar la migración `20261102211353_personal_pos_activation.sql` y desplegar `pos-activate` y `_shared/pos-activation.ts`. Configurar `POS_SUPABASE_URL`, `POS_SUPABASE_ANON_KEY`, `POS_INTEGRATION_ENDPOINT=https://<dominio-api>/personal` y `POS_ALLOWED_HOSTS=<dominio-api>`, además de las variables Supabase y `APP_ORIGIN` existentes. Desplegar también el worker para sincronizar los trabajadores. La API y el módulo POS deben estar actualizados, con su migración de integración aplicada.

La contraseña viaja solo durante la activación por HTTPS y se utiliza exclusivamente para crear o acceder a la cuenta de Personal mediante Supabase Auth. No se compara ni cambia la contraseña del POS. No se persiste en tablas de integración ni se registra en logs. Solo se revoca la sesión temporal de Personal, conservando la sesión del navegador. Las cuentas con MFA en POS requieren una sesión `aal2`; las cuentas existentes con MFA en Personal deben vincularse manualmente.

## Operación local

Los trabajadores se guardan en una caché versionada por ruta POS, empresa, local, dispositivo y cuenta. Se actualizan al iniciar la sesión del dispositivo, cada 30 segundos y al recuperar conexión o visibilidad. Un error de red, HTTP, validación o almacenamiento no sustituye una caché válida por una lista vacía. La plantilla queda disponible antes de introducir el PIN del trabajador.

Se verifica el PIN con PBKDF2-SHA256, sal aleatoria de 16 bytes y 210.000 iteraciones; nunca se almacena ni transmite el PIN en claro al POS. Cinco intentos fallidos bloquean ese trabajador durante 15 minutos en el dispositivo. El primer acceso de un dispositivo sin caché requiere sincronización; no se inventan usuarios o permisos si nunca se han descargado.

Por decisión operativa, `policy_expires_at` no bloquea el POS: se conservan los últimos permisos conocidos mientras el backend no esté disponible. Las bajas, cambios de PIN y revocaciones se aplican al recibir una actualización válida. Los cambios se difieren hasta terminar los cobros u operaciones de hardware que estén en curso. Desactivar la integración tampoco llega a un dispositivo que esté desconectado hasta que pueda sincronizar.

Cambiar trabajador pide su PIN y conserva el ticket y la caja. No está disponible durante un cobro, una operación de caja/hardware o el guardado de una comanda. La identidad del trabajador no sustituye el `userId`, rol, dispositivo o sesión de Supabase de la cuenta del terminal. Las autorizaciones del dispositivo y el aislamiento de empresa/local se conservan.

## Permisos

| Personal | Operación POS |
| --- | --- |
| `pos.order.create` / `pos.order.modify` | Añadir y modificar líneas/comandas |
| `pos.item.void` / `pos.order.void` | Retirar unidades o líneas; descartar/anular ventas y comandas |
| `pos.payment.take` / `pos.payment.modify` | Cobrar / cambiar forma de cobro |
| `pos.discount.manual` / `pos.promotion.apply` | Descuentos manuales / selección de promociones, con sus límites de porcentaje e importe |
| `pos.refund` | Devoluciones |
| `pos.drawer.open` | Apertura manual del cajón |
| `pos.cash.open` / `pos.cash.close` / `pos.cash.move` | Abrir/cerrar caja / movimientos de caja |
| `pos.sales.read` | Históricos, resumen y reimpresiones |
| `pos.price.modify` | Modificar el precio de una línea |
| `pos.inventory.manage` | Preparaciones de inventario |

Las promociones automáticas y la recuperación de operaciones económicas ya aceptadas conservan sus flujos existentes. Esta integración no añade fichajes, envío de actividad comercial a Personal ni autorizaciones extraordinarias por segundo trabajador; la selección de un trabajador autorizado permite cambiar de permisos.

Sin addon o sin vinculación activa, no se requiere trabajador ni PIN y la operativa existente permanece intacta. El servidor no permite configurar, negociar o ingerir snapshots para empresas sin el addon. Los secretos se almacenan en un esquema privado y solo el servidor puede consultar las credenciales e ingerir snapshots firmados. El dispositivo solo recibe los trabajadores y políticas de su local.

## Verificación

`pnpm test` cubre los contratos firmados, el aislamiento y orden de snapshots en PostgreSQL embebido, la caché, el PIN local, los límites y las acciones denegadas. `pnpm lint` y `pnpm build` validan el POS y la API. En Personal: `pnpm lint`, `pnpm test`, `pnpm typecheck`, `pnpm build` y `pnpm test:db` comprueban el verificador y su publicación/revocación con PostgreSQL local.

Las migraciones son aditivas y mantienen la compatibilidad con clientes anteriores; los contracts pendientes existentes no se consumen porque no se retira ninguna estructura de sus migraciones.

El campo del POS valida un mínimo de 6 caracteres antes de enviar la solicitud; ambas funciones también lo validan. En el servicio Auth self-hosted de Personal configurar `GOTRUE_PASSWORD_MIN_LENGTH=6`.
