# Reconstrucción del catálogo — fase 1: auditoría, preservación y diseño

Fecha de auditoría: 2026-07-22. Alcance: repositorio completo en `main`. Esta fase es exclusivamente preparatoria: no aplica el esquema propuesto, no migra datos y no modifica el comportamiento del TPV ni del CRM.

## 1. Resultado ejecutivo y límites

El repositorio contiene dos capas de catálogo. El núcleo original está en `supabase/0.complete-database.sql`: categorías y formatos globales al tenant, productos por local, variantes, grupos de modificadores propietarios y varios campos funcionales en `products`. `supabase/29.catalog-architecture-migration.sql` añade pestañas, colocaciones, grupos de selección, asignaciones por variante y snapshots/componentes históricos, pero mantiene todos los campos originales. El cliente actual consume ambas capas y conserva un fallback explícito en `src/features/catalog/services/catalogAccess.ts`.

La migración 29 no coincide todavía con el modelo definitivo aprobado:

- No existe `catalog_tab_categories`.
- `categories` y `sale_formats` siguen siendo globales al tenant, no por local.
- `catalog_placements.category_id` es obligatorio y su unicidad no incluye la variante fijada.
- Los mínimos y máximos siguen en `selection_groups`, no en la asignación.
- La asignación de grupos de selección es directamente variante-grupo; no existe asignación producto-grupo con subconjunto de variantes.
- `selection_group_items` no guarda cantidades predeterminadas/máximas.
- `modifier_groups` sigue teniendo un producto propietario.
- El CRM y el ZIP actual siguen escribiendo/transportando `kind`, `sale_formats`, `can_sell_standalone`, `can_use_as_mixer`, `is_featured` global y `mixer_supplement_cents`.
- `catalog_profile` continúa persistido en el local.

La herramienta temporal de esta fase vive en `scripts/catalog-rebuild-phase-1/`. Solo hace consultas `select`, pagina todos los resultados, genera referencias internas y nunca llama a `insert`, `update`, `delete`, `upsert` o RPC. Si una tabla aditiva no está desplegada, conserva el resto y registra el problema. Los IDs de base se guardan únicamente en `trace`; ninguna relación del archivo depende de ellos.

## 2. Auditoría realizada

Se revisaron los 31 archivos SQL de esquema/migración, el esquema consolidado, la función Edge, los tipos, servicios, pantallas, hooks, impresión, informes, almacenamiento offline, importación/exportación, fixtures, scripts, tests y documentación. Las búsquedas globales incluyeron `kind`, `category_id`, `is_featured`, `sale_formats`, `can_sell_standalone`, `can_use_as_mixer`, `mixer_supplement`, `mixer_product`, `catalog_profile`, `selection_group`, `modifier_group`, `placement`, `variant`, `menu`, `component` y `snapshot`.

### 2.1 Inventario de tablas actuales afectadas

