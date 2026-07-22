# Reconstrucción del catálogo — Fase 3.3: auditoría previa del TPV

Fecha: 2026-07-22. Esta auditoría se realizó antes de modificar el runtime del TPV. La fase migra la aplicación de venta al dominio definitivo, pero no elimina tablas, columnas ni funciones PostgreSQL legacy.

## Punto de entrada y cadena de carga actual

```text
loadTenantState
  -> posService.loadCatalogFromSupabase
    -> catalog/data/load-current-catalog.loadCurrentCatalog
      -> CatalogRepository.getCatalog(venueId, 'pos')
      -> lecturas separadas de descuentos/configuración del local
      -> compatibility/project-current-ui.projectCatalogForCurrentUi
        -> Catalog legacy en AppShell y caché offline
```

`CatalogRepository` y `get_catalog(..., 'pos')` ya son definitivos. La incompatibilidad está después de esa lectura: `project-current-ui.ts` reconstruye `Product`, `ProductVariant`, `CatalogPlacement`, `SelectionGroup`, `ModifierGroup`, `SaleFormat` y `Catalog` históricos para que el TPV anterior continúe funcionando.

## Tipos históricos todavía conectados al TPV

| Tipo | Campos de compatibilidad usados | Consumidores runtime | Sustitución |
| --- | --- | --- | --- |
| `Catalog` | `saleFormats`, `usesLegacyFallback`, productos agregados, descuentos y configuración mezclados | `AppShell`, `PosPage`, caché offline, `CatalogPanel`, `ProductDialog`, `useQuickSale` | `CatalogData` en modo `pos`; descuentos y configuración se mantienen como estado POS separado |
| `Product` | `categoryId`, `saleFormats`, `canSellStandalone`, `canUseAsMixer`, `isFeatured`, variantes y grupos embebidos | panel, diálogo, venta rápida, mesas | `CatalogProduct` y `ResolvedCatalogItem`/`ResolvedSellableProduct` |
| `ProductVariant` | `saleFormatId`, `saleFormatKey`, flags históricos | diálogo, venta rápida, mesas y constructor de línea | `CatalogVariant` resuelta por ID, variante fijada o predeterminada |
| `Category` | `kind` e icono proyectado | panel de categorías y snapshot | `CatalogCategory` y relación `CatalogTabCategory` |
| `SaleFormat` / `SaleFormatDefinition` | formato como pestaña y selector indirecto de variante | panel, diálogo, edición de línea | pestaña real + selección directa de variante |
| `SelectionGroup` / `VariantSelectionGroup` | grupos y opciones embebidos por variante | diálogo y validación de líneas | `ResolvedCatalogSelectionGroup` obtenido por el resolvedor |
| `Modifier` / `ModifierGroup` | modificadores embebidos por producto/variante | diálogo y cálculo | `ResolvedCatalogModifierGroup` |
| `Mixer` | mixer histórico duplicado además del componente | diálogo, payload y render histórico | selección de tipo `mixer` como componente; los campos históricos quedan solo para lectura de tickets anteriores |

`TicketLine`, `TicketLineComponent`, `TicketLineModifier`, `SaleLineCatalogSnapshot` y los tipos de ticket/comanda son snapshots transaccionales, no catálogo vivo. Deben conservarse para renderizar histórico, ampliando la captura de líneas nuevas sin reconsultar productos.

## Mapa de UI y flujos

