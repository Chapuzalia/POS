# Optimización de latencia del TPV — 3 de octubre de 2026

Aplicada al código local y a la base de datos de staging. Migración:
`20261003183458_optimize_pos_sale_latency.sql`.

## Cambios

- La preparación fiscal de mesa se reutiliza al emitir, con el mismo identificador de venta y los límites de vigencia existentes. Se mantienen las dos comprobaciones del extremo remoto y el bloqueo fiscal.
- IndexedDB solicita los estados de entrega en paralelo. La recuperación lee únicamente documentos de cadena; los hashes se reutilizan solo cuando todos sus datos de entrada son idénticos. La instalación carga configuración y validación local en paralelo; las lecturas simultáneas de configuración se comparten.
- El cierre completo de mesa libera la interfaz tras la confirmación económica y la actualización local. Impresión, sincronización y refrescos posteriores siguen ejecutándose y sus fallos se comunican. Los refrescos protegen el contexto y las ventas concurrentes; el mapa repite una lectura si recibe cambios durante una petición.
- Sin impresora configurada se evitan consultas de número de ticket y validación fiscal destinadas a imprimir. Cuando se necesita el número, se consulta únicamente ese campo.
- Los eventos de venta tienen claves escalares derivadas del payload y un índice compatible con RLS. Los clientes anteriores siguen funcionando; el frontend conserva una alternativa para bases sin las nuevas columnas.
- Cashlogy evita buscar eventos en pagos con tarjeta. El cierre completo persiste la referencia directa de cada línea de comanda; las consultas de componentes filtran el tipo de evento.
- Las estadísticas se agregan en PostgreSQL, con permisos del usuario, aislamiento de local y paginación por producto. La alternativa para servidores anteriores pagina las líneas y elimina el truncamiento a 1.000.

## Mediciones

| Operación | Antes | Después |
| --- | --- | --- |
| Consulta de eventos bajo RLS de cajero, mismo caso sin resultados | 3.735–5.092 ms | 3,152 ms |
| Validación fiscal local, unas 1.167 entradas | 136–149 ms | 57–85 ms |
| Lectura local de entradas | 116–124 ms | 43–47 ms |
| Preparación de instalación | 333–409 ms | 133–151 ms |
| Recuperación/comparación de cadena | 222–249 ms | 93–117 ms |

La agregación SQL de estadísticas tardó 462,794 ms y devolvió 59 productos completos. La consulta anterior por HTTP tardó 3,421 s y devolvió solo 1.000 líneas; estos dos tiempos corresponden a capas diferentes y no constituyen una comparación directa de latencia de red.

Dos ventas reales de prueba en staging, un chupito de 2 € con tarjeta cada una:
venta rápida, 757 ms hasta vaciar el ticket; Mesa 1, 2.955 ms desde confirmar
el cobro hasta aparecer libre y habilitada. Los tiempos incluyen la automatización
del navegador y no son un perfil exacto de repintado. Los aproximadamente 13,5 s
anteriores de mesa eran una reconstrucción de la ruta bloqueante, no una medición
equivalente de clic a pantalla.

## Verificación y límites

Pruebas de migración, aislamiento, importes, más de 1.000 líneas, Cashlogy,
bloqueo hasta confirmar el cobro, fallos posteriores y cambio de contexto.
Suite completa: 599 pruebas aprobadas, sin fallos. `pnpm lint` y `pnpm build`
finalizan correctamente. Lint mantiene cuatro advertencias anteriores.
Los advisors de staging conservan advertencias existentes del proyecto; no
señalaron las dos funciones nuevas.

El envío remoto y la segunda comprobación de cadena todavía dependen de la red.
La emisión conserva las comprobaciones del último registro y de seguridad fiscal. No se ha desplegado
el frontend ni aplicado la migración a producción.

## Preparación fiscal sin auditoría del histórico

A petición del usuario, la venta ya no ejecuta `assertFiscalLedgerValid`:
la auditoría histórica queda fuera del cobro y se realizará en el bridge.
`assertFiscalLedgerHeadValid` comprueba únicamente el documento final, su hash,
identidad, numeración y metadatos necesarios para el siguiente registro.
Dentro del bloqueo de emisión se vuelve a leer el cursor y el contador, y
el guardado verifica que no hayan cambiado antes de confirmar la transacción.

