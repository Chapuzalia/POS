# Fase 4 — consolidación final del catálogo

## Objetivo y resultado

La Fase 4 elimina el esquema doble después de convertir todos los residuos inequívocos. PostgreSQL queda con productos, variantes, tabs, categorías, placements, Selection Groups, modifiers, imágenes y sus asignaciones finales. CRM y TPV usan el repositorio, resolver, pricing y constructor de líneas definitivos. El histórico sigue siendo autónomo mediante snapshots.

La migración ejecutable es `supabase/42.catalog-final-legacy-cleanup.sql`. Es forward-only, transaccional, obtiene un advisory lock, ejecuta preflight de datos y dependencias, convierte residuos, reemplaza funciones, elimina objetos de forma explícita, valida el resultado y solo entonces hace `COMMIT`. No contiene `CASCADE`.

## Inventario de limpieza SQL

Se eliminan las tablas `sale_formats`, `selection_group_items`, `variant_selection_groups` y `product_modifier_groups`.

Se eliminan estas columnas:

- `categories.kind`;
- `products.category_id`, `image_path`, `kind`, `sale_formats`, `can_sell_standalone`, `can_use_as_mixer`, `is_featured` y `mixer_supplement_cents`;
- `product_variants.sale_format_id`;
- `catalog_placements.default_variant_id`;
- `selection_groups.min_select` y `max_select`;
- `modifier_groups.product_id`, `min_select` y `max_select`;
- `modifiers.price_cents`.

Se eliminan las RPC `add_restaurant_order_line`, `add_restaurant_order_line_with_mixer`, `save_restaurant_order_lines`, `save_restaurant_order_lines_v3`, además de `canonical_catalog_component_modifiers` y `validate_catalog_relation`. Se reemplazan `catalog_command`, `canonical_catalog_modifiers`, `save_catalog_order_lines`, `capture_ticket_line_catalog_snapshot`, `validate_final_catalog_scope`, `import_catalog` y `export_catalog`; la persistencia interna de líneas queda encapsulada en `persist_catalog_order_line_draft`, sin grant al cliente.

No existían views, materialized views, enums o secuencias legacy adicionales confirmados. La migración elimina explícitamente los triggers de validación/timestamp de los puentes, las policies select/manage de las tablas eliminadas, sus grants, los índices de identidad/búsqueda y las FK/checks de columnas retiradas. Reemplaza las policies finales que aún dependían de columnas antiguas y crea índices finales por tenant/local/actividad. El detalle objeto por objeto está en `docs/catalog-rebuild-phase-4-audit.md`.

## Conversión residual

Antes de eliminar nada se comparan origen y destino por tenant, local, producto, variante y semántica:

- `default_variant_id` se materializa en `catalog_placements.variant_id` solo cuando no contradice el destino;
- `selection_group_items` se convierte en `selection_group_options`;
- `variant_selection_groups` se convierte en asignaciones finales y alcance de variantes;
- `modifier_groups.product_id` y `product_modifier_groups` se convierten en asignaciones finales de modifier groups;
- `modifier_groups.min_select/max_select` pasan a la asignación contextual;
- `modifiers.price_cents` se verifica/sincroniza con `supplement_cents`;
- categoría, featured, imagen, mixer supplement y sale format legacy deben tener equivalencia final exacta.

Cualquier ambigüedad aborta con `PHASE4_PREFLIGHT_FAILED`, IDs y contexto, dentro de la misma transacción.

## Objetos conservados y seguridad

Se conservan las tablas finales del catálogo, tickets, ventas, comandas, líneas, componentes, descuentos, caja e impresión. Las tablas finales mantienen RLS; las relaciones contienen tenant/local y los constraints/triggers impiden referencias cruzadas. Las policies finales derivan acceso mediante el local, y las funciones `SECURITY DEFINER` finales fijan `search_path` y conservan grants mínimos. El bucket `product-images` continúa público para descarga, pero listar o mutar objetos exige un administrador del tenant indicado por la carpeta.

## TypeScript y transferencia

Los tipos activos de Supabase ya no declaran tablas, columnas ni RPC eliminadas. El dominio vivo perdió formatos, flags y puentes legacy. `SaleLineCatalogSnapshot` conserva de forma explícita los campos históricos necesarios, separados del producto editable.

El contrato de exportación es schema version 3. Exporta solo categorías, tabs, relaciones, productos, variantes, placements, grupos/opciones/asignaciones, modifiers/asignaciones e imágenes. Un documento v2 puede actualizarse al contrato v3 retirando `saleFormats`; REVO clasifica su formato externo localmente y produce el contrato final, sin escribir el esquema antiguo.

## Histórico

No se eliminan ni recalculan snapshots. Nombres, variantes, precio base/final, cantidad, IVA, descuento, componentes, mixers, modifiers, suplementos, notas, tab, categoría e información de impresión permanecen en líneas históricas. Los identificadores históricos no constituyen una FK obligatoria hacia el catálogo vivo; el fixture elimina un producto vivo y demuestra que el ticket conserva nombre, componente y desglose fiscal sin consultar el catálogo.

## Consolidado y equivalencia

`supabase/0.complete-database.sql` crea directamente el estado posterior a Fase 4: no crea objetos legacy para borrarlos después. El comparador `scripts/catalog-rebuild/compare-final-schemas.ps1` contrasta una instalación limpia (ruta A) con el histórico más migraciones hasta 42 (ruta B), usando catálogos PostgreSQL para schemas, relaciones/RLS, columnas/tipos/nullability/defaults/generated/comments, constraints/FK, índices, funciones/firmas/retorno/volatilidad/security/search path, triggers, policies y grants. Solo ignora OID, owner y posición física de columnas.

## Pruebas

- `tests/catalog-rebuild-phase-4.test.mjs`: orden/seguridad de la migración, ausencia legacy, grafo real de imports, tipos y contrato v3;
- `tests/fixtures/catalog-rebuild/catalog-final-cleanup.sql`: conversión y smoke tests sobre PostgreSQL aislado;
- `scripts/catalog-rebuild/validate-phase4.ps1`: reconstruye el estado anterior y ejecuta la fixture local;
- `scripts/catalog-rebuild/compare-final-schemas.ps1`: equivalencia semántica de ambas rutas;
- suite de aplicación: resolver, CRM, TPV, pricing, líneas, ventas, mesas, división, cobro, impresión, histórico, import/export, caché e aislamiento.

## Cómo ejecutar la migración 42

1. Abrir SQL Editor en Supabase.
2. Copiar el contenido completo de `supabase/42.catalog-final-legacy-cleanup.sql`.
3. Ejecutarlo una sola vez, como una única operación.
4. Comprobar la fila `PHASE4_CATALOG_FINAL_CLEANUP_OK`.
5. No volver a ejecutarlo si terminó correctamente.
6. Desplegar el código de Fase 4 inmediatamente después.

Codex no ejecutó esta migración contra Supabase. Solo se validó en PostgreSQL local, aislado y desechable.

## Verificaciones posteriores y riesgos

Después de aplicarla, comprobar la carga de catálogo CRM/TPV, crear y editar un producto, realizar una venta y abrir un ticket histórico. La migración se detiene si el entorno remoto contiene datos ambiguos o dependencias SQL no inventariadas; el error identifica el conjunto afectado. El bloqueo puede esperar a transacciones concurrentes hasta el timeout configurado.

La operación es destructiva y forward-only. El rollback solo es posible mediante restauración externa o una reversión manual preparada a partir del estado anterior; no existe down migration ni esquema paralelo.