| Tabla actual | Finalidad y columnas relevantes | Relaciones actuales | Datos a preservar y destino | Riesgo |
|---|---|---|---|---|
| `tenants` | Propietario organizativo. `id`, nombre, slug. | Padre de toda la información. | Metadatos de origen y `tenant_id` de todas las filas finales. | Bajo; no se importa un tenant al copiar catálogo. |
| `venues` | Local. Dirección, datos fiscales, `default_tax_rate`, moneda, zona horaria y `catalog_profile`. | Pertenece a tenant; padre de productos y tablas de catálogo aditivas. | Metadatos, configuración fiscal y local de destino. `catalog_profile` solo queda como trazabilidad; las plantillas no son perfil permanente. | `catalog_profile=custom` no tiene equivalencia final. |
| `categories` | Organización original global al tenant. `name`, `kind`, icono, orden, activo. | `products.category_id`; `catalog_placements.category_id`. | Una categoría final por local, asociaciones a pestañas y colocaciones. `kind` solo trazabilidad. | Una categoría compartida puede tener significados distintos entre locales; hay que clonar por local. |
| `sale_formats` | Seis formatos/pestañas históricas configurables. `key`, label, orden, activo. | Array `products.sale_formats`; FK opcional `product_variants.sale_format_id`; backfill de pestañas. | Solo fuente de conversión: variantes, pestañas y colocaciones. No existe como entidad funcional final. | Alias/nombre/posición no siempre permiten emparejar variante y formato con certeza. |
| `products` | Producto por local. `category_id`, `product_type`, nombre, imagen, `kind`, arrays/booleanos históricos, IVA, orden y estado. | Padre de variantes; propietario de modificadores; colocado y usado como opción. | `products`, imágenes, IVA; organización y rol mixer pasan a relaciones finales. | Contradicciones entre booleanos históricos y tablas aditivas; destacado global ambiguo. |
| `product_variants` | Nombre, precio, SKU, predeterminada, orden; migración 29 añade formato y activo. | Hija de producto; puede fijarse en colocaciones/opciones/asignaciones. | `product_variants`; `sale_format_id` solo traza la conversión. | Productos sin variante, sin predeterminada o con varias; formato sin correspondencia. |
| `catalog_tabs` | Pestañas por local añadidas por migración 29. | Padre de colocaciones. | `catalog_tabs`. | Pueden ser backfill y no edición deliberada; se conserva `trace`. |
| `catalog_placements` | Producto en pestaña/categoría, variante fijada opcional, destacado, orden, estado. | Producto, pestaña, categoría y variante. | `catalog_placements` y asociación derivada `catalog_tab_categories`. | Categoría hoy obligatoria; unicidad actual bloquea coexistencia con/sin variante para la misma terna. |
| `selection_groups` | Grupo por local, tipo `mixer`/`menu_component`, mínimos/máximos, orden, estado. | Padre de opciones; asignado a variantes. | `selection_groups`; mínimos/máximos se copian a cada asignación. | Si el mismo grupo se reutiliza con reglas diferentes, el modelo actual no puede expresarlo. |
| `selection_group_items` | Opción con producto/variante, suplemento contextual, predeterminada, orden, estado. | Grupo y producto; variante opcional. | `selection_group_options`, con `default_quantity=1/0`; `max_quantity` queda nulo. | El booleano predeterminado no expresa múltiples unidades; requiere revisión si el máximo era mayor que uno. |
| `variant_selection_groups` | Asignación variante-grupo con orden. | Variante y grupo. | Se agrupa en `product_selection_group_assignments` y su tabla de variantes. | No hay nombre visible ni estado propio; se heredan del grupo. |
| `modifier_groups` | Grupo propietario de producto, mínimos/máximos, orden; migración 29 añade activo. | `product_id` propietario; padre de modificadores. | `modifier_groups` reutilizable y asignación al propietario/targets. | “Propietario” y “asignado” pueden divergir; el propietario se conserva en trazabilidad. |
| `modifiers` | Nombre, suplemento, orden; migración 29 añade predeterminado/activo. | Hijo del grupo. | `modifiers`. | No hay referencia de stock, lo cual es correcto. |
| `product_modifier_groups` | Reutilización por producto y variante opcional. | Producto, variante y grupo. | `product_modifier_group_assignments` + variantes afectadas. | El trigger actual valida tenant, pero no comprueba explícitamente local del propietario del grupo. |
| `tickets` | Cabecera histórica, local/dispositivo/caja, totales, descuentos, fecha y estado. | Padre de líneas y venta/pagos. | `tickets` final, sin dependencia del catálogo vivo. | Varias RPC históricas construyen tickets con semánticas distintas. |
| `ticket_lines` | IDs vivos opcionales, nombres, cantidades, precios, modificadores JSONB e IVA. Migración 29 añade snapshots de formato/categoría/pestaña y desglose. | Ticket; FKs de producto/variante con `set null`. | Columnas históricas normalizadas y JSONB completo de respaldo. Los UUID históricos finales no tendrán FK al catálogo vivo. | Líneas antiguas carecen de pestaña/categoría histórica fiable. |
| `ticket_line_components` | Componentes/mixers normalizados, snapshots, suplemento, cantidad y metadata. | Línea; FKs vivas opcionales hoy. | Tabla histórica hija final sin FKs al catálogo vivo. | El trigger copia desde evento offline o comanda por heurística; puede no encontrar origen unívoco. |
| `orders` / `order_lines` | Comandas abiertas; la línea guarda producto/variante, nombres, precio, modificadores, mixer histórico, componentes y snapshot. | Local/caja; producto/variante vivos. | Deben mantener snapshot y componentes hasta convertirse en ticket. | Borrado físico del catálogo no puede invalidar una comanda abierta. |
| `order_line_components` | Espejo normalizado de componentes de comanda. | Línea de comanda y referencias vivas opcionales. | Se conserva conceptualmente hasta el cobro; copia a histórico. | RPC antiguas de división/cobro pueden no copiar componentes. |
| `offline_event_log` | Payload íntegro de ventas offline. | Tenant y evento. | Fuente de recuperación para snapshots/componentes existentes; no forma parte del catálogo exportado. | No debe ser la única fuente de informes. |
| `storage.objects` (`product-images`) | Binarios de imágenes referidos por `products.image_path`. | Ruta tenant/producto. | Referencia `images[].path`; una copia binaria podrá añadirse al paquete de importación. | Una ruta puede faltar o ser inaccesible. |
| `product_venue_settings` | Estructura histórica transitoria del esquema consolidado, posteriormente eliminada. | Producto/local. | Si aún existe en una instalación, se guarda en `metadata.sourceOnly`. | Deriva de versión entre instalaciones. |

No existe una implementación de stock o inventario en el repositorio. La única preparación actual es la proyección pura `getSaleLineConsumption`; el diseño final mantiene UUID de producto/variante en componentes seleccionables y deja los modificadores sin referencia de stock.

### 2.2 Funciones SQL y RPC relevantes

