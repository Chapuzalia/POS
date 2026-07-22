# Auditoría de la arquitectura de catálogo

Fecha: 2026-07-22. Rama auditada: `main`. El árbol estaba limpio al iniciar. `HEAD` y `origin/main` apuntaban a `6fc1798`; los cambios recientes de cierres de caja (`0c94d44`), movimientos (`6fc1798`) y descuentos (`7a9eaa9` y migraciones 16/23/24/25) ya estaban versionados. No se ha descartado ni reescrito ningún cambio local y no se ha ejecutado `reset`, `clean` ni una migración remota.

## Modelo encontrado

El esquema real usa migraciones planas `supabase/<n>.*.sql`, no `supabase/migrations`. `products` pertenece a un local, pero `categories` y `sale_formats` pertenecen al tenant. La categoría tenía un `kind` funcional; el producto repetía `kind`, `sale_formats`, `can_sell_standalone`, `can_use_as_mixer` y `mixer_supplement_cents`. Las variantes no tenían FK al formato ni estado activo. Los grupos de modificadores pertenecían directamente a un producto.

Las seis pestañas superiores se generaban desde `sale_formats`. `CatalogPanel` filtraba por `product.kind`, `category.kind` y casos especiales de refrescos. `lib/catalog.ts` relacionaba variante y formato buscando aliases dentro del nombre. `ProductDialog` abría mixers únicamente cuando la clave era `cubata` y obtenía las opciones de todos los productos con `can_use_as_mixer`.

La venta rápida convertía el mixer en un modificador `mixer:<product_id>`. Mesas usaba columnas `mixer_product_id` y `mixer`, por lo que ambos canales tenían representaciones distintas y cálculos separados. El cierre/pago de mesas copia actualmente líneas mediante varias funciones SQL introducidas por las migraciones 11, 16, 21, 22, 23 y 24.

`ticket_lines` ya conservaba nombres, precio, total, modificadores e IVA histórico, pero no formato/categoría/pestaña ni componentes con identidad. Los informes agrupaban formato usando `variant_name` y categoría usando la relación actual del producto. La impresión mostraba modificadores y mixer, pero la venta rápida solo podía hacerlo porque el mixer se había sintetizado como modificador.

No existe un módulo, tabla, servicio ni movimiento de inventario/stock en este repositorio. Por tanto no se ha modificado un consumo real inexistente. Se ha añadido una proyección pura de consumo que emite exactamente una entrada para el producto principal y una por componente; será el punto de integración de un inventario futuro.

## Flujos y dependencias afectados

- Carga y caché offline del catálogo en `posService`/`offlineStore`.
- Pestañas, categorías, destacados, Todo y Top del TPV.
- Alta/edición/importación de productos y formatos en CRM.
- Selección de variante, mixer, componentes de menú y modificadores.
- Construcción, agrupación, edición y recuperación de líneas rápidas y de mesas.
- RPC de guardado de borradores de mesa y RPC de sincronización offline.
- IVA, descuentos, pagos, impresión y cierres de caja.
- Informes por producto/categoría/formato y los nuevos ejes de análisis.
- RLS multi-tenant y acceso por local/dispositivo.

## Decisiones adoptadas

La fuente canónica es `catalog_tabs -> catalog_placements -> products -> product_variants.sale_format_id`. Las categorías vuelven a ser organización visual. `selection_groups` se reutiliza para mixers y componentes de menú, aunque la UX distingue ambos. Un item referencia un producto/variante real y su suplemento es contextual. Los menús solo admiten inicialmente productos `standard` en SQL, lo que impide ciclos por construcción; el cliente también incluye detección de ciclos indirectos.

Los grupos de modificadores actuales se conservan y se añade `product_modifier_groups`. La migración rellena esa asignación sin borrar `modifier_groups.product_id`. Los campos legacy permanecen y están comentados como `@deprecated`.

El CRM permite crear grupos reutilizables, definir mínimos/máximos, opciones gratuitas o con suplemento, valores predeterminados y asignarlos al producto completo o a una variante. Los componentes de menú pueden abrir esos grupos propios; sus modificadores se guardan dentro del componente, se validan en el RPC, se incluyen una sola vez en el precio y se copian al `metadata` histórico.

`buildSaleLine` y `calculateSaleLineTotals` centralizan `base + componentes + modificadores`. Los descuentos siguen aplicándose después sobre el subtotal mediante el código y las RPC existentes; su semántica no se ha alterado. IVA sigue calculándose sobre el importe bruto final de la línea, como antes.

La venta rápida y mesas comparten `ProductLineSelection`, `TicketLineComponent` y el cálculo. El mixer ya no se sintetiza en el flujo nuevo. Las columnas legacy de mixer se mantienen en mesas durante la transición para que las RPC históricas y una versión anterior de la aplicación sigan funcionando.

## Compatibilidad y fallback

`catalogAccess.ts` es la única capa que conoce el fallback. Si no hay pestañas/colocaciones válidas, deriva temporalmente las seis pestañas y colocaciones desde los arrays legacy y registra un único warning. Nunca usa nombres/aliases: para una caché antigua empareja el orden estructural de `sale_formats` con el orden de variantes. Tras desplegar la migración, el POS consume IDs explícitos.

Los tickets nuevos guardan snapshots y componentes. Los tickets antiguos usan este orden: snapshot nuevo, nombre histórico ya almacenado, relación actual como último recurso. El backfill de categoría de líneas antiguas es una aproximación porque el esquema anterior no guardaba categoría histórica. No se inventa una pestaña histórica cuando no existía; la verificación la marca para revisión.

## Riesgos y casos ambiguos

- Variantes antiguas cuyo nombre y posición no permiten identificar inequívocamente un formato quedan en la consulta `active_variants_without_format` del script de verificación.
- Una categoría histórica no se puede reconstruir con certeza; se usa la categoría actual solo cuando no existe snapshot.
- Las funciones históricas de cobro de mesas no aceptan componentes. La migración conserva componentes en `order_lines`/`order_line_components`; venta rápida se captura de forma determinista desde el evento offline. Antes de habilitar menús en producción debe validarse en staging cada estrategia de pago parcial y que sus líneas finales reciben componentes.
- No se pudo validar sintaxis SQL contra PostgreSQL local porque `psql` no está instalado. El script es transaccional e idempotente en DDL/backfill, pero debe probarse primero sobre una copia.
- El bundle ya superaba el umbral de 500 kB; el build mantiene el warning existente, no un error.

## Diferencias frente al modelo de referencia

- `categories` y `sale_formats` siguen siendo globales al tenant porque así funciona el esquema real; la colocación y el grupo aportan el contexto de local.
- Los componentes de mesa tienen además `order_line_components` y un espejo JSON para poder convivir con las RPC actuales.
- No hay inventario real que adaptar.
- La convención de migración es `supabase/29.catalog-architecture-migration.sql`.

## Estrategia de migración

La migración es aditiva: crea columnas/tablas/índices/políticas, normaliza únicamente el exceso de variantes predeterminadas, relaciona formatos, crea el preset `bar_classic`, coloca productos y crea el grupo contextual de mixers. No borra ni renombra tablas/columnas, no cambia importes ni modifica tickets totales. Los aliases aparecen exclusivamente en el backfill SQL. La vuelta atrás lógica consiste en desplegar la aplicación anterior conservando todos los campos legacy.
