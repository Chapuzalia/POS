# Limpieza SQL final del catálogo — preparación, no ejecutar

Estado: **borrador destructivo para una fase futura**. La Fase 3.3 no crea ni aplica esta migración. Producción y desarrollo comparten base de datos; cualquier `DROP` requiere una ventana separada, backup verificado y validación real del TPV definitivo.

## Condiciones obligatorias antes de autorizarla

1. Desplegar la Fase 3.3 y validar durante el periodo acordado: inicio online/offline, búsqueda, tabs, categorías, featured, variantes, mixers, menús, modifiers, venta rápida, mesas, edición, repetición, división, cobro, impresión y recuperación histórica.
2. Confirmar que todos los clientes activos ejecutan una versión sin `project-current-ui`, `load-current-catalog`, `sale_formats`, `selection_group_items`, `variant_selection_groups` ni `product_modifier_groups` en runtime.
3. Ejecutar las verificaciones de fases 2/3 y obtener cero errores de alcance, referencias, defaults, precios, placements y snapshots.
4. Crear backup lógico y snapshot gestionado; ensayar restauración en un entorno aislado.
5. Congelar despliegues y escrituras de catálogo durante la migración.
6. Revisar `pg_depend`, triggers, policies, grants, vistas y funciones para cada objeto candidato. No usar `CASCADE` como atajo.

## Objetos candidatos

Tablas transitorias sustituidas por el dominio final:

- `sale_formats`;
- `selection_group_items` → `selection_group_options`;
- `variant_selection_groups` → `product_selection_group_assignments` y su tabla de variantes;
- `product_modifier_groups` → `product_modifier_group_assignments` y su tabla de variantes.

Columnas transitorias o legacy:

- `categories.kind`;
- `products.category_id`, `products.kind`, `products.sale_formats`, `products.can_sell_standalone`, `products.can_use_as_mixer`, `products.is_featured`, `products.mixer_supplement_cents`;
- `product_variants.sale_format_id`;
- `catalog_placements.default_variant_id`;
- `modifier_groups.product_id`, `modifier_groups.min_select`, `modifier_groups.max_select`;
- `modifiers.price_cents` cuando todo consumidor use `supplement_cents`.

El inventario debe validarse contra el esquema real antes de redactar SQL. `products`, `product_variants`, `categories`, `catalog_tabs`, `catalog_tab_categories`, `catalog_placements`, `selection_groups`, `selection_group_options`, asignaciones finales, `modifier_groups`, `modifiers`, `product_images`, líneas, componentes y snapshots **no son candidatos a eliminación**.

## Funciones y esquema consolidado

Antes de retirar columnas, crear una versión de `catalog_command` que deje de mencionar `products.category_id` y `products.kind`. Después revisar y retirar únicamente funciones públicas antiguas que hayan quedado sin llamadas, por ejemplo las variantes con sufijo histórico de comandas/ventas. Las RPC definitivas `get_catalog`, `catalog_command`, `catalog_command_batch` y `save_catalog_order_lines` deben conservarse.

El mismo cambio futuro debe actualizar `supabase/0.complete-database.sql` para que una instalación limpia nazca ya con el esquema final. No se debe editar solo el consolidado ni solo la migración: ambos deben representar el mismo estado.

## Consultas de preflight

La migración futura debe abortar si detecta dependencias o datos sin convertir. Como mínimo comprobar:

- productos activos sin variante predeterminada activa única;
- productos visibles sin placement definitivo;
- placements con `variant_id`, tab, categoría, producto o local incoherentes;
- opciones/asignaciones finales inexistentes o fuera de local;
- filas presentes solo en tablas transitorias sin equivalente final;
- funciones, vistas, triggers o policies que dependan de objetos candidatos;
- código desplegado que todavía invoque RPC antiguas;
- snapshots históricos incompletos según la política aceptada.

La comparación de tablas transitorias y finales debe ser semántica y por local; un simple conteo global no es suficiente.

## Orden previsto de la migración destructiva

1. Bloque transaccional y advisory lock específico del catálogo.
2. Ejecutar preflight y abortar ante cualquier discrepancia.
3. Reemplazar funciones definitivas que aún mencionen columnas candidatas.
4. Revocar permisos y retirar policies/triggers exclusivos de objetos transitorios.
5. Eliminar constraints/FK e índices dependientes de forma explícita.
6. Eliminar tablas y columnas candidatas sin `CASCADE`.
7. Recrear/validar constraints finales, grants, RLS y comentarios.
8. Ejecutar smoke tests de lectura, comando, comanda y venta dentro de la ventana.
9. Confirmar la transacción solo si todas las verificaciones pasan.

## Rollback

Antes del commit puede hacerse rollback transaccional. Después de confirmar objetos eliminados, el único rollback seguro es restaurar el backup/snapshot y volver a desplegar la versión de código correspondiente. Por eso esta limpieza no debe mezclarse con cambios funcionales ni ejecutarse desde la Fase 3.3.