| Función/RPC actual | Uso y escritura | Dependencias | Destino conceptual |
|---|---|---|---|
| `validate_product_venue`, `validate_ticket_line_product_venue` | Triggers de coherencia tenant/local en producto/línea. | `products`, `venues`, `ticket_lines`. | Reemplazar por FKs compuestas y triggers finales donde una restricción declarativa no alcance. |
| `validate_catalog_relation` | Rechaza relaciones cruzadas en colocaciones, opciones y asignaciones; impide menú en menú. | Tablas de migración 29. | Reemplazar con FKs compuestas y un trigger final específico para reglas entre tablas. |
| `calculate_tax_from_gross`, `resolve_effective_tax_rate`, `set_ticket_line_fiscal_snapshot` | Calcula y captura IVA histórico al insertar línea. | Local, producto, ticket line. | Conservar conceptualmente; escribir columnas fiscales normalizadas y snapshot JSONB. |
| `sync_sale_created` / `sync_sale_created_v2` | Sincroniza venta rápida offline; crea ticket, líneas, venta y pago. | `offline_event_log`, catálogo, caja, IVA/descuentos. | Sustituir por una única RPC transaccional con snapshots/componentes normalizados; no mantener versiones públicas. |
| `capture_ticket_line_catalog_snapshot` | Completa snapshots desde evento offline/comanda y, como último recurso, catálogo vivo. | `offline_event_log`, `order_lines`, productos/categorías/formatos. | Integrar la captura en la RPC de venta; eliminar fallback al catálogo vivo para ventas nuevas. |
| `capture_ticket_line_components` | Inserta componentes históricos tras crear una línea. | Evento offline o comanda; `ticket_line_components`. | Integrar en la misma transacción de creación de ticket. |
| `canonical_catalog_component_modifiers` | Filtra modificadores enviados por el cliente contra catálogo activo. | Grupos/asignaciones/modificadores. | Reemplazar por resolución canónica del modelo final; función privada con `search_path=''`. |
| `add_restaurant_order_line_with_mixer` | Añade línea con mixer histórico separado. | `products`, variantes, modifiers, `order_lines`. | Desaparecer; usar componentes normalizados. |
| `save_restaurant_order_lines`, `save_restaurant_order_lines_v3` | Guarda borrador, revisiones, componentes, snapshots y recalcula precio. | Comandas, selección y modificadores. | Reemplazar por `save_restaurant_order_lines` final, sin sufijo, que reciba refs finales y cantidades. |
| `close_order_and_create_sale`, `close_order_and_create_sale_v2`, `close_restaurant_order_checked`, `close_restaurant_order_checked_v2` | Cierra/cobra y crea ticket/líneas. | Comandas, caja, descuentos, IVA. | Consolidar sin sufijos y copiar siempre snapshots/componentes normalizados. |
| `configure_restaurant_order_equal_split`, `pay_restaurant_order_equal_part`, `pay_restaurant_order_items`, `move_restaurant_order_lines` | Divide/mueve/cobra fracciones y crea líneas históricas. | `order_lines`, `ticket_lines`, descuentos. | Conservar el flujo, adaptando la copia de snapshots/componentes sin consultar catálogo vivo. |

Las demás RPC de caja, sesión, acceso, mesas y movimientos no modelan catálogo, pero sus permisos y transacciones se deben mantener al sustituir las RPC de venta.

### 2.3 Tipos, servicios, hooks, componentes y pantallas

- `src/types/domain.ts`: `CatalogKind`, `CatalogProfile`, `ProductType`, `Category`, `CatalogTab`, `CatalogPlacement`, `ProductVariant`, `Product`, `SelectionGroup`, `VariantSelectionGroup`, `ModifierGroup`, `ProductModifierGroupAssignment`, `TicketLineComponent`, `SaleLineCatalogSnapshot`, `TicketLine`, `SaleCreatedPayload` e informes. Todavía expone todos los campos históricos.
- `src/types/supabase.ts`: filas equivalentes y relaciones PostgREST, incluidas las tablas de migración 29.
- `src/services/posService.ts`: `loadCatalogFromSupabase` lee simultáneamente tablas antiguas/aditivas; `buildSalePayload` crea snapshots; `syncEvent` elige RPC histórica según descuento.
- `src/features/catalog/services/catalogAccess.ts`: único fallback de pestañas/colocaciones desde formatos antiguos; filtra variantes activas y resuelve grupos/modificadores.
- `src/features/catalog/services/saleLineBuilder.ts`: valida selección, suma base + componentes + modificadores, serializa y proyecta consumo futuro; contiene control de ciclos de menú.
- `src/lib/catalog.ts` y `src/lib/mixers.ts`: compatibilidad por formato/nombre y mixer sintético histórico.
- `src/features/crm/catalog/services/catalogService.ts`: CRUD actual de categorías, formatos, productos, variantes, pestañas, colocaciones, selección y modificadores; todavía escribe booleanos/arrays históricos.
- `src/features/crm/catalog/forms/ProductForm.tsx` y `productFormModel.ts`: edición por formatos, booleanos de venta/mixer, destacado global, suplemento e IVA.
- `CategoriesPage.tsx`, `SaleFormatsPage.tsx`, `ProductsPage.tsx`, `CatalogOrganizationPage.tsx`, `ComplementsPage.tsx`: pantallas de organización actuales.
- `src/lib/catalogTransfer.ts`, `CatalogImportPage.tsx`, `catalogImportService.ts`, `revoImport.ts`: ZIP actual y CSV REVO. El ZIP omite pestañas, colocaciones, selección y asignaciones, conserva UUID como relaciones e importa por fusión; no sirve como backup definitivo.
- `src/components/pos/CatalogPanel.tsx` y `src/components/modals/ProductDialog.tsx`: colocación/fallback, selector de variantes, mixers, menús y modificadores.
- `src/features/quick-sale/hooks/useQuickSale.ts`, `useQuickSalePayment.ts`, `quick-sale/services/ticketLines.ts`: venta directa y creación del payload offline.
- `src/features/restaurant/hooks/useRestaurantController.ts`, `src/features/tables/service.ts`, `order-line-payload.ts`: borrador, venta en mesa y RPC de guardado/cobro.
- `src/features/crm/sales/services/salesReportsService.ts` y `salesReportModel.ts`: agregan por snapshots cuando existen y recurren a relaciones vivas para histórico incompleto.
- `src/features/local-printing/services/ticketPrintMapper.ts`, `restaurantPrintPayload.ts`: imprimen componentes/modificadores y mixer antiguo como último recurso.
- `src/lib/offlineStore.ts`, `useOfflineController.ts`, `rejectedSaleRecovery.ts`: caché y recuperación de payloads que contienen la representación histórica.
- Tests relevantes: `catalog-architecture.test.mjs`, `catalog-migration.test.mjs`, `mixers.test.mjs`, `tax.test.mjs`, `discount-integration.test.mjs`, `product-sales-stats.test.mjs`, `local-printing.test.mjs`, tests de mesas/divisiones y los tests nuevos de fase 1.

### 2.4 Flujos de usuario actuales

