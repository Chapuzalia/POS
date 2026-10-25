# Mesas compartidas por local

El mapa operativo, las mesas temporales y las comandas abiertas se comparten entre
todas las cajas del mismo tenant y local. Cerrar una caja no cambia las posiciones,
agrupaciones, ocupación ni estado de las comandas. La siguiente apertura ve el mismo
mapa. El plano base del CRM sigue separado de la disposición operativa.

`venue_table_layouts` mantiene una distribución y una revisión por local. Las RPC de
guardado rechazan revisiones obsoletas y conservan las validaciones de posiciones,
composiciones y ocupación. Realtime publica los cambios por local. Las altas, bajas
y activaciones de mesas actualizan los miembros y la revisión del mapa compartido.

Los campos históricos `cash_session_id` y `cash_register_id` de comandas/grupos y
`cash_session_id` de mesas temporales conservan su origen. No determinan su duración,
visibilidad ni la caja que recibe el cobro. El acceso al TPV y la creación de comandas
siguen utilizando la selección de caja del dispositivo; una caja cerrada no impide
trabajar con sus comandas desde otro terminal con una sesión abierta.

En «Editar mesas» aparece «Recuperar mapa inicial». Restaura las posiciones de las
mesas permanentes al plano base actual del CRM en todo el local y conserva las mesas
temporales, comandas y reservas. Solo se permite sin mesas juntadas en ninguna sala;
el servidor también valida esta condición y rechaza una revisión desactualizada.

## Cobro y cierre

Cada operación de cobro incluye la sesión seleccionada, el dispositivo y su identidad
durable. El servidor comprueba tenant, local, permisos y selección de caja. Los tickets,
ventas y documentos fiscales se asignan a esa caja e instalación, conservando los
snapshots de las líneas originales aunque la comanda proceda de otra caja ya cerrada.

Antes de tocar Cashlogy se reserva el grupo de cuentas en servidor. Una reserva activa
impide otro cobro, cambios en la cuenta y el cierre de la caja que está cobrando.
La identidad se persiste primero en IndexedDB; una respuesta de reserva perdida se
recupera sin crear otro cobro. Las reservas que pudieron iniciar un cobro no caducan
automáticamente: se recuperan desde el terminal y operación originales. Un fallo de
validación fiscal previo al cobro libera la reserva y permite corregir el ticket.

Los cobros por productos o por partes con tickets separados pueden realizarse en
distintas cajas: cada venta queda en la caja que la cobró. Un reparto con ticket único
se liquida íntegramente en la caja que recibe el primer subpago, porque produce una
sola venta fiscal. Esa caja no puede cerrar hasta completarlo; las demás cajas pueden
cerrar aunque hayan abierto originalmente la comanda.

El cierre solo incluye sus ventas, cobros y movimientos confirmados. Las mesas
pendientes permanecen abiertas; ya no se suspenden ni se recuperan al abrir otra caja.
Las firmas de distribución y traspaso antiguas se conservan como adaptadores para
los clientes anteriores. El historial de traspasos existente se mantiene.

## Aplicación y verificación

La migración `20261024234554_venue_restaurant_operations.sql` debe aplicarse con todas
las cajas cerradas. Incluye una precondición que rechaza la ejecución si alguna sigue
abierta. Se añade estructura compatible sin eliminar tablas, columnas ni historial.

`tests/venue-restaurant-operations.test.mjs` ejecuta la migración y las funciones reales
en PGlite: mapa compartido y revisiones, cierre con pedidos abiertos, mesas temporales
entre cajas, cobros totales y por productos, instalación fiscal, snapshots, reintentos,
reservas y aislamiento por local/dispositivo. Las pruebas de recuperación ejercitan
IndexedDB real simulado. PGlite serializa consultas; estas pruebas no sustituyen una
prueba operativa con dos dispositivos, PostgreSQL y Cashlogy reales.
