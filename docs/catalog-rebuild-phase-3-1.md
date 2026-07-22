# Reconstrucción del catálogo — fase 3.1

## Resultado

La aplicación dispone de una única capa definitiva de dominio y acceso al catálogo nuevo. La carga principal del TPV ya no consulta formatos, items/asignaciones de migración 29 ni columnas funcionales antiguas. CRM y TPV siguen mostrando temporalmente sus componentes actuales mediante una proyección de solo lectura; no se ha rediseñado ninguna pantalla ni se ha eliminado ningún objeto legacy.

El mapa previo obligatorio está en `docs/catalog-rebuild-phase-3-1-audit.md`.

## Arquitectura

```text
PostgreSQL get_catalog(venue, mode)
              |
              v
CatalogRepository -> mapper DB/dominio -> CatalogData
              |                         |
              |                         +-> resolver vendible
              |                         +-> servicio de precios
              |                         +-> comandos finales
              v
proyección temporal de solo lectura -> UI CRM/TPV actual
```

- Tipos de filas SQL: `src/features/catalog/data/database.ts`.
- Tipos de dominio: `src/features/catalog/domain/types.ts`.
- Transformación: `src/features/catalog/data/mapper.ts`.
- Acceso y caché: `src/features/catalog/data/repository.ts` y `cache.ts`.
- Resolución central: `src/features/catalog/domain/resolver.ts`.
- Precio: `src/features/catalog/domain/pricing.ts`.
- Errores tipados: `src/features/catalog/domain/errors.ts`.
- Escrituras preparadas: `src/features/catalog/data/command-service.ts`.
- Adaptación visual temporal: `src/features/catalog/compatibility/project-current-ui.ts`.

El proyecto no tenía un tipo `Database` generado por Supabase; `src/types/supabase.ts` era una colección manual de filas antiguas. Las filas finales quedan tipadas en el límite de datos nuevo y no se ha simulado código generado.

## Lectura

`get_catalog` recibe siempre `venue_id` y `mode` (`admin` o `pos`), vuelve a validar acceso y filtra cada colección por local. Devuelve todas las colecciones en una sola ida a PostgREST, con orden estable por `sort_order` e ID. `pos` filtra entidades y relaciones inactivas; `admin` conserva también productos internos, categorías sin uso y configuración desactivada.

La URL pública de cada imagen se calcula una vez durante el mapeo del snapshot. No se solicitan signed URLs por producto ni durante renders.

El repositorio cubre catálogo completo, tabs activas, categorías por tab, placements/productos/variantes activos, producto o variante por ID, producto administrativo completo, productos internos, catálogo POS y datos canónicos para construir una venta.

## Resolución vendible

Un `ResolvedCatalogItem` contiene placement, tab, categoría, producto, variante, precio base, IVA, imagen, selection groups, opciones y modificadores aplicables.

Reglas:

1. Un placement con `pinnedVariantId` exige que la variante exista, esté activa y pertenezca al producto.
2. Sin variante fijada se exige exactamente una default activa; no se inventa fallback por posición o nombre.
3. Producto, placement, tab y categoría opcional deben estar activos.
4. Un producto sin placement es interno y se conserva fuera de los vendibles.
5. El mismo producto puede resolverse varias veces en tabs distintas o con variantes fijadas diferentes.
6. Una asignación producto/grupo es única en SQL. Si `appliesToAllVariants=true`, ese alcance prevalece; las filas hijas solo delimitan el alcance cuando es `false`. Así no se duplica un grupo.
7. Grupos, asignaciones, opciones, productos opción y variantes opción inactivos no son seleccionables.
8. La capacidad activa debe cubrir el mínimo de la asignación.

## Precio

`calculateCatalogPrice` reutiliza `calculateSaleLineTotals` de `saleLineBuilder.ts` y `calculateTaxFromGross` de `tax.ts`. Todo dinero es un entero seguro en céntimos. El desglose incluye base, suplementos mixer/selección, menú, modificadores, bruto, descuento, neto, IVA, base imponible y precio final.

Los suplementos pueden ser negativos dentro de los límites SQL. Un descuento o combinación de suplementos que produzca un precio final negativo genera `CATALOG_NEGATIVE_FINAL_PRICE`; cero es válido.

## Escrituras y atomicidad

La migración `39.catalog-domain-backend.sql` crea `catalog_command`. Cada llamada:

- bloquea primero la fila del local;
- comprueba administración o service role;
- filtra y valida el local explícitamente;
- ejecuta una única transacción PostgreSQL;
- fuerza constraints diferibles antes de devolver éxito;
- invalida la caché del local en el cliente.

Están preparados create/update/activate/delete de producto, variantes y default, placements, tabs, categorías, grupos, opciones, modificadores, asignaciones y reordenación por lotes. La creación completa de producto + variantes y el cambio de default son atómicos.

La migración `40.catalog-sale-line-service.sql` crea `save_catalog_order_lines`, nombre definitivo sin sufijo. Reutiliza únicamente el control probado de revisión/served-lines de la comanda; elimina del paso base los modificadores/mixer transitorios y después canoniza producto, variante, componentes y modificadores contra las tablas finales. Persiste snapshots y rechaza precio final negativo.

## Hard delete

- Producto: operación compuesta. Elimina por cascada su configuración final. Comandas y tickets sobreviven porque sus UUID/nombres/precios son snapshots sin FK viva.
- Variante: borrado directo solo si no es la default activa. Las referencias restrictivas a placement/opción obligan a mover o borrar primero esas relaciones.
- Placement, opción, modificador y asignación: borrado directo.
- Tab, categoría y grupos: operación compuesta con cascadas de configuración. Una referencia legacy aún viva puede impedir el borrado, lo cual es preferible a perder datos.
- Imagen: al borrar producto, SQL devuelve la ruta solo si ya no existe ninguna fila `product_images` que la use. Storage se elimina después del commit. Un fallo de Storage se devuelve como error operativo para reintento; nunca se borra un binario todavía compartido.

## Caché

Las claves son `<venueId>:<mode>`. Las cargas simultáneas comparten la misma promesa. Todo comando final invalida ambos modos del local. `invalidateCatalogAfterImport` queda disponible para importadores y futuras APIs. No existe contador de versión manual.

## Errores

La capa expone `CatalogDomainError` con códigos estables para producto/variante inexistentes, propiedad incorrecta, placement/grupo inválido, selección fuera de límites, precio negativo, cross-venue, producto no vendible, referencias activas y permisos. Los detalles crudos de PostgreSQL quedan en `details` para diagnóstico y no se presentan como mensaje de UI.

## Legacy todavía conectado por dependencia visual

Estos puntos se mantienen exclusivamente para fases 3.2/3.3:

1. `src/features/crm/catalog/services/catalogService.ts`: formularios actuales escriben formatos, flags de producto y relaciones transitorias.
2. `src/features/crm/catalog/services/catalogImportService.ts`: importador CRM antiguo por merge. La importación definitiva sigue siendo la de fase 2.
3. `src/lib/catalog.ts`: helpers de formato usados por ProductForm, ProductDialog y restauración visual actual.
4. `src/lib/mixers.ts`: lectura de mixers sintéticos solo para payloads/histórico antiguos.
5. Tipos de presentación `Product`, `Category`, `CatalogTab`, `CatalogPlacement`, etc. en `src/types/domain.ts` y sus filas antiguas en `src/types/supabase.ts`.
6. Páginas CRM `SaleFormatsPage`, `ProductsPage`, `CatalogOrganizationPage`, `ComplementsPage` y sus formularios.
7. Componentes TPV `CatalogPanel` y `ProductDialog`, que reciben la proyección final pero conservan props y términos visuales antiguos.
8. RPC históricas con sufijos y objetos de migración 29 siguen desplegados, pero la carga principal y `save_catalog_order_lines` no los usan como fuente funcional de catálogo.

No existe doble escritura en la capa nueva. Las escrituras legacy anteriores permanecen encapsuladas en las pantallas aún no migradas y no son invocadas por `CatalogRepository` ni `CatalogCommandService`.

## Validación aislada

Las migraciones 39 y 40 se compilaron en PostgreSQL 17 sobre dos bases aisladas. Los fixtures ejecutan dentro de transacciones con rollback:

- lectura por local y conteo;
- creación completa;
- default automática y cambio de default;
- rechazo al borrar la default;
- placement fijado;
- rechazo cross-venue;
- reordenación;
- rollback de operación compuesta inválida;
- creación real de línea mediante `save_catalog_order_lines`;
- hard delete con ticket/snapshot conservado.

Fixtures: `tests/fixtures/catalog-rebuild/catalog-domain-phase-3-1.sql` y `catalog-domain-clean-smoke.sql`.