1. **Crear/editar producto:** CRM selecciona categoría y `kind`, formatos, precios/variantes, venta directa, mixer, destacado, suplemento, IVA e imagen. Crea producto y variantes en operaciones separadas; la edición mantiene arrays/booleanos históricos.
2. **Crear variantes:** una variante por formato seleccionado; el cliente intenta emparejar formato y variante y marca una predeterminada. Borrar equivale hoy a desactivar.
3. **Destacado:** el formulario escribe `products.is_featured`; la organización puede escribir `catalog_placements.is_featured`. Ambos pueden divergir.
4. **Organizar TPV:** `CatalogOrganizationPage` crea pestañas y colocaciones; la colocación siempre elige categoría y puede fijar variante. Si no hay configuración válida, `catalogAccess` deriva pestañas/colocaciones antiguas.
5. **Mixers:** el flujo histórico usa `can_use_as_mixer` y suplemento global; el aditivo usa grupo `mixer`, opción contextual y asignación por variante.
6. **Menús:** producto `product_type=menu`; grupos `menu_component` asignados a variantes; la opción solo puede apuntar a estándar.
7. **Modificadores:** grupo creado con producto inicial, opciones hijas y asignaciones adicionales por producto/variante.
8. **Venta directa:** una colocación determina producto/variante; `ProductDialog` solicita variantes/grupos/modificadores; `buildSaleLine` calcula y `buildSalePayload` captura snapshot; la sincronización crea histórico.
9. **Venta en mesas:** el controlador mantiene borrador; `save_restaurant_order_lines_v3` canoniza y guarda componentes; las RPC de cobro/división generan tickets.
10. **Impresión:** el mapper usa nombres históricos, componentes y modificadores; si no hay componentes usa mixer antiguo.
11. **Informes:** leen tickets/líneas/componentes; el histórico incompleto puede depender de categoría viva, lo que debe desaparecer.
12. **Exportación/importación actual:** ZIP con categorías, formatos, productos, variantes, modificadores e imágenes. Importa por coincidencia ID/nombre y fusiona; no es reemplazo transaccional ni contiene el catálogo completo.

## 3. Esquema SQL definitivo propuesto (no aplicado)

Convenciones: UUID, `timestamptz`, céntimos enteros, nombres SQL en minúsculas, `created_at`, `updated_at`, `created_by`, `updated_by`; toda entidad de catálogo contiene `tenant_id` y `venue_id`. Cada padre declara `unique (id, tenant_id, venue_id)` y cada relación de catálogo usa FK compuesta, evitando referencias cruzadas sin depender del cliente. Todas las FKs se indexan. Los borrados del catálogo usan `cascade` para relaciones de configuración; tickets y snapshots no tienen FK al catálogo vivo.