El cursor incorpora `recordId` opcional, sin cambiar la versión de IndexedDB.
Una PWA anterior sigue pudiendo leerlo y escribirlo. Si no existe esa referencia,
se localiza una vez el documento de la posición del cursor y se guarda su ID;
esta búsqueda de compatibilidad no audita ni recalcula el histórico.
Todos los nuevos registros, rectificaciones, anulaciones y registros recuperados
guardan la referencia. Si vuelve a escribir un cliente antiguo, se repite la
búsqueda de compatibilidad al faltar el campo.

La conciliación remota lee el último documento directamente. Si el servidor
va por detrás, comprueba su registro concreto por ID; si va por delante, obtiene
solo el tramo que falta. Tampoco carga la cadena local completa al recuperar ese
tramo. Los fallos de integridad del extremo bloquean la emisión.

Medición con 1.168 registros en la instalación de Mess: **1,3–6,5 ms** para
validar el extremo, frente a los 57–85 ms del recorrido completo optimizado.
Prueba en navegador con IndexedDB real: emisión concurrente, continuidad de
numeración, migración de cursor antiguo, recuperación y rechazo de último
registro corrupto/ausente, contador incoherente y dispositivo incorrecto.
El cambio no implementa la futura auditoría del bridge.

## Reducción de peticiones del TPV

La migración `20261003195724_reduce_pos_request_redundancy.sql`, aplicada solo
a staging, añade tres RPC de lectura con `SECURITY INVOKER`, RLS y filtros de
tenant/local intactos. Conserva las rutas anteriores para clientes antiguos.

| Lectura | Antes | Ahora |
| --- | --- | --- |
| Mapa, reservas, producción y distribución de sesión | 8–10 peticiones por recarga | 1 RPC |
| Comanda, líneas, mesas y nombre de caja | 5 peticiones | 1 RPC |
| Instalación, titular, ajustes y extremo fiscal en preparación | Hasta 4 peticiones | 1 RPC |

La comprobación remota dentro de la emisión sigue vigente. Las lecturas
simultáneas de comanda e instalación comparten la petición en curso, sin
cachear autorizaciones completadas. Los ajustes fiscales y la configuración
del local tienen caché de 60 segundos e invalidación por cambios. El cobro
completo actualiza las mesas con el resultado confirmado y deja de forzar
otra recarga inmediata del mapa; Realtime y la reconciliación periódica siguen
activos. Historial, estadísticas, impresión y sincronización no bloquean la UI.

Pruebas reales en Mess staging con el navegador integrado:

- Venta rápida de 2 € con tarjeta: ticket vacío en **521 ms** en esta muestra.
- Mesa 1, 2 € con tarjeta: una RPC de comanda, una de preparación fiscal,
  una lectura del extremo y la RPC de cobro. Preparación y lectura del extremo
  tardaron **272 + 97 ms**; el cobro confirmado tardó **2.814 ms**.
  La mesa quedó libre. El tiempo exacto hasta pintar la UI no se pudo medir
  porque el observador de visibilidad agotó su plazo aunque la mesa ya aparecía libre.
- Las peticiones posteriores de ventas, tickets, estadísticas y eventos se
  ejecutaron en segundo plano. Las recargas periódicas del mapa fueron una RPC
  cada una. La captura incluye estos ciclos posteriores; no son todos parte del cobro.

Estas muestras no son un benchmark estadístico. La RPC de cobro de mesa aún
puede dominar la espera según carga/red; reducir lecturas no garantiza un
tiempo fijo de esa transacción. No se ha desplegado el frontend a producción.

Verificación final: `pnpm test` **603/603**, `pnpm build` correcto y
`pnpm lint` correcto con cuatro avisos previos. La primera ejecución simultánea
con el build agotó un plazo de 50 ms de una prueba de polling de impresión;
la prueba aislada y la repetición completa sin build simultáneo pasaron.
`git diff --check` no detectó errores. La instrumentación temporal de captura
de peticiones se retiró de `index.html` antes del build final.

## Diagnóstico de `sync_local_fiscal_sale_created`

Lectura de las definiciones desplegadas y `pg_stat_statements` en staging,
sin ejecutar otra venta ni alterar datos. La captura rápida anterior terminó
con **HTTP 204 en 2.120 ms**. Ambas funciones devuelven `void`; el cuerpo vacío
es la respuesta prevista. El cliente comprueba `error` y marca la venta
económica como sincronizada solo después del éxito.

