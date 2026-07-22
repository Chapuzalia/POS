# Auditoría previa — reconstrucción del catálogo, Fase 3.2

## Alcance revisado

El CRM no usa rutas URL independientes para cada pantalla: `CrmPage` mantiene la sección activa y `CrmSectionContent` monta las vistas. El menú de catálogo actual contiene `products`, `categories`, `organization`, `complements` y `sale-formats`; la importación está en la sección global `import`.

## Pantallas y dependencias actuales

| Área actual | Archivo | Dependencia que se sustituye | Tratamiento visual |
| --- | --- | --- | --- |
| Productos | `pages/ProductsPage.tsx` y `forms/ProductForm.tsx` | Tipos proyectados `Product`, formatos de venta, categorías por producto y `catalogService` | Se conserva tabla, buscador, panel/modal y controles actuales; se amplían filtros, resumen e impacto |
| Categorías | `pages/CategoriesPage.tsx` y `forms/CategoryForm.tsx` | Categoría legacy y conteo mediante `product.categoryId` | Se conserva lista administrativa; se unifica con tabs y relaciones tab–categoría |
| Organización TPV | `pages/CatalogOrganizationPage.tsx` | Proyección de tabs/placements y escrituras directas | Se integra en “Categorías y pestañas” y en el editor de producto como “Apariciones en TPV” |
| Complementos | `pages/ComplementsPage.tsx` | Selection Groups transitorios y modifiers proyectados | Se sustituye por gestión reutilizable de grupos, opciones, asignaciones y modificadores definitivos |
| Formatos | `pages/SaleFormatsPage.tsx` | Tabla `sale_formats` y columnas legacy de producto | Se elimina del CRM: las variantes definitivas expresan nombre, precio y SKU |
| Importar/exportar | `pages/CatalogImportPage.tsx` y `catalogImportService.ts` | Lecturas y escrituras directas, formatos legacy y merge no transaccional | Se mantiene la ruta, pero se adapta al contrato definitivo y a comandos del repositorio |

## Acceso a datos detectado

- `catalogService.ts` usa directamente Storage y las tablas `categories`, `sale_formats`, `products`, `product_variants`, `catalog_tabs`, `catalog_placements`, `selection_groups`, `selection_group_items`, `variant_selection_groups`, `modifier_groups`, `modifiers` y `product_modifier_groups`.
- `catalogImportService.ts` consulta y escribe directamente categorías, formatos, productos, variantes, modifiers e imágenes.
- Los componentes no llaman Supabase directamente, pero consumen estos servicios y reciben desde `CrmPage` el catálogo proyectado por el adaptador temporal.
- `ProductForm` mezcla validación de formulario, reglas legacy de formatos/mixers y persistencia por pasos.
- `CatalogOrganizationPage` y `ComplementsPage` mantienen estado local de relaciones crudas y ejecutan varias operaciones no atómicas.

## Sustitución

- Las pantallas de catálogo cargarán `CatalogData` en modo `admin` mediante `CatalogRepository` y un hook de CRM aislado por local.
- Todas las mutaciones pasarán por `CatalogCommandService`; ningún componente importará Supabase.
- Las categorías serán globales al local y se asociarán a pestañas mediante `CatalogTabCategory`.
- “Formato de venta” desaparece de la gestión: la UX usa “Variante”.
- “Colocación/placement” se mostrará como “Aparición en TPV”.
- Los productos internos se representarán como productos sin apariciones activas.
- Los menús usarán los mismos Selection Groups de tipo `menu_component`.
- Los modifiers se conservan como dominio separado porque el esquema final mantiene `modifier_groups`, `modifiers` y asignaciones propias.

## Backend adicional estrictamente necesario

Los comandos 3.1 no incluyen asociación/desasociación tab–categoría ni alta/reemplazo/baja de metadatos de imagen. Se añadirá una migración incremental que extienda el comando definitivo `catalog_command`; no se crearán tablas ni una arquitectura paralela.

## Elementos que se conservan para la Fase 3.3

- El adaptador `catalog/compatibility/project-current-ui.ts`, usado solamente por el TPV temporal.
- Los tipos históricos/TPV de `src/types/domain.ts` y `src/types/supabase.ts`.
- Los servicios de construcción de líneas y vistas TPV que aún consumen la proyección.
- Las tablas y columnas legacy necesarias para ejecutar el TPV anterior durante la transición.

## Internacionalización

Estas pantallas no tienen infraestructura i18n: todo el CRM actual contiene texto español literal. La Fase 3.2 mantiene ese patrón y normaliza la terminología española sin introducir un segundo sistema de traducciones parcial.