```sql
create table public.categories (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
  venue_id uuid not null, name text not null check (length(trim(name)) between 1 and 100),
  icon text, sort_order integer not null default 0 check (sort_order >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  foreign key (tenant_id) references public.tenants(id) on delete cascade,
  foreign key (venue_id) references public.venues(id) on delete cascade,
  unique (id, tenant_id, venue_id)
);
create index categories_venue_order_idx on public.categories (tenant_id, venue_id, is_active, sort_order, id);

create table public.catalog_tabs (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, venue_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 80), icon text,
  sort_order integer not null default 0 check (sort_order >= 0), is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  foreign key (tenant_id) references public.tenants(id) on delete cascade,
  foreign key (venue_id) references public.venues(id) on delete cascade,
  unique (id, tenant_id, venue_id)
);
create index catalog_tabs_venue_order_idx on public.catalog_tabs (tenant_id, venue_id, is_active, sort_order, id);

create table public.catalog_tab_categories (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, venue_id uuid not null,
  tab_id uuid not null, category_id uuid not null,
  sort_order integer not null default 0 check (sort_order >= 0), is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  foreign key (tab_id, tenant_id, venue_id) references public.catalog_tabs(id, tenant_id, venue_id) on delete cascade,
  foreign key (category_id, tenant_id, venue_id) references public.categories(id, tenant_id, venue_id) on delete cascade,
  unique (tenant_id, venue_id, tab_id, category_id), unique (id, tenant_id, venue_id)
);
create index catalog_tab_categories_tab_idx on public.catalog_tab_categories (tenant_id, venue_id, tab_id, is_active, sort_order);
create index catalog_tab_categories_category_idx on public.catalog_tab_categories (category_id);

create table public.products (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, venue_id uuid not null,
  product_type text not null check (product_type in ('standard','menu')),
  name text not null check (length(trim(name)) between 1 and 160), description text,
  image_path text, tax_rate numeric(5,2) check (tax_rate between 0 and 100),
  sort_order integer not null default 0 check (sort_order >= 0), is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  foreign key (tenant_id) references public.tenants(id) on delete cascade,
  foreign key (venue_id) references public.venues(id) on delete cascade,
  unique (id, tenant_id, venue_id)
);
create index products_venue_active_idx on public.products (tenant_id, venue_id, is_active, sort_order, id);

create table public.product_variants (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, venue_id uuid not null,
  product_id uuid not null, name text not null check (length(trim(name)) between 1 and 120),
  price_cents integer not null check (price_cents >= 0), sku text,
  is_default boolean not null default false, sort_order integer not null default 0 check (sort_order >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  foreign key (product_id, tenant_id, venue_id) references public.products(id, tenant_id, venue_id) on delete cascade,
  unique (id, tenant_id, venue_id)
);
create unique index product_variants_one_active_default_idx on public.product_variants(product_id) where is_active and is_default;
create index product_variants_product_order_idx on public.product_variants (tenant_id, venue_id, product_id, is_active, sort_order, id);

create table public.catalog_placements (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, venue_id uuid not null,
  product_id uuid not null, tab_id uuid not null, category_id uuid,
  fixed_variant_id uuid, is_featured boolean not null default false,
  sort_order integer not null default 0 check (sort_order >= 0), is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  foreign key (product_id, tenant_id, venue_id) references public.products(id, tenant_id, venue_id) on delete cascade,
  foreign key (tab_id, tenant_id, venue_id) references public.catalog_tabs(id, tenant_id, venue_id) on delete cascade,
  foreign key (category_id, tenant_id, venue_id) references public.categories(id, tenant_id, venue_id) on delete cascade,
  foreign key (fixed_variant_id, tenant_id, venue_id) references public.product_variants(id, tenant_id, venue_id) on delete cascade,
  unique nulls not distinct (tenant_id, venue_id, product_id, tab_id, category_id, fixed_variant_id),
  unique (id, tenant_id, venue_id)
);
create index catalog_placements_tab_order_idx on public.catalog_placements (tenant_id, venue_id, tab_id, category_id, is_active, sort_order);
create index catalog_placements_product_idx on public.catalog_placements (product_id);

create table public.selection_groups (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, venue_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 120),
  group_type text not null check (group_type in ('mixer','menu_component')),
  sort_order integer not null default 0 check (sort_order >= 0), is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  foreign key (tenant_id) references public.tenants(id) on delete cascade,
  foreign key (venue_id) references public.venues(id) on delete cascade,
  unique (id, tenant_id, venue_id)
);

create table public.selection_group_options (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, venue_id uuid not null,
  group_id uuid not null, product_id uuid not null, variant_id uuid,
  supplement_cents integer not null default 0 check (supplement_cents >= 0),
  default_quantity integer not null default 0 check (default_quantity >= 0),
  max_quantity integer check (max_quantity is null or max_quantity >= greatest(default_quantity, 1)),
  sort_order integer not null default 0 check (sort_order >= 0), is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  foreign key (group_id, tenant_id, venue_id) references public.selection_groups(id, tenant_id, venue_id) on delete cascade,
  foreign key (product_id, tenant_id, venue_id) references public.products(id, tenant_id, venue_id) on delete cascade,
  foreign key (variant_id, tenant_id, venue_id) references public.product_variants(id, tenant_id, venue_id) on delete cascade,
  unique nulls not distinct (group_id, product_id, variant_id), unique (id, tenant_id, venue_id)
);
create index selection_group_options_group_idx on public.selection_group_options (tenant_id, venue_id, group_id, is_active, sort_order);
create index selection_group_options_product_idx on public.selection_group_options (product_id);

create table public.product_selection_group_assignments (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, venue_id uuid not null,
  product_id uuid not null, group_id uuid not null, display_name text,
  min_selection integer not null default 0 check (min_selection >= 0),
  max_selection integer not null default 1 check (max_selection >= 1 and max_selection >= min_selection),
  applies_to_all_variants boolean not null default true,
  sort_order integer not null default 0 check (sort_order >= 0), is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  foreign key (product_id, tenant_id, venue_id) references public.products(id, tenant_id, venue_id) on delete cascade,
  foreign key (group_id, tenant_id, venue_id) references public.selection_groups(id, tenant_id, venue_id) on delete cascade,
  unique (tenant_id, venue_id, product_id, group_id), unique (id, tenant_id, venue_id)
);
create index product_selection_assignments_product_idx on public.product_selection_group_assignments (tenant_id, venue_id, product_id, is_active, sort_order);

create table public.product_selection_group_assignment_variants (
  tenant_id uuid not null, venue_id uuid not null, assignment_id uuid not null, variant_id uuid not null,
  created_at timestamptz not null default now(), created_by uuid,
  primary key (assignment_id, variant_id),
  foreign key (assignment_id, tenant_id, venue_id) references public.product_selection_group_assignments(id, tenant_id, venue_id) on delete cascade,
  foreign key (variant_id, tenant_id, venue_id) references public.product_variants(id, tenant_id, venue_id) on delete cascade
);
create index product_selection_assignment_variants_variant_idx on public.product_selection_group_assignment_variants (variant_id);
```

Los modificadores usan la misma separación grupo/asignación; el grupo no tiene propietario:

```sql
create table public.modifier_groups (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, venue_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 120),
  sort_order integer not null default 0 check (sort_order >= 0), is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  foreign key (tenant_id) references public.tenants(id) on delete cascade,
  foreign key (venue_id) references public.venues(id) on delete cascade,
  unique (id, tenant_id, venue_id)
);
create table public.modifiers (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, venue_id uuid not null,
  group_id uuid not null, name text not null, supplement_cents integer not null default 0 check (supplement_cents >= 0),
  is_default boolean not null default false, sort_order integer not null default 0 check (sort_order >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  foreign key (group_id, tenant_id, venue_id) references public.modifier_groups(id, tenant_id, venue_id) on delete cascade,
  unique (id, tenant_id, venue_id)
);
create index modifiers_group_idx on public.modifiers (tenant_id, venue_id, group_id, is_active, sort_order);
create table public.product_modifier_group_assignments (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, venue_id uuid not null,
  product_id uuid not null, group_id uuid not null, display_name text,
  min_selection integer not null default 0 check (min_selection >= 0),
  max_selection integer not null default 1 check (max_selection >= 1 and max_selection >= min_selection),
  applies_to_all_variants boolean not null default true,
  sort_order integer not null default 0 check (sort_order >= 0), is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid,
  foreign key (product_id, tenant_id, venue_id) references public.products(id, tenant_id, venue_id) on delete cascade,
  foreign key (group_id, tenant_id, venue_id) references public.modifier_groups(id, tenant_id, venue_id) on delete cascade,
  unique (tenant_id, venue_id, product_id, group_id), unique (id, tenant_id, venue_id)
);
create index product_modifier_assignments_product_idx on public.product_modifier_group_assignments (tenant_id, venue_id, product_id, is_active, sort_order);
create table public.product_modifier_group_assignment_variants (
  tenant_id uuid not null, venue_id uuid not null, assignment_id uuid not null, variant_id uuid not null,
  created_at timestamptz not null default now(), created_by uuid,
  primary key (assignment_id, variant_id),
  foreign key (assignment_id, tenant_id, venue_id) references public.product_modifier_group_assignments(id, tenant_id, venue_id) on delete cascade,
  foreign key (variant_id, tenant_id, venue_id) references public.product_variants(id, tenant_id, venue_id) on delete cascade
);
create index product_modifier_assignment_variants_variant_idx on public.product_modifier_group_assignment_variants (variant_id);
```

