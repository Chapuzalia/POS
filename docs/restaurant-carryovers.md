# Traspaso de pedidos entre turnos

## Uso

El cierre consulta los pedidos abiertos y los cobros confirmados. Con pedidos abiertos,
ofrece «Volver y revisar» o «Traspasar al siguiente turno y cerrar». Antes de cerrar se
guarda el borrador de mesa y se sincronizan las operaciones locales. Una venta rápida
sin guardar debe cobrarse o guardarse en una mesa primero.

Al abrir un turno posterior del mismo local, las mesas pendientes se recuperan por defecto
dentro de la misma transacción que abre la caja. Durante cinco segundos aparece el aviso
«Se han cargado las mesas pendientes del turno anterior.» con la acción «No cargar» y un
contador circular. Si se pulsa, las mesas vuelven a quedar pendientes para la siguiente
apertura y las mesas físicas quedan disponibles de inmediato; al terminar el contador,
la recuperación queda confirmada.

## Modelo y contabilidad

- `orders.status = 'carried_forward'` suspende el pedido sin finalizarlo. Conserva su ID,
  grupo, líneas, descuentos, snapshots fiscales, notas, divisiones y producción.
- `restaurant_order_carryovers` registra un salto por grupo: origen, destino, pedidos
  incluidos, fechas, usuarios, dispositivos y distribución temporal de sus mesas.
  Un grupo solo puede tener un salto pendiente; puede tener cualquier número de saltos
  completados. Las cuentas que se dividen después siguen teniendo el mismo grupo.
- Al recuperar se actualizan únicamente el estado, turno, caja y revisión del pedido,
  el turno del grupo y la asignación/activación de las mesas virtuales. Se restaura
  la distribución guardada. Tras «No cargar», los vínculos `order_tables` se liberan
  y sus IDs se guardan para reactivar las mismas filas en una apertura posterior.
- Los tickets, ventas y pagos existentes no cambian de turno. El cierre existente
  suma exclusivamente ventas y pagos de tickets pagados en esa caja. Las partes
  cobradas antes del traspaso quedan en origen; las partes pendientes se cobran
  mediante las RPC existentes usando el turno recuperado.
- La trazabilidad del cobro completo queda en `orders.cash_session_id`; la de cobros
  parciales está en sus tickets/ventas y en `restaurant_order_equal_split_payments`.
  El historial de traspasos se consulta por `order_group_id`, con `order_ids` para
  identificar qué cuentas seguían pendientes en cada cierre.

No se crean pedidos ni líneas durante un traspaso. El stock se consume por líneas
de ticket mediante los mecanismos existentes. Producción mantiene lotes, asignaciones,
cantidades y solicitudes: no se insertan vínculos de mesa ni se vuelven a enviar comandas.
No se invoca el cálculo de promociones al traspasar o recuperar.

## Transacciones y sincronización

`carry_forward_and_close_cash_session` bloquea la sesión, los grupos y sus pedidos,
registra el salto, suspende los pedidos y llama al cierre existente en la misma
transacción. Cualquier fallo revierte también la suspensión y el historial.

El bloqueo de sesión impide aperturas y cobros nuevos durante el cierre. Los cobros
existentes bloquean grupo → pedidos → sesión; el traspaso usa `NOWAIT` para grupo y
pedidos, evitando invertir ese orden con una espera circular. Si hay una operación
en curso se devuelve un error para reintentar, sin efectos parciales.

`open_cash_register_session_with_carryovers` abre la caja y llama a
`recover_restaurant_carryovers` dentro de la misma transacción. Cada salto se bloquea y
se comprueba de nuevo antes de recuperarlo: una segunda petición obtiene cero y un
reintento antiguo no puede reclamar un salto nuevo del mismo pedido. Las revisiones se
incrementan al suspender y recuperar para rechazar borradores antiguos.

`unload_restaurant_carryovers` solo admite el dispositivo que hizo la recuperación,
antes del límite guardado por el servidor y mientras pedidos, revisiones y mesas sigan
exactamente como quedaron al abrir. Restaura el turno de origen, la caja y la distribución
anterior del turno de destino, y libera las mesas para que puedan usarse normalmente.
En la siguiente apertura se recuperan solo si todas sus mesas originales continúan libres;
si alguna está ocupada, la consumición sigue pendiente para otro turno. Cada recuperación
y cada deshacer se añade a
`recovery_history`, incluso si una misma consumición pasa por varias aperturas.

Se reutilizan los eventos Realtime de pedidos y mesas existentes. El aviso consulta solo
las recuperaciones recientes del turno y dispositivo actuales; desaparece al vencer el
plazo local, mientras la RPC aplica el mismo límite con hora del servidor. El editor retira
un pedido guardado cuando recibe su suspensión. El historial permite SELECT con RLS por
local; solo las RPC autorizadas lo escriben.

## Validación y despliegue

- Migraciones: `supabase/migrations/20260907191602_carry_forward_restaurant_orders.sql`
  `supabase/migrations/20260908135354_auto_recover_restaurant_carryovers.sql` y
  `supabase/migrations/20260908141159_release_unloaded_carryover_tables.sql`, en ese orden.
  La segunda rellena de forma segura los traspasos ya recuperados y los marca con el plazo
  de deshacer expirado; la tercera conserva las mesas aparcadas y permite liberarlas.
- `tests/restaurant-carryovers-sql.test.mjs` ejecuta la migración en PGlite junto al
  cierre, guardas, limpieza de mesas virtuales y cobro por partes existentes. Comprueba
  rollback, caja, conservación de líneas/división/pagos, tres turnos, reintentos,
  deshacer y caducidad, compatibilidad con datos existentes, revisiones obsoletas,
  permisos/RLS y el cobro final de la parte pendiente.
- `tests/restaurant-realtime-sync.test.mjs` comprueba la retirada del pedido suspendido
  por evento remoto y mantiene las pruebas de reconexión y polling.
- QA visual con componentes reales y servicios simulados: escritorio 1280×900 y móvil
  390×844; revisar, recuperar y confirmar traspaso. No sustituye una prueba con dos
  dispositivos y un servidor PostgreSQL real: PGlite serializa las peticiones de sus
  pruebas. No se han realizado cobros ni cierres sobre datos del local.
