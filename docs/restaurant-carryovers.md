# Traspaso de pedidos entre turnos

## Uso

El cierre consulta los pedidos abiertos y los cobros confirmados. Con pedidos abiertos,
ofrece «Volver y revisar» o «Traspasar al siguiente turno y cerrar». Antes de cerrar se
guarda el borrador de mesa y se sincronizan las operaciones locales. Una venta rápida
sin guardar debe cobrarse o guardarse en una mesa primero.

Al abrir un turno posterior del mismo local aparece «Recuperar las mesas». La recuperación
requiere conexión, permiso para tomar pedidos y que el dispositivo tenga seleccionado
el turno de destino. El destino debe haberse abierto después del cierre de origen.

## Modelo y contabilidad

- `orders.status = 'carried_forward'` suspende el pedido sin finalizarlo. Conserva su ID,
  grupo, líneas, descuentos, snapshots fiscales, notas, divisiones y producción.
- `restaurant_order_carryovers` registra un salto por grupo: origen, destino, pedidos
  incluidos, fechas, usuarios, dispositivos y distribución temporal de sus mesas.
  Un grupo solo puede tener un salto pendiente; puede tener cualquier número de saltos
  completados. Las cuentas que se dividen después siguen teniendo el mismo grupo.
- Al recuperar se actualizan únicamente el estado, turno, caja y revisión del pedido,
  el turno del grupo y la asignación/activación de las mesas virtuales. Se restaura
  la distribución guardada. Los vínculos `order_tables` permanecen sin liberar.
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

`recover_restaurant_carryovers` recibe IDs concretos de saltos, bloquea el destino y
cada salto, y comprueba de nuevo si ya fue recuperado. Una segunda petición devuelve
cero recuperaciones; un reintento antiguo no puede reclamar un salto nuevo del mismo
pedido. Las revisiones se incrementan al suspender y recuperar para rechazar borradores
antiguos. Las RPC existentes rechazan los pedidos suspendidos por su estado.

Se reutilizan los eventos Realtime de pedidos y mesas existentes. El aviso tiene un
canal independiente y refresco al recuperar foco y cada 18 segundos. El editor retira
un pedido guardado cuando recibe su suspensión. El historial permite SELECT con RLS
por local; solo las RPC autorizadas lo escriben.

## Validación y despliegue

- Migración: `supabase/migrations/20260907191602_carry_forward_restaurant_orders.sql`.
  Aplicar primero mediante el procedimiento habitual del proyecto y después publicar
  el cliente. Esta implementación no aplica cambios a una base remota.
- `tests/restaurant-carryovers-sql.test.mjs` ejecuta la migración en PGlite junto al
  cierre, guardas, limpieza de mesas virtuales y cobro por partes existentes. Comprueba
  rollback, caja, conservación de líneas/división/pagos, tres turnos, reintentos,
  revisiones obsoletas, permisos/RLS y el cobro final de la parte pendiente.
- `tests/restaurant-realtime-sync.test.mjs` comprueba la retirada del pedido suspendido
  por evento remoto y mantiene las pruebas de reconexión y polling.
- QA visual con componentes reales y servicios simulados: escritorio 1280×900 y móvil
  390×844; revisar, recuperar y confirmar traspaso. No sustituye una prueba con dos
  dispositivos y un servidor PostgreSQL real: PGlite serializa las peticiones de sus
  pruebas. No se han realizado cobros ni cierres sobre datos del local.
