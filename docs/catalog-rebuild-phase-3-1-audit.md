# Reconstrucción del catálogo — fase 3.1: mapa previo de dependencias

Fecha: 2026-07-22. Este documento congela la auditoría realizada antes de modificar la capa de backend. No autoriza cambios visuales ni la retirada de objetos legacy.

## Esquema y herramientas revisados

- Migraciones `30`–`38`: tablas finales, importación/exportación, desacoplamiento histórico, permisos, validaciones de alcance y auditoría.
- Documentación de fases 1 y 2, contrato JSON v2, conversión, importador ZIP/directo y comparador semántico.
- `saleLineBuilder.ts` y su implementación base: cálculo en céntimos, componentes, modificadores, snapshots y rechazo de precio negativo.
- Migración 29 y RPC relacionadas con catálogo, comandas y snapshots.

## Lecturas y transformaciones actuales

| Punto | Dependencia actual | Consumidores | Decisión de fase 3.1 |
|---|---|---|---|
| `src/services/posService.ts::loadCatalogFromSupabase` | Lee `sale_formats`, columnas legacy de `products`, `selection_group_items`, `variant_selection_groups`, `product_modifier_groups` y `default_variant_id`. | AppShell, TPV, mesas, diálogos y estado offline. | Sustituir por el repositorio final y una proyección temporal de solo lectura para la UI existente. |
| `src/features/catalog/services/catalogAccess.ts` | Deriva tabs y placements desde formatos/aliases cuando faltan relaciones. | CatalogPanel, ProductDialog y saleLineBuilder base. | Eliminar el fallback funcional; consumir exclusivamente la proyección del catálogo final. |
| `src/lib/catalog.ts` | Resuelve variantes por formato/nombre/posición. | TPV y formularios CRM. | Mantener solo para pantallas aún no migradas; no usar desde el dominio final. |
| `src/lib/mixers.ts` | Adapta `mixer:<uuid>` histórico. | Impresión y payloads antiguos. | Conservar exclusivamente para render histórico/offline; no usar en nuevas lecturas. |
| `catalogImportService.ts` | Importación CRM antigua por merge a tablas legacy. | Pantalla de importación actual. | Queda para fase 3.2; la importación final de fase 2 ya usa `import_catalog`. |

## Escrituras actuales

`src/features/crm/catalog/services/catalogService.ts` escribe categorías tenant-global, formatos, columnas antiguas de producto, `default_variant_id`, `selection_group_items`, `variant_selection_groups` y `product_modifier_groups`. Estas llamadas están ligadas a formularios visuales basados en formatos y se mantienen temporalmente hasta fase 3.2. No serán reutilizadas por la capa nueva. La fase 3.1 prepara comandos finales separados que escriben únicamente las tablas finales.

## RPC y funciones SQL relacionadas

- `save_restaurant_order_lines_v3` y `canonical_catalog_component_modifiers` consultan relaciones de migración 29.
- Las funciones `sync_sale_created*`, cierre/división de comandas y triggers de snapshot conservan compatibilidad histórica.
- `import_catalog` y `export_catalog` ya trabajan con el destino final.
- Los UUID de `order_lines`, `ticket_lines` y sus componentes son snapshots sin FK viva al catálogo.

La fase 3.1 añade una RPC agregada de lectura y comandos transaccionales finales. No elimina ni renombra funciones históricas; el nuevo servicio de comandas usará un nombre definitivo sin sufijos.

## Tipos legacy

`Product`, `ProductVariant`, `Category`, `CatalogTab`, `CatalogPlacement`, `SelectionGroup`, `ModifierGroup` y `Catalog` en `src/types/domain.ts` reflejan la forma consumida por la UI actual. Los campos `kind`, `saleFormats`, `canSellStandalone`, `canUseAsMixer`, `isFeatured` global y `mixerSupplementCents` no pertenecen al dominio final. Se mantienen únicamente como contrato temporal de presentación y se construirán desde el modelo definitivo mediante un adaptador de solo lectura.

## Puntos de precio duplicado

- `saleLineBuilder-base.ts` es la fuente actual para base + componentes + modificadores.
- `restaurantPrintPayload.ts` reconstruye desglose para imprimir datos históricos; no decide precios de venta nuevos.
- Informes agregan snapshots históricos y no deben consultar precios vivos.
- Formularios CRM muestran cálculos fiscales, pero no construyen líneas de venta.

La fase 3.1 centraliza el desglose nuevo sobre `saleLineBuilder.ts` y `tax.ts`; impresión e informes permanecen como consumidores de snapshots.

## Supabase dentro de React

No hay lecturas directas de tablas de catálogo dentro de componentes `.tsx`. Las llamadas están concentradas en servicios. Los componentes sí importan selectores legacy, que serán sustituidos en fases visuales posteriores.

## Caché e invalidación actuales

El catálogo se carga en `AppShell` y se mantiene en estado de aplicación; no existe caché de repositorio con claves por local/modo/producto. La fase 3.1 introduce esa caché e invalida tras cada comando final e importación.

## Límite explícito de la fase

No se rediseñan páginas CRM/TPV, no se elimina ninguna tabla/columna/función legacy y no se añade doble escritura. Los puntos legacy que queden conectados por dependencia visual se enumerarán en la documentación final de fase 3.1.