Histórico normalizado. Los UUID de catálogo son valores históricos, deliberadamente sin FK:

```sql
create table public.tickets (
  id uuid primary key, tenant_id uuid not null, venue_id uuid not null,
  cash_session_id uuid not null, device_id uuid not null, user_id uuid not null,
  status text not null check (status in ('paid','void')),
  subtotal_cents integer not null check (subtotal_cents >= 0),
  discount_cents integer not null default 0 check (discount_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  local_created_at timestamptz not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key (tenant_id) references public.tenants(id) on delete restrict,
  foreign key (venue_id) references public.venues(id) on delete restrict,
  unique (id, tenant_id, venue_id)
);
create index tickets_reports_idx on public.tickets (tenant_id, venue_id, local_created_at, status);

create table public.ticket_lines (
  id uuid primary key, tenant_id uuid not null, venue_id uuid not null, ticket_id uuid not null,
  product_uuid uuid, variant_uuid uuid, product_name text not null, variant_name text not null,
  category_uuid uuid, category_name text, catalog_tab_uuid uuid, catalog_tab_name text,
  quantity numeric(18,3) not null check (quantity > 0),
  base_price_cents integer not null check (base_price_cents >= 0),
  component_supplement_cents integer not null default 0 check (component_supplement_cents >= 0),
  modifier_supplement_cents integer not null default 0 check (modifier_supplement_cents >= 0),
  unit_price_cents integer not null check (unit_price_cents >= 0), discount_cents integer not null default 0,
  tax_rate numeric(5,2) not null check (tax_rate between 0 and 100),
  taxable_base_cents integer not null, tax_cents integer not null, line_total_cents integer not null,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'), created_at timestamptz not null default now(),
  foreign key (ticket_id, tenant_id, venue_id) references public.tickets(id, tenant_id, venue_id) on delete cascade
);
create index ticket_lines_ticket_idx on public.ticket_lines (tenant_id, venue_id, ticket_id);
create index ticket_lines_product_report_idx on public.ticket_lines (tenant_id, venue_id, product_uuid, created_at);
create index ticket_lines_category_report_idx on public.ticket_lines (tenant_id, venue_id, category_uuid, created_at);
create index ticket_lines_tab_report_idx on public.ticket_lines (tenant_id, venue_id, catalog_tab_uuid, created_at);

create table public.ticket_line_components (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, venue_id uuid not null,
  ticket_line_id uuid not null,
  component_type text not null check (component_type in ('mixer','menu_component','modifier')),
  group_uuid uuid, group_name text, option_uuid uuid,
  product_uuid uuid, variant_uuid uuid, product_name text, variant_name text,
  modifier_uuid uuid, modifier_name text,
  quantity numeric(18,3) not null check (quantity > 0),
  unit_supplement_cents integer not null default 0 check (unit_supplement_cents >= 0),
  total_supplement_cents integer not null default 0 check (total_supplement_cents >= 0),
  sort_order integer not null default 0, snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (ticket_line_id, tenant_id, venue_id) references public.ticket_lines(id, tenant_id, venue_id) on delete cascade,
  check ((component_type = 'modifier' and modifier_name is not null and product_uuid is null)
      or (component_type <> 'modifier' and product_uuid is not null and product_name is not null))
);
create index ticket_line_components_line_idx on public.ticket_line_components (tenant_id, venue_id, ticket_line_id, sort_order);
create index ticket_line_components_product_report_idx on public.ticket_line_components (tenant_id, venue_id, component_type, product_uuid, created_at);
create index ticket_line_components_modifier_report_idx on public.ticket_line_components (tenant_id, venue_id, modifier_uuid, created_at) where component_type = 'modifier';
```

Reglas que requieren triggers diferibles/transaccionales:

- `product_variants_one_active_default_idx` garantiza como máximo una predeterminada activa. Un constraint trigger diferible `ensure_product_has_active_default_variant` garantiza al confirmar la transacción que cada producto tenga al menos una variante activa predeterminada. Alta y borrado físico se ejecutan mediante una transacción/RPC.
- `validate_catalog_placement_variant` comprueba que `fixed_variant_id.product_id = product_id`; la FK compuesta ya impide otro local.
- `validate_assignment_variant_product` comprueba que cada variante afectada pertenezca al producto de la asignación y que `applies_to_all_variants=false` tenga al menos una fila hija.
- `validate_selection_group_option` comprueba pertenencia de variante al producto e impide que una opción de un grupo `menu_component` apunte a `products.product_type='menu'`.
- `validate_assignment_capacity` exige capacidad activa suficiente para `min_selection`; mínimos/máximos cuentan unidades totales.
- Productos sin colocación son válidos por diseño; no existe trigger que exija colocación.