La RPC valida idempotencia, acceso del dispositivo e instalación, identidad,
importes, factura, fecha, serie, último registro y siguiente número. Bloquea
la instalación y la serie; llama a `sync_sale_created_v2`, que valida la venta,
bloquea la sesión de caja y guarda evento, ticket, líneas, venta y pago. Después
guarda el registro fiscal y avanza la numeración, todo en una transacción.
No envía la factura a AEAT ni audita la cadena completa.

Las tres entradas históricas de PostgREST para esta RPC tienen respectivamente
32/44/15 llamadas, medias **1.503/303/384 ms**, mínimos **177/33/70 ms** y máximos
**4.013/1.145/990 ms**. No son mediciones aisladas del frontend actual ni un
desglose por trigger. Los contadores JIT de esas entradas son cero;
`track_functions=none`, por lo que no hay tiempos individuales de las funciones.

Trabajo repetido confirmado en las definiciones desplegadas:

- `set_ticket_line_theoretical_cost` calcula coste antes del INSERT;
  `snapshot_ticket_line_theoretical_cost` lo calcula otra vez después de
  capturar componentes y actualiza la línea.
- Inventario y el snapshot de coste resuelven por separado recetas,
  componentes y modificadores. Ambos crean/reutilizan y truncan tablas
  temporales dentro de la transacción.
- `allocate_inserted_ticket_line_discounts`, cuando no hay descuento,
  actualiza todas las líneas con importes que la RPC ya insertó correctamente.
- En el cliente, `economicSync.ts` lee todos los registros locales incluso
  cuando no hay ventas pendientes. Este coste es anterior a la petición HTTP;
  no explica por sí mismo la duración que DevTools atribuye a la RPC.

Prioridades propuestas: evitar UPDATE sin cambios; calcular el snapshot final
de coste una sola vez conservando cobertura de clientes antiguos; compartir
la resolución de ingredientes entre consumo y coste; y leer por ID únicamente
los registros económicos pendientes en el cliente. Medir cada modificación
con el mismo conjunto de ventas y verificar dinero, stock, snapshots históricos,
aislamiento, numeración y concurrencia. No retirar los bloqueos ni dividir
la transacción económica/fiscal. No se aplicaron nuevos cambios de runtime
en esta investigación ni se estimó una ganancia porcentual sin medirla.

## Cobro de mesa: diagnóstico específico

`pay_restaurant_local_fiscal` tiene 21 llamadas históricas en staging con media
2.384,80 ms, mínimo 254,85 ms y máximo 7.925,34 ms. La función fiscal llama a
la función de cierre comprobado y esta al cierre económico: valida pendientes,
bloquea grupo/comandas/líneas/sesión, genera ticket/líneas/venta/pago, ejecuta
sus triggers y cierra/libera el grupo. El wrapper fiscal ajusta el dispositivo,
guarda el registro y avanza el número. No espera a AEAT.

Se confirmó una lectura especialmente costosa en el trigger desplegado
`capture_ticket_line_catalog_snapshot`: busca eventos por
`payload->'ticket'->>'id'`, sin `event_kind`, antes de intentar encontrar
el snapshot entre las comandas del turno. No usa `source_order_line_id`,
aunque el cierre nuevo ya lo proporciona. El índice añadido anteriormente
requiere las claves escalares y el predicado de evento de venta; esta consulta
no los utiliza.

EXPLAIN ANALYZE de la lectura (sin ejecutar ventas), para la última línea de
mesa de Mess: descartó 8.554 eventos y accedió a 16.373 bloques en caché.
La selección completa, incluyendo localizar la línea de prueba, tardó
3.875,907 ms. La búsqueda equivalente usando `event_kind`,
`sale_cash_session_id` y `sale_ticket_id` utilizó
`offline_event_log_sale_session_ticket_idx`: 3 bloques, 5,429 ms en ese nodo
y 7,549 ms en el conjunto. Son dos muestras de lectura, no una medición
antes/después del cobro completo; carga/caché pueden variar.

La primera corrección propuesta es resolver el snapshot directamente desde
la línea de origen con tenant/venue/order scope y mantener una búsqueda
indexada de compatibilidad para ventas rápidas y clientes antiguos. Después,
reducir la resolución repetida de costes/inventario y los UPDATE sin cambios.
La búsqueda de catálogo escala con el histórico y se ejecuta por línea;
optimizarla ataca un cuello demostrado, sin cambiar la transacción fiscal.

