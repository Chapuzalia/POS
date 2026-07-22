# Reconstrucción del catálogo — Fase 3.3

Fecha: 2026-07-22.

## Resultado

El TPV consume directamente `CatalogData` obtenido con `CatalogRepository.getCatalog(venueId, 'pos')`. Ya no existe una proyección a `Catalog`, `Product`, `ProductVariant` o `SaleFormat`, ni un fallback de lectura al catálogo anterior.

La carga POS mantiene descuentos y la configuración de descuento manual como estado separado. La caché offline guarda esta estructura definitiva con una clave nueva y aislada por tenant y local, por lo que nunca deserializa el formato legacy.

## Flujo definitivo

```text
loadTenantState / refreshCatalog
  -> loadPosCatalogFromSupabase
    -> loadPosCatalog
      -> CatalogRepository.getCatalog(venueId, 'pos')
      -> descuentos activos + configuración del local
  -> AppShell mantiene CatalogData
    -> resolveSellableCatalog para tabs, categorías y placements
    -> resolveSellableProduct para variantes, grupos y modificadores
    -> buildSaleLine para venta rápida y mesas
      -> calculateCatalogPrice
```

Los componentes React no consultan Supabase. El panel conserva tabs, categorías, destacados, búsqueda, placements repetidos y selección directa de variantes. El diálogo trabaja con grupos definitivos para mixers, componentes de menú y modificadores del producto, variante o componente.

## Precio, líneas y snapshots

`calculateCatalogPrice` es la fuente monetaria de las líneas nuevas. Opera con enteros en céntimos e incluye precio base, suplementos contextuales, componentes de menú y modificadores. Tanto venta rápida como mesas llaman al mismo `buildSaleLine`; no mantienen constructores paralelos.

Cada línea nueva captura producto, tipo, variante, precio base, IVA, placement, categoría, pestaña, componentes, cantidades y modificadores. Los campos de formato de venta se conservan solo como columnas históricas del snapshot; no participan en la resolución del catálogo actual.

Los tickets y comandas anteriores se normalizan con sus propios nombres, IDs e importes guardados. El render histórico no necesita consultar un producto vivo ni sustituye el precio persistido.

## Código temporal retirado

- `src/features/catalog/compatibility/project-current-ui.ts`
- `src/features/catalog/data/load-current-catalog.ts`
- `src/features/catalog/services/catalogAccess.ts`
- `src/features/catalog/services/saleLineBuilder-base.ts`
- `src/lib/catalog.ts`

Las utilidades de importación/exportación que describen el esquema anterior quedan fuera del runtime del TPV y se conservan para compatibilidad de backups y migraciones.

## SQL y rollback

Esta fase no contiene ni ejecuta SQL destructivo. Las tablas y columnas anteriores siguen disponibles para un rollback de despliegue. Las precondiciones, candidatos, orden y restauración de una limpieza futura están documentados en `docs/catalog-rebuild-final-sql-cleanup.md`; requieren autorización expresa en otra fase.

## Verificación

Las pruebas de arquitectura impiden reintroducir los adaptadores temporales, `SaleFormat` en el runtime POS, una caché no aislada por local o constructores de línea distintos. Las pruebas de dominio cubren suplementos contextuales, menús, consumos, grupos, snapshots e histórico sin producto vivo.
