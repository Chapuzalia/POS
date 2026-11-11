# Control de inventario del CRM

La pantalla de Stock conserva las unidades, precisión y operaciones existentes y
añade resumen, alertas por almacén, búsqueda, filtros y una ficha de artículo.
Utiliza los tokens claro/oscuro, `DataTable`, `CrmSelect`, `CrmModal`, botones e
inputs del CRM. En tablet y móvil el listado se presenta como tarjetas.

Stock es ahora la única entrada para artículos y existencias. El alta se abre
con **Nuevo artículo** y la ficha reúne **Stock y movimientos** y **Configurar
artículo**. Esta última conserva nombre, descripción, unidad física, estado
activo, almacenes, prioridades y objetivos mediante `save_inventory_item`.
El coste efectivo y los vínculos con variantes aparecen en el resumen; estos
vínculos se consultan solo al abrir la ficha, con paginación y scope de artículo,
tenant y local. El filtro de activos/inactivos permite reactivar artículos,
incluso sin existencias. La sección interna antigua `inventory-items` conserva
un alias a Stock, pero su pantalla y su entrada duplicadas desaparecen.

Guardar configuración no envía cantidades de stock. Las ubicaciones retiradas
se deshabilitan explícitamente mediante el RPC existente, conservando su saldo
y objetivo. No se permite cambiar la unidad mientras queden cantidades en algún
almacén. Un fallo de lectura posterior al alta cierra el borrador ya guardado
para evitar crear de nuevo el mismo artículo por error. Esta unificación no
requiere migraciones adicionales.

## Procedencia de las cifras

- **Por reponer:** artículos activos con al menos un almacén activo y habilitado
  cuyo saldo es inferior al objetivo configurado. El faltante suma únicamente
  diferencias positivas por almacén; el exceso de otro almacén no lo compensa.
  Las seis tarjetas de atención se ordenan por faltante / objetivo, de mayor a
  menor, por artículo y almacén. Los negativos pueden superar el 100 % faltante.
  Los saldos negativos sin objetivo positivo se conservan al final, sin inventar
  un porcentaje. Los empates se resuelven por nombre y almacén.
- **Negativos:** artículos con algún saldo negativo, incluso fuera del control
  activo. No se interpreta un cero sin objetivo como una alerta.
- En el listado inferior, **Estado** muestra disponible / objetivo en porcentaje:
  rojo por debajo del 10 %, naranja entre 10 % y menos del 60 %, verde desde el
  60 %. Conserva porcentajes negativos y superiores al 100 %. Sin objetivo o con
  objetivo cero no calcula un porcentaje. La escala es visual y no cambia las
  reglas de reposición ni las alertas de la cabecera.
- **Controlados:** artículos activos con posiciones habilitadas en almacenes
  activos. Los saldos residuales inactivos siguen disponibles para revisión.
- **Valoración:** suma en céntimos de cantidad por coste persistido, incluyendo
  saldos negativos. Reutiliza `getEffectiveInventoryItemCost`: medio, última
  compra y referencia, en ese orden. No usa precios de venta ni recalcula costes
  teóricos de recetas. La cobertura cuenta artículos con saldo distinto de cero;
  el coste desconocido se excluye y se comunica como valoración parcial. Cero es
  un coste válido cuando está registrado. No equivale al margen teórico de
  Rentabilidad (que tiene su propio criterio de compras/recetas).
- **Consumo:** movimientos físicos negativos con línea de ticket y origen de
  venta reconocido, en la unidad base actual. Excluye compras, ajustes y consumo
  de ingredientes para elaborar. Se consultan 7, 30 o 90 días operativos completos,
  con el mismo número de días anteriores. Hoy queda fuera de la comparación. El
  historial sí incluye los movimientos de hoy. Se respetan zona horaria y cambio
  de día del local, incluidos cambios de horario de verano.

La lista de Stock pagina las seis consultas de configuración para evitar el
límite habitual de PostgREST. El historial carga 50 movimientos cada vez y utiliza
orden estable y límite temporal. El consumo se agrega en servidor para el artículo
seleccionado; no descarga todos los tickets ni hace consultas por fila.

## Ajustes y migración

`20261028125520_inventory_stock_control_and_manual_audit.sql` está **preparada,
sin aplicar a ningún entorno**. Añade:

- auditoría de ajustes en `inventory_stock_movements`, con saldo anterior, delta,
  saldo posterior, unidad, actor y request ID;