La UI espera `issueRestaurantInvoice`, que espera la RPC y valida sus IDs e
importe. `issueLocalInvoice` espera esa resolución económica antes de guardar
el documento/cursor en IndexedDB. Solo entonces el controlador libera las
mesas y cambia al mapa. No basta quitar `await`: el servidor puede pedir
confirmación, rechazar el importe/caja/cadena o haber confirmado una petición
cuya respuesta se perdió.

Se podría mostrar el mapa antes con la mesa en estado «Cobrando», bloqueada
para nuevos cobros hasta confirmar. Requiere conservar la operación, gestionar
rechazos/respuestas perdidas y recuperación al recargar, impedir que Realtime
borre el estado pendiente y mantener la serialización fiscal de la instalación.
No permitiría adelantar otro registro de la misma cadena antes de resolver el
primero. Dar la mesa por libre inmediatamente requeriría otro contrato de
reserva y persistencia; no equivale a un cambio visual. En esta investigación
no se aplicaron cambios al cobro ni nuevas migraciones.

### Búsqueda de catálogo aplicada

Posteriormente se aplicó a staging la migración nueva
`20261003203503_optimize_ticket_catalog_snapshot_lookup.sql`. Conserva la
firma, permisos y trigger existente. Para mesas usa la línea de origen exacta
con filtros de tenant/local/sesión/producto/variante/precio. Conserva incluso
un snapshot vacío, sin sustituirlo por datos de otra comanda. Para ventas
rápidas usa las claves escalares de evento y el índice existente; mantiene
el fallback no ambiguo para clientes antiguos sin referencia de origen.
No modifica tickets históricos, la RPC de cobro ni sus límites transaccionales.

Verificación: seis pruebas nuevas de snapshots y aislamiento; `pnpm test`
**609/609** y checker de migración correcto. En staging, un INSERT sobre una
tabla temporal copiada de `ticket_lines`, con únicamente el trigger real de
catálogo, tardó **9,755 ms**, de los cuales **7,318 ms** correspondieron al
trigger. Las cuatro columnas de categoría/pestaña coincidieron con la línea
de comanda de origen. No se creó ni modificó ninguna venta en esa prueba.
Este resultado no mide la RPC completa ni permite prometer su nueva latencia.
Se ejecutaron los advisors de seguridad: señalaron los permisos conservados
de `anon` y `authenticated` sobre esta función `SECURITY DEFINER`. Es una
función de trigger; esta migración no amplía ni cambia esos permisos.
Producción no se ha actualizado.

## Coste final calculado una sola vez

La migración `20261004190253_optimize_ticket_line_cost_snapshot.sql`, aplicada
a staging, elimina el coste provisional de variante en BEFORE INSERT. El
trigger existente AFTER INSERT sigue calculando el coste completo después de
capturar componentes y persistiéndolo en la misma transacción. La migración
aborta si ese trigger final no está habilitado. Firmas y permisos se conservan.
Los UPDATE posteriores siguen protegiendo el snapshot histórico; los costes
enviados por clientes se ignoran. No se recalcula el histórico ni se cambia la
resolución de ingredientes, compras, modificadores o conversiones.

Cuando el coste sigue siendo desconocido (false/null), se evita el UPDATE
redundante y sus triggers. Un coste conocido de cero se guarda como true/0.
Cuatro pruebas nuevas cubren cálculo único después de capturar componentes,
costes manipulados por el cliente, protección histórica, unknown/zero y
rollback si falla el cálculo final. La batería completa pasa: **622/622**.

El perfil de staging, con el mismo script de diagnóstico y rollback, confirma
cero llamadas a `theoretical_variant_cost`, una al cálculo final por línea y
dos llamadas al trigger fiscal/IVA en lugar de tres en esta muestra. Tres
ejecuciones de una línea con tarjeta: **233,351 / 32,325 / 34,721 ms** dentro
de la RPC. El cálculo final tardó **64,747 / 6,211 / 7,339 ms**; la primera
muestra incluye calentamiento y variación de carga. Estas muestras no permiten
prometer una mejora porcentual ni equivalen al tiempo HTTP: no incluyen red
ni commit final. Se ejecutaron los advisors de seguridad después del cambio.