RLS definitiva: habilitar RLS en todas las tablas. Lectura de catálogo para `authenticated` con `user_is_tenant_admin(tenant_id) OR user_has_venue_access(tenant_id, venue_id)`; escritura solo para administradores del tenant y con el mismo `with check`. Tickets/líneas/componentes usan acceso al local/dispositivo y administración. Las funciones auxiliares complejas son `security definer`, `set search_path=''`, no accesibles a `anon`, y sus parámetros se validan contra tenant/local. Las columnas de políticas y todas las FKs quedan indexadas.

## 4. Formato JSON definitivo de exportación

Contrato implementado: `format = "club-pos-catalog-export"`, `schemaVersion = 1`. `metadata.origin.*.trace` conserva IDs originales; todo lo demás relaciona entidades con referencias como `product_0001`. El archivo no usa nombres públicos de transición.

```json
{
  "format": "club-pos-catalog-export",
  "schemaVersion": 1,
  "metadata": {
    "exportedAt": "2026-07-22T12:00:00.000Z",
    "exporter": "scripts/catalog-rebuild-phase-1",
    "readOnly": true,
    "origin": {
      "tenant": { "name": "Empresa", "slug": "empresa", "trace": { "originalId": "uuid" } },
      "venue": { "name": "Local", "address": null, "legalName": null, "taxId": null, "trace": { "originalId": "uuid", "tenantId": "uuid" } }
    },
    "fiscal": { "defaultTaxRate": 21, "currencyCode": "EUR", "timezone": "Europe/Madrid" },
    "sourceCatalogProfile": "bar_classic",
    "counts": {},
    "warnings": []
  },
  "catalog": {
    "categories": [{ "ref": "category_0001", "name": "Destilados", "icon": "wine", "sortOrder": 10, "isActive": true, "trace": {}, "source": { "kind": "alcohol", "currentScope": "tenant" } }],
    "saleFormats": [{ "ref": "sale_format_0001", "key": "cubata", "label": "Cubata", "sortOrder": 10, "isActive": true, "trace": {}, "source": {} }],
    "tabs": [{ "ref": "tab_0001", "key": "bebidas", "label": "Bebidas", "icon": "wine", "sortOrder": 10, "isActive": true, "trace": {} }],
    "tabCategories": [{ "ref": "tab_category_0001", "tabRef": "tab_0001", "categoryRef": "category_0001", "sortOrder": 10, "isActive": true, "source": {} }],
    "products": [{ "ref": "product_0001", "type": "standard", "name": "Ginebra", "description": null, "imageRef": "image_0001", "taxRate": null, "sortOrder": 10, "isActive": true, "trace": {}, "source": {} }],
    "variants": [{ "ref": "variant_0001", "productRef": "product_0001", "name": "Cubata", "priceCents": 800, "sku": null, "isDefault": true, "sortOrder": 10, "isActive": true, "trace": {}, "source": { "saleFormatRef": "sale_format_0001" } }],
    "placements": [{ "ref": "placement_0001", "productRef": "product_0001", "tabRef": "tab_0001", "categoryRef": "category_0001", "variantRef": "variant_0001", "featured": true, "sortOrder": 10, "isActive": true, "trace": {} }],
    "selectionGroups": [{ "ref": "selection_group_0001", "name": "Mixer estándar", "type": "mixer", "sortOrder": 10, "isActive": true, "trace": {}, "source": { "minSelection": 1, "maxSelection": 1 } }],
    "selectionGroupOptions": [{ "ref": "selection_option_0001", "groupRef": "selection_group_0001", "productRef": "product_0002", "variantRef": null, "supplementCents": 100, "defaultQuantity": 0, "maxQuantity": null, "sortOrder": 10, "isActive": true, "trace": {} }],
    "selectionAssignments": [{ "ref": "selection_assignment_0001", "productRef": "product_0001", "groupRef": "selection_group_0001", "variantRefs": ["variant_0001"], "minSelection": 1, "maxSelection": 1, "sortOrder": 10, "isActive": true, "displayName": null, "trace": {} }],
    "modifierGroups": [], "modifiers": [], "modifierAssignments": [],
    "images": [{ "ref": "image_0001", "productRef": "product_0001", "storageBucket": "product-images", "path": "tenant/products/x.webp", "embeddedData": null, "trace": {} }]
  }
}
```

Las imágenes se representan por ruta; un importador definitivo deberá descargar/verificar el binario y empaquetarlo. `metadata.counts` contiene el conteo de cada colección y `warnings` registra tablas ausentes e inconsistencias. El orden es determinista para un snapshot/fecha dados.

## 5. Mapa de conversión