- suma atómica de entradas sobre el saldo bloqueado en la base de datos;
- detección de cambios concurrentes al establecer un total;
- deduplicación de reintentos de ajustes con cambio económico;
- `update_inventory_item_stock`, entrada nueva que falla de forma explícita si el
  servidor todavía no admite el protocolo; nunca degrada una entrada a un total;
- `inventory_item_consumption_report`, lectura con RLS existente y límites
  explícitos de tenant, local, artículo, almacén y periodo.

La firma anterior de `set_inventory_item_stock` permanece disponible para PWAs
anteriores y mantiene su semántica de establecer totales. Esos clientes ganan
auditoría, pero solo los clientes nuevos envían sumas atómicas, request ID y
comprobación del saldo esperado. No se añaden triggers ni consultas al flujo de
venta y no se modifican las excepciones que preservan una venta cuando falla su
consumo auxiliar. Una escritura manual y su auditoría se confirman o revierten
juntas.

Antes de desplegar el frontend se necesita aplicar esta migración en el entorno
autorizado siguiendo `safe-production-migrations.md`. La migración es expand y el
checker no registra findings. Se revisó `contracts-pending.yml`: sus limpiezas de
numeración, exportación y fiscalidad son ajenas a este cambio; no se consumen sin
las comprobaciones de compatibilidad N-1 y ledger que exige esa guía. No se ha
ejecutado despliegue, reinicio, migración ni escritura de datos de producción.

## Reutilización y navegación

Stock y Compras reutilizan los objetivos existentes y el mismo cálculo de
faltantes por almacén. En Stock, **Reponer** abre una entrada manual rápida del
artículo y almacén elegidos, sin salir de la pantalla. La cantidad recibida empieza
vacía: el usuario introduce lo que ha recibido. El objetivo se muestra como
referencia y el botón Completar objetivo solo rellena la cantidad si se pulsa
expresamente. El saldo previsto aparece tras introducir una cantidad válida.
Guarda una suma atómica solo en ese almacén, con el
request ID y la trazabilidad existentes. El resumen permite filtrar los artículos
por reponer; no navega a Compras. La reposición con proveedores sigue siendo un
flujo independiente en Compras, con sus permisos y reglas anteriores.

En la ficha del artículo, **Establecer total por almacén** solo permite introducir
el total contado, precargado con el saldo actual. Se envían únicamente los
almacenes modificados y su saldo esperado para detectar cambios concurrentes.
Se retiran el modo de añadir y los incrementos rápidos de esa sección; los ajustes
específicos por mermas quedan para una ampliación posterior. Al cambiar de
tenant/local se desmontan las fichas y los borradores del contexto anterior.

## Límites y trabajo posterior

- Los ajustes anteriores a la migración no tienen trazabilidad completa. No se
  inventan asientos de apertura ni movimientos compensatorios.
- El traslado al eliminar un almacén es un flujo heredado con cambios directos de
  saldo sin movimientos de traslado y sin conservar el nombre del almacén eliminado. Preservar un almacén histórico
  y auditar ese traslado necesita una migración de ciclo de vida propia; queda
  aplazado para evitar cambiar silenciosamente el contrato de borrado. La ficha
  lo advierte y no pretende reconstruir periodos sin cobertura.
- La gráfica usa únicamente saldos del historial cargado del almacén seleccionado.
  Separa tramos con saltos, orden temporal ambiguo o unidades distintas; no
  extrapola hasta el saldo actual. Para ver tramos anteriores se carga otra página.
- El reporte comunica incidencias de consumo del local en ambos periodos, pues
  muchas incidencias no permiten identificar un ingrediente. No las atribuye al
  artículo ni calcula comparaciones porcentuales cuando existen incidencias o
  unidades incompatibles. Es consumo registrado, no garantía de consumo completo.
- Las elaboraciones sin coste persistido permanecen sin valoración; no se calcula
  retrospectivamente su coste con recetas actuales.
- El periodo personalizado y las previsiones de agotamiento quedan aplazados.
  No se añade IA ni un segundo sistema de pedidos.

## Verificación

Las pruebas Vitest cubren estados, valoración parcial, precisión, faltantes por
almacén, filtros, días operativos/DST, continuidad del historial, paginación y
protocolo de escritura. PGlite ejecuta la migración en una base desechable y
verifica auditoría, rollback, permisos/RLS, reintentos, totales concurrentes y
consumo físico. La QA visual usa Edge/Playwright sobre componentes reales con
servicios sustituidos en un navegador de prueba local; no autentica ni escribe
en Supabase. Esa QA no sustituye una prueba integrada posterior en staging con la
migración aplicada y datos reales autorizados.
