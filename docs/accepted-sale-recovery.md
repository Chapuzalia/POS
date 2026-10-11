# Cobros aceptados: conservación y recuperación

Una vez que el sistema acepta un cobro, los errores de inventario, rentabilidad,
estadísticas, producción, impresión o configuración comercial secundaria no deben
eliminar la venta ni convertirla en otro ticket cobrable.

## Frontera económica

- Antes de iniciar Cashlogy o enviar una RPC se guarda en IndexedDB la operación
  original, sus IDs, importes y snapshots. Cashlogy utiliza un request ID estable.
- Las ventas rápidas guardan venta, pago, operación y evento pendiente en una
  transacción IndexedDB. Las facturas mantienen la transacción del ledger SIF que
  guarda identidad fiscal y snapshot económico juntos.
- Los pagos de mesa conservan los parámetros originales y, en producción fiscal,
  el envelope exacto antes de enviar la RPC. La respuesta perdida se recupera
  reproduciendo esa identidad; no se vuelve a cobrar en la máquina.
- Un fallo de costes deja `theoretical_cost_known=false` y coste nulo. Componentes,
  snapshots comerciales y pases de producción tienen fallos independientes con
  incidencias en `sale_auxiliary_failures`. Esa tabla contiene referencias y
  SQLSTATE, sin cuerpos de documentos ni mensajes SQL con datos personales.
- Impresión, estadísticas y cachés son posteriores al guardado económico. Sus
  fallos se presentan como incidencias de una venta guardada.

## Recuperar una operación

1. Mantener el mismo navegador, usuario, dispositivo y sesión de caja. Conservar
   IndexedDB y localStorage; no borrar los datos del sitio ni reinstalar la PWA.
2. Al volver a abrir la sesión, se intenta recuperar el cobro rápido y los pagos
   de mesa pendientes con sus datos originales, aunque la mesa ya esté cerrada o
   no aparezca en el mapa. Cashlogy en estado incierto se consulta por request ID:
   no se crea automáticamente otro cobro. Una operación sin respuesta concluyente
   sigue pendiente y exige revisar el estado de la máquina.
3. Tras recuperar, revisar el histórico. Los productos nuevos del ticket no se
   cobran durante la recuperación. Las líneas del borrador que pertenecían a la
   venta ya guardada no pueden iniciar un segundo cobro por un fallo de caché o
   por un cambio posterior de promoción.
4. Si falta espacio, liberar espacio ajeno al almacenamiento del TPV y reintentar
   la recuperación. El journal conserva la identidad anterior cuando aborta la
   transacción de guardado final.
5. Un rechazo real por caja cerrada mantiene la venta y su evento pendientes de
   conciliación. Registrar sus IDs de evento, venta, ticket, pago y caja original;
   revisar servidor, ledger fiscal y Cashlogy antes de intervenir. No trasladar
   automáticamente la operación a otra caja ni crear una venta sustitutiva. La
   conciliación requiere una intervención autorizada que conserve esa historia.
6. La falta de IVA válido o identidad fiscal se comprueba antes del nuevo cobro.
   No se inventan tipos impositivos ni se eliminan las validaciones fiscales para
   recuperar una operación aceptada. Una factura de mesa pendiente de conciliación
   bloquea nuevas emisiones en esa instalación para no reutilizar su numeración.

Las incidencias auxiliares requieren corregir la configuración y reconciliar sus
datos secundarios usando los IDs originales. Este cambio no recalcula costes ni
inventario histórico automáticamente ni modifica importes, impuestos o facturas
ya expedidas.

## Cancelar y reiniciar Cashlogy

«Cancelar cobro» libera también el journal cuando el intento no llegó a enviarse,
el agente confirma que no existe y no está activo, o termina cancelado/fallido.
Los estados inciertos mantienen la revisión explícita de máquina y efectivo.
Si termina cobrado, cerrar el intento conserva la confirmación en el journal antes
de cerrar su registro en el agente; el siguiente pago recupera esa venta.

«Volver a cobrar» conserva la venta original y crea un request ID nuevo para el
nuevo intento físico. Ese ID se guarda en IndexedDB antes de enviar el cobro.
Si se pierde la respuesta o se recarga el TPV, se consulta ese último ID, sin volver
a enviar el cobro. Un 404 abre los controles de cancelación/reinicio; un timeout
conserva el intento pendiente. El ID anterior no se reutiliza para reiniciar.

## Despliegue y compatibilidad

Aplicar primero `20261011104456_protect_accepted_sales.sql` y después publicar el
cliente. La migración es expand: conserva las firmas y RPC anteriores para N-1.
Las conversiones de inventario requieren la misma unidad de contenido explícita y
cantidades positivas; no se deduce equivalencia por nombres como «botella».

El almacenamiento local SIF pasa de versión 4 a 5, añadiendo stores sin borrar el
ledger. Las colas legacy de localStorage siguen leyéndose. La cola nueva se aísla
por aplicación; operaciones e histórico por tenant, local, dispositivo, usuario y
sesión. Cerrar las pestañas de clientes antiguos antes de actualizar el mismo
dispositivo. No volver a un cliente que solo abra IndexedDB v4 tras esta
actualización: conservar v5 y preparar una corrección compatible hacia delante.

Se revisó `supabase/contracts-pending.yml`. Sus tres contratos destructivos siguen
pendientes: aplicar `SET NOT NULL` o retirar RPC/tablas legacy en este expand
rompería la compatibilidad N-1. Deben consumirse en un contract separado después de
verificar la retirada de clientes y la migración histórica correspondiente.

Las regresiones SQL se ejecutan con PGlite y las transacciones locales con
fake-indexeddb. Los casos de red perdida, cuota, caja cerrada, costes, componentes,
pases e impresión están simulados; validar además en staging con el agente físico
Cashlogy, impresora y varias pestañas antes del despliegue de producción.
