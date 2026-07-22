# Auditoría real del catálogo — Fase 4

## Alcance y método

La auditoría se hizo sobre las migraciones `1`–`41`, el consolidado anterior, los tipos activos, todas las referencias de `src/`, tests, fixtures y herramientas de transferencia. Además de búsquedas por símbolo, la migración 42 consulta `pg_proc`, `pg_class`, `pg_namespace` e `information_schema` y aborta si encuentra dependencias ejecutables no contempladas. La eliminación se probó en PostgreSQL 17 aislado y se inspeccionó después mediante catálogos (relaciones, columnas, constraints/FK, índices, funciones y firmas, triggers, policies, grants, RLS y comentarios).

No se consultó ni modificó Supabase. Por ello la cardinalidad real del entorno remoto no se inventa: la columna «datos presentes» describe la semántica encontrada y la migración calcula los IDs reales antes de cualquier `DROP`. El fixture aislado contiene filas en todos los puentes residuales y demuestra su conversión.

En esta limpieza final se aplica una política destructiva: cualquier fila de catálogo que no cumpla alcance, integridad o representación final se elimina en orden de dependencias. Tras convertir las equivalencias legacy exactas, también se eliminan productos activos sin aparición ni uso como opción. Las filas históricas incompletas que impedirían el corte se eliminan; no se conservan como excepción.

## Inventario y decisión