| Área | Archivos | Dependencia actual | Sustitución prevista |
| --- | --- | --- | --- |
| Tabs, categorías, featured, búsqueda y tarjetas | `components/pos/CatalogPanel.tsx` | `Catalog`, `getCatalogTabs`, `getCatalogPlacements`, helpers de formatos y productos agregados | `resolveSellableCatalog(CatalogData)`; la tarjeta recibe un `ResolvedCatalogItem`, respeta placement/tab/categoría/featured y busca sobre producto+variante |
| Selección de variantes | `CatalogPanel.tsx`, `ProductDialog.tsx`, `useQuickSale.ts`, `PosPage.tsx` | `SaleFormat` y `getProductVariantForSaleFormat` | variantes activas del producto y `resolveSellableProduct` por `variantId` |
| Modal de producto, mixers, menús y modifiers | `components/modals/ProductDialog.tsx` | grupos proyectados dentro de `Product` | grupos/opciones/modificadores resueltos para la variante; mixer como selección normal de tipo `mixer` |
| Venta directa, repetición y edición de cantidades | `features/quick-sale/hooks/useQuickSale.ts`, `features/quick-sale/services/ticketLines.ts` | `Product`/`ProductVariant` y constructor legacy | una única entrada definitiva del servicio de líneas y firma basada en snapshots seleccionados |
| Mesas, comandas y edición de líneas | `features/restaurant/hooks/useRestaurantController.ts`, `app/PosPage.tsx` | validación/cálculo local paralelo con tipos proyectados | el mismo constructor definitivo que venta directa; `save_catalog_order_lines` sigue canonizando en servidor |
| División y cobro de comandas | `features/tables/*`, `features/restaurant/*` | snapshots de líneas ya guardadas | sin lectura de catálogo vivo; conservar importes y snapshots existentes |
| Impresión | `features/local-printing/*`, `features/restaurant/services/restaurantPrintPayload.ts` | payload inmutable; fallback de mixer histórico | continuar renderizando snapshots; no calcular precios de venta nuevos |
| Tickets y recuperación | `services/posService.ts`, `features/cash-registers/*`, `features/offline/*`, `lib/offlineStore.ts` | columnas snapshot y evento offline | conservar lectura histórica; cachear `CatalogData` definitivo por tenant+local |
| Realtime | `features/restaurant/hooks/useRestaurantRealtime.ts`, `features/tables/service.ts` | cambios de comandas, no catálogo | sin cambios de arquitectura; las líneas recibidas siguen siendo snapshots |

## Cálculo de precios detectado

- `domain/pricing.ts` delega actualmente en `saleLineBuilder.ts`, mientras `saleLineBuilder-base.ts` suma base, componentes y modifiers. La dirección crea dos APIs de cálculo.
- `useRestaurantController` llama directamente a `calculateSaleLineTotals`; venta rápida llama a `buildSaleLine`.
- `PosPage` y `restaurantPrintPayload.ts` reconstruyen desgloses de líneas ya persistidas para presentación. Esos cálculos no deciden el precio de una venta nueva y deben seguir usando snapshots.
- Descuentos y fiscalidad se aplican después sobre enteros en céntimos; no se han detectado floats de catálogo en el flujo de venta.

La sustitución invierte la dependencia: `calculateCatalogPrice` será la única función monetaria para líneas nuevas, y el constructor definitivo la consumirá tanto para venta directa como para mesas.

## Escrituras, lecturas directas y formato anterior

- Ningún componente React consulta Supabase directamente.
- La única lectura de catálogo del TPV es `CatalogRepository.getCatalog(venueId, 'pos')`; la carga temporal añade descuentos y configuración del local mediante servicios.
- `save_catalog_order_lines` ya valida producto, variante, asignaciones, modifiers y componentes contra el catálogo definitivo en servidor.
- Las ventas rápidas persisten el payload snapshot en el evento offline y las RPC existentes capturan líneas/componentes históricos.
- `lib/catalog.ts`, `catalog/services/catalogAccess.ts` y `saleLineBuilder-base.ts` concentran la dependencia runtime del formato de venta anterior.
- `splitLegacyMixerModifiers` y los fallbacks de impresión se usan solo para leer comandas/tickets creados antes de la separación de mixers. No deben participar en líneas nuevas.

## Plan de sustitución

1. Convertir la carga en una entrada POS definitiva que devuelva `CatalogData` y estado de descuentos/configuración por separado, sin proyección ni fallback.
2. Cachear `CatalogData` por tenant y local; invalidar cualquier caché con forma legacy mediante una nueva clave de almacenamiento.
3. Reescribir panel y diálogo para consumir `ResolvedCatalogItem`, `CatalogVariant`, grupos y modifiers resueltos.
4. Sustituir el selector de `SaleFormat` por selección directa de variante conservando la interacción visual actual.
5. Rehacer el constructor de líneas sobre `ResolvedSellableProduct`, canonizar selecciones y crear un snapshot completo de producto, variante, placement, tab, categoría, IVA, componentes y modifiers.
6. Hacer que venta directa y mesas invoquen exactamente el mismo constructor; mantener las RPC definitivas y el histórico inmutable.
7. Eliminar `project-current-ui.ts`, `load-current-catalog.ts`, `catalogAccess.ts` y `saleLineBuilder-base.ts` cuando no tengan consumidores runtime.
8. Añadir pruebas de arquitectura que prohíban la proyección, los formatos legacy y cualquier lectura/escritura de catálogo anterior desde el TPV.

## Límite y rollback

La retirada es solo de código. No se ejecutará SQL destructivo ni se modificarán tablas legacy en esta fase. El rollback operativo consiste en desplegar el commit anterior mientras las estructuras PostgreSQL siguen presentes. La limpieza final se documentará con precondiciones y consultas de verificación, en un documento separado, y requerirá una fase expresamente autorizada.
