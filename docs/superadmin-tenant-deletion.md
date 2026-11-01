# Eliminación definitiva de negocios desde Superadmin

Desactivar conserva los datos. Eliminar ejecuta la eliminación definitiva incluso
si existen facturas, ventas, registros fiscales o una suscripción activa. La
confirmación advierte de la pérdida de datos y de la baja en Stripe.

## Flujo

1. La Edge Function autentica al usuario y comprueba su perfil Superadmin.
2. `prepare_platform_tenant_deletion` desactiva el negocio y crea un trabajo
   persistente. Las políticas y triggers impiden nuevas lecturas operativas y
   escrituras, incluidos trabajos en segundo plano y subidas de archivos. Una
   operación comercial que esté aplicándose o una reconciliación con lease vigente
   debe terminar antes de preparar la eliminación; se devuelve un error reintentable.
3. Se comprueba la pertenencia del cliente de Stripe mediante
   `metadata.tickit_tenant_id` y se elimina mediante la API de Stripe. Según su
   [contrato de API](https://docs.stripe.com/api/customers/delete), eso cancela
   inmediatamente sus suscripciones activas. Si solo consta una suscripción, se
   verifica su pertenencia y se cancela sin prorratear ni emitir una factura final.
4. Se eliminan físicamente los archivos de Storage con su API, también los uploads
   abandonados bajo el prefijo UUID del negocio. Se relee la primera página
   después de cada lote para no saltarse objetos.
5. `purge_platform_tenant_data` elimina en una única sentencia/transacción todos
   los registros de tablas públicas con `tenant_id` UUID, incluidos históricos de
   caja, ventas, fiscalidad, producción, documentos y facturación. También elimina
   las solicitudes del bridge fiscal, los eventos de su cliente Stripe y las claves,
   enlaces, sesiones y solicitudes de Carta del esquema privado `tickit_private`.
   Las integraciones de Carta se deshabilitan ya durante la preparación. Las CTE
   comparten snapshot y permiten resolver referencias RESTRICT y ciclos entre
   registros del mismo negocio sin deshabilitar FK, RLS ni triggers globalmente.
6. Se eliminan mediante Auth los usuarios exclusivos, de forma física. Se confirma
   cada usuario eliminado en el trabajo persistente, con comprobación en Auth, para
   que un reintento continúe por los pendientes. Se conservan los Superadmin y las
   identidades utilizadas por otro negocio, su historial, archivos o datos globales.
7. Solo cuando han terminado las fases anteriores se elimina el negocio y el
   trabajo persistente. Un reintento después de perder la respuesta final también
   se considera completado si el negocio ya no existe.

Si falla un proveedor o se pierde una respuesta, el negocio permanece desactivado
y el trabajo conserva las referencias pendientes. El botón Eliminar permite
reanudarlo. No se devuelve éxito hasta que termina todo el flujo. Las fases externas
no pueden formar una transacción con PostgreSQL: una baja Stripe o un archivo ya
eliminado no se restauran si una fase posterior falla.

## Aislamiento y protecciones

La migración adapta los cuerpos existentes de los triggers DELETE conservando
su código y sus permisos. Solo el contexto transaccional de purga de `service_role`
para el UUID correspondiente permite saltar los bloqueos de inmutabilidad y los
efectos secundarios de esos DELETE. Los borrados y modificaciones ordinarios
mantienen sus protecciones. Un marcador configurado por `authenticated` no permite
activar la excepción. Las RPC de purga no son ejecutables por el navegador.

El control de escritura rechaza cualquier cascada que intente modificar otro
negocio. Una discrepancia provoca rollback de la fase completa de datos. Las
restricciones no se convierten globalmente a CASCADE. Los eventos tardíos de Stripe
de clientes eliminados no vuelven a introducir sus referencias en la base de datos.

Las tablas nuevas con `tenant_id` deben incorporar el trigger
`guard_platform_tenant_deletion_write` y la política restrictiva equivalente. Todo
nuevo trigger DELETE debe admitir el contexto de purga mediante
`platform_tenant_purge_allowed`. Si falta el control de escritura de una tabla nueva,
la RPC rechaza la purga para exigir revisión del esquema.

## Alcance externo

Este flujo elimina los datos y archivos gestionados por esta aplicación. La baja
del cliente Stripe no equivale a borrar todos los registros históricos que Stripe
conserva. Tampoco reescribe copias de seguridad, registros de proveedores, archivos
ya exportados, equipos de impresión o cachés de PWAs que estén desconectadas. Su
retirada requiere el proceso correspondiente de cada sistema. El catálogo y el
conocimiento global compartido con otros negocios se conservan.

La integración Stripe mantiene el modo sandbox y la versión de API existentes.
No se habilitan claves live como parte de este cambio.

## Publicación y verificación

No se ha aplicado nada en producción. Aplicar las dos migraciones nuevas en orden
(si la primera ya está aplicada, solamente queda la segunda):

- `20261101190202_allow_unused_tenant_billing_cleanup.sql`.
- `20261101192516_add_platform_tenant_purge.sql`.

Después publicar `manage-pos-users` con el módulo compartido
`_shared/platform-tenant-deletion.ts` y el frontend actualizado. La instalación no
elimina datos existentes. El pipeline puede exigir revisión del contenido SQL por
las adaptaciones de triggers y los permisos internos; no se omite ese control.
El endpoint anterior sigue siendo compatible; las RPC nuevas implementan la purga
completa cuando se publica la Edge Function actualizada.

`tests/functional/platform-tenant-purge.test.ts` ejecuta las fases SQL y el
orquestador real contra PostgreSQL embebido, con dobles solo en las fronteras de
Stripe, Storage y Auth. Comprueba históricos, FK cíclicas, permisos, aislamiento,
fallos y reanudación. `platform-tenant-deletion.test.ts` conserva la reproducción del
fallo original y la compatibilidad de la primera migración.