| Dato actual | Destino final | Regla | Ambigüedad |
|---|---|---|---|
| `products.product_type` | `products.product_type` | Copia `standard/menu`. | Ninguna si cumple check. |
| Nombre/descripcion/imagen/IVA/estado/orden | `products` e `images` | Copia directa. | Imagen ausente/inaccesible se avisa. |
| `products.category_id` | colocaciones y categorías | Se conserva categoría; no queda categoría propietaria del producto. | Producto con distintas categorías solo puede conocerse por colocaciones. |
| `categories.kind` / `products.kind` | Ninguna columna funcional | Solo `source`; se infiere organización de relaciones explícitas. | Si no existen relaciones, requiere decisión. |
| `products.sale_formats` | variantes/colocaciones | Preferir `product_variants.sale_format_id`; después colocación existente. | Alias/posición no unívocos se marcan, no se inventan. |
| `can_sell_standalone` | Presencia de colocaciones | `false` sin colocación equivale a interno. | Si `false` y hay colocación, decide configuración explícita, no el booleano. |
| `is_featured` global | `catalog_placements.is_featured` | Usar destacados ya existentes; si solo existe global, decidir en qué colocaciones aplicarlo. | Sí, puede haber varias colocaciones. |
| `can_use_as_mixer` | opción de grupo mixer | Preferir opciones existentes. | Si no hay grupo, hay que elegir/crear grupo; el informe lo marca. |
| `mixer_supplement_cents` | `selection_group_options.supplement_cents` | Preferir suplemento contextual existente. | Un suplemento global no dice en qué grupos se aplica. |
| Formato/pestaña actual | `catalog_tabs`, variante fijada y colocación | Copia pestañas/colocaciones aditivas. | Formato histórico no es necesariamente una pestaña deseada. |
| `selection_groups.min/max` | asignación producto-grupo | Copia a todas las asignaciones derivadas. | Reutilización con reglas diferentes no era expresable. |
| `selection_group_items.is_default` | `default_quantity` | `true -> 1`, `false -> 0`. | Máximo por opción queda nulo. |
| `variant_selection_groups` | asignación + variantes hijas | Agrupa por producto/grupo. | Estado/nombre visible no existían. |
| `modifier_groups.product_id` | asignación al propietario | Si falta asignación aditiva, se crea una proyección de conversión `appliesToAllVariants`. | El concepto propietario desaparece. |
| `product_modifier_groups` | asignación + variantes hijas | Agrupa por producto/grupo; variante nula implica todas. | Reglas min/max hoy vienen del grupo. |
| `catalog_profile` | Solo metadata | No se importa como perfil funcional. | `custom` no elige plantilla. |
| Snapshots actuales | histórico final | Copiar columnas normalizadas; JSONB solo respaldo. | Categoría/pestaña de tickets antiguos puede ser aproximada. |

## 6. Exportador, validador e informe

Exportación (se recomienda service role en un entorno administrativo seguro):

```powershell
node scripts/catalog-rebuild-phase-1/export-catalog.mjs --venue "<venue_uuid>" --out ".\backups\catalog.json" --report ".\backups\catalog-conversion.md" --env-file ".env.local"
```

También acepta `--url` y `--key`, o `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` por entorno. No imprime la clave. La URL que termina en `/rest/v1` se normaliza. Si el archivo contiene errores, se escribe igualmente para preservar los datos y el comando termina con código 2. Error de conexión/lectura termina con código 1.

Validación independiente:

```powershell
node scripts/catalog-rebuild-phase-1/validate-catalog.mjs --file ".\backups\catalog.json" --report ".\backups\catalog-conversion.md"
```

Ejemplo:

```text
Exportado Bar sencillo
JSON: C:\...\backups\catalog.json
Informe: C:\...\backups\catalog-conversion.md
ERROR 0 | WARNING 0 | INFO 3
INFO INTERNAL_PRODUCT $.catalog.products.product_0003 - Producto sin colocaciones: se conservará como producto interno.
INFO SALE_FORMATS_ARE_SOURCE_ONLY $.catalog.saleFormats - Los formatos actuales se conservan para trazabilidad...
```

El validador cubre estructura/versionado, referencias rotas, productos sin variantes/predeterminada o con varias, variantes huérfanas, categorías/colocaciones inválidas, mixers sin producto, suplementos/precios/IVA, duplicados exactos, orden, estado activo contra destino inactivo, relaciones cruzadas, menú dentro de menú, límites/capacidad obligatoria, asignación de variante incorrecta y conceptos históricos sin destino inequívoco. Separa `ERROR`, `WARNING` e `INFO`; cualquier `ERROR` produce código 2.

El informe describe producto por producto variantes, colocaciones, grupos y ambigüedades. Nunca resuelve automáticamente una ambigüedad marcada.

## 7. Riesgos y decisiones pendientes

1. Confirmar si las categorías tenant-global no usadas por un local deben clonarse en cada exportación o solo las usadas. La herramienta las conserva todas para priorizar pérdida cero.
2. Decidir cómo repartir `products.is_featured=true` cuando hay varias colocaciones y ninguna marcada.
3. Resolver mixers históricos que no aparecen en un grupo y determinar en qué grupos debe aplicarse su suplemento global.
4. Revisar variantes cuyo `sale_format_id` falta o contradice `products.sale_formats`; no usar aliases en runtime.
5. Elegir `default_quantity`/`max_quantity` para grupos actuales con máximo mayor que uno; el booleano actual no basta.
6. Decidir si mínimos/máximos de modificadores deben poder variar por asignación. El esquema propuesto lo permite y copia inicialmente los del grupo.
7. Verificar en staging que todas las rutas de pago/división de mesas conservan componentes; las RPC históricas no ofrecen el mismo origen unívoco.
8. Definir política de descarga/empaquetado de imágenes y tratamiento de objetos ausentes.
9. Completar backfill histórico de pestaña/categoría solo donde haya evidencia; no inventar valores para informes.
10. La migración 29 ya existe en el repositorio: la fase siguiente debe reemplazarla/consolidarla de forma controlada, no ejecutar encima una segunda arquitectura sin plan de transición.

## 8. Pruebas y criterio para pasar a fase 2

Fixtures: bar sencillo, restaurante, múltiples variantes, mixer con suplemento, menú, producto interno y dataset inconsistente. Las pruebas ejecutan conversión/validación reales, comprueban referencias internas, estabilidad, aislamiento por local, informe y código de salida del CLI; no verifican mera presencia de texto.

Antes de fase 2 deben exportarse y validarse todos los locales reales, guardar JSON + informe + imágenes, resolver todos los `ERROR` y clasificar cada `WARNING`. Después se debe congelar el contrato JSON, escribir una migración final transaccional contra una copia de producción y un importador con dos modos exclusivamente: local vacío o reemplazo total. Solo entonces deben adaptarse servicios y UI y, al final, retirarse los campos/funciones de compatibilidad.