| Tipo | Nombre | Estado / clasificación | Consumidor antes de Fase 4 | Datos presentes | Sustitución final | Acción | Orden | Riesgo |
|---|---|---|---|---|---|---|---:|---|
| Tabla | `sale_formats` | eliminar; requiere migración previa | funciones históricas y FK de variantes | formato nominal por tenant | variante + tab/placement | validar equivalencia, retirar FK/RLS/grants/índices y eliminar | 15 | alto: formato sin representación inequívoca |
| Tabla | `selection_group_items` | eliminar; requiere migración previa | trigger legacy y migraciones | opción, producto/variante, suplemento y orden | `selection_group_options` | convertir semánticamente y eliminar | 15 | alto: opción o alcance ambiguo |
| Tabla | `variant_selection_groups` | eliminar; requiere migración previa | asignación antigua de grupos | variante, grupo y orden | asignaciones finales y tabla de variantes | convertir, comparar y eliminar | 15 | alto: asignación parcial |
| Tabla | `product_modifier_groups` | eliminar; requiere migración previa | puente antiguo de modifiers | producto, variante, grupo y orden | asignaciones finales de modifier groups | convertir, comparar y eliminar | 15 | alto: variante de otro producto/local |
| Tabla | tablas finales del catálogo | conservar | CRM, TPV, importación y RPC | dominio vivo definitivo | la misma tabla | mantener con RLS | — | bajo |
| Columna | `categories.kind` | eliminar | clasificación legacy | alias de categoría | tabs, placements y tipo de producto | retirar check y columna | 16 | medio |
| Columnas | `products.category_id`, `products.is_featured` | eliminar; requiere migración previa | proyección legacy | ubicación/featured global | `catalog_placements.category_id/is_featured` | exigir equivalencia y eliminar | 16 | alto |
| Columna | `products.image_path` | eliminar; requiere migración previa | compatibilidad de imagen | ruta única antigua | `product_images` | exigir imagen final exacta y eliminar | 16 | alto |
| Columnas | `products.kind`, `products.sale_formats` | eliminar | contrato antiguo | clasificación/array de formatos | `product_type`, variantes y placements | eliminar tras reemplazar funciones | 16 | medio |
| Columnas | `products.can_sell_standalone`, `products.can_use_as_mixer` | eliminar | flags antiguos | capacidad inferida | placement activo / opción final | validar visibilidad/uso y eliminar | 16 | medio |
| Columna | `products.mixer_supplement_cents` | eliminar; requiere migración previa | mixer legacy | suplemento contextual | `selection_group_options.supplement_cents` | exigir equivalencia exacta y eliminar | 16 | alto |
| Columna | `product_variants.sale_format_id` | eliminar; requiere migración previa | FK a formatos | formato legacy | variante + representación tab/placement | validar, retirar FK/índice y eliminar | 16 | alto |
| Columna | `catalog_placements.default_variant_id` | eliminar; requiere migración previa | resolución transitoria | variante fijada | `catalog_placements.variant_id` | completar solo si no es ambiguo y eliminar | 16 | alto |
| Columnas | `selection_groups.min_select/max_select` | eliminar; requiere migración previa | límites globales legacy | límites de selección | límites por asignación final | propagar/validar y eliminar | 16 | alto |
| Columnas | `modifier_groups.product_id/min_select/max_select` | eliminar; requiere migración previa | pertenencia/límites antiguos | producto y capacidad | asignación final por producto/variante | convertir/validar y eliminar | 16 | alto |
| Columna | `modifiers.price_cents` | eliminar; requiere migración previa | precio duplicado | suplemento en céntimos | `supplement_cents` | sincronizar solo si inequívoco, comparar y eliminar | 16 | alto |
| RPC | `add_restaurant_order_line*` | eliminar | ningún import activo | creación antigua de líneas | `save_catalog_order_lines` + constructor final | revocar y eliminar | 9 | medio |
| RPC | `save_restaurant_order_lines`, `save_restaurant_order_lines_v3` | eliminar | ningún import activo | guardado de comanda antiguo | firma definitiva sin sufijo | revocar y eliminar | 9 | medio |
| Función | `canonical_catalog_component_modifiers` | eliminar | solo RPC antiguas | lectura de modifiers legacy | `canonical_catalog_modifiers` | revocar y eliminar | 9 | medio |
| Función trigger | `validate_catalog_relation` | eliminar | triggers de puentes legacy | validación de esquema doble | constraints/triggers finales | retirar triggers y función | 11 | medio |
| Funciones | `catalog_command`, `canonical_catalog_modifiers`, `save_catalog_order_lines`, `capture_ticket_line_catalog_snapshot`, `validate_final_catalog_scope`, `import_catalog`, `export_catalog` | reemplazar | frontend y RPC finales | algunas implementaciones conservaban lecturas legacy | relaciones finales + snapshots | reemplazar antes de los drops | 8 | alto |
| Función | `persist_catalog_order_line_draft` | conservar; nueva interna | `save_catalog_order_lines` | persistencia de línea final | modelo final | crear sin grant al cliente | 8 | medio |
| Funciones | `get_catalog`, `catalog_command_batch`, `catalog_tab_category_command`, `catalog_image_command` y RPC finales de venta/mesa/cobro | conservar | CRM/TPV | solo relaciones finales según inspección de `pg_get_functiondef` | las mismas | smoke test y verificación final | 22 | alto |
| Vista / materialized view | ninguna legacy confirmada | conservar ausencia | ninguno | no se hallaron objetos dependientes | — | preflight aborta si aparece una | 10 | alto si el remoto difiere |
| Trigger | triggers sobre las cuatro tablas legacy y `validate_catalog_placements_relation` | eliminar | tablas/columna legacy | validación y timestamps antiguos | triggers finales de alcance/auditoría | eliminar explícitamente | 11 | medio |
| Policy | policies de las cuatro tablas legacy | eliminar | RLS legacy | select/admin manage | RLS de tablas finales | eliminar y revocar | 12 | medio |
| Policy | `modifier_groups_select`, `modifiers_select`, `categories_select` | reemplazar | runtime final | cuerpo aún ligado a columnas antiguas | predicates finales por acceso a local | sustituir | 20 | alto |
| Índice | índices de tablas legacy, `product_variants_format_idx`, `products_tenant_idx`, `modifier_groups_product_idx` | eliminar/reemplazar | planner | claves/columnas eliminadas | índices finales por tenant/local/activo | eliminar y recrear equivalentes finales | 14/19 | medio |
| Constraint/FK | FK/checks de columnas legacy listados en migración 42 | eliminar | integridad antigua | referencias y checks obsoletos | constraints finales existentes | retirar uno a uno | 13 | alto |
| Grant | grants de tablas/RPC legacy | eliminar | `authenticated`/`anon` | permisos sobre objetos obsoletos | mínimo privilegio final | revocar antes del drop | 12 | alto |
| Tipos TS | tipos de tablas/filas y dominio legacy | eliminar | ninguno en grafo compilado | propiedades inexistentes | dominio final | retirar y compilar | aplicación | medio |
| Snapshot | `sale_format_id/name`, nombres, precios, IVA, components y modifiers en líneas históricas | histórico no runtime; conservar | informes, impresión e histórico | copia inmutable de una venta | el mismo snapshot | conservar sin lectura de catálogo vivo | — | crítico si se confunde con dominio vivo |
| Storage | bucket/policies `product-images` | conservar | CRM de imágenes | WebP por carpeta de tenant | `product_images` + Storage | conservar en consolidado final | 20 | medio |

## Dependencias y orden confirmado

No se encontraron enums, tipos compuestos, secuencias exclusivas, columnas generadas, views o materialized views legacy adicionales. Las dependencias confirmadas se retiran en el orden: funciones consumidoras, RPC sin consumidores, triggers, policies/grants, índices, FK/checks, tablas puente, columnas, e índices/policies finales. No se usa `CASCADE`.

Los nombres históricos que permanecen están confinados a snapshots (`ticket_lines`, `order_lines`, tipos `SaleLineCatalogSnapshot`) o a migraciones/fixtures anteriores a la limpieza. No intervienen en edición, pricing ni resolución de líneas nuevas.