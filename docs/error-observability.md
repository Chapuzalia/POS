# Errores y observabilidad del POS

## Hallazgos

Sentry solo recibia explicitamente errores de render. El formateador comun mostraba mensajes, detalles, hints y codigos de Supabase. Habia fallos fiscales solo en consola, fallos de auditoria de caja silenciados y errores de hardware/sincronizacion sin contexto. La UI tambien mostraba mensajes tecnicos persistidos en historicos y codigos internos de Cashlogy.

## Criterios y puntos de captura

| Zona | Captura y contexto | Presentacion |
| --- | --- | --- |
| Venta rapida | Cobro y persistencia local; saleId, ticketId, cashSessionId; breadcrumb anterior a guardar | Sileo; recuperacion Cashlogy existente |
| Restaurante | Errores en comandas, cobros, divisiones, produccion y fiscalidad; identificador de comanda, caja y accion | Sileo; modales de pago, conflictos y recuperacion existentes |
| Cashlogy | Fallo de cobro, resultado incierto, reconciliacion, recuperacion, gestion de efectivo, registro de stacker y persistencia de intenciones | Modales y bloqueos existentes con mensajes locales |
| Impresion | Fallos finales despues de intentar recuperar el trabajo; requestId estable, breadcrumb de venta; auditoria del cierre | Sileo para avisos operativos; configuracion y estado incierto conservan su UI |
| Cola offline | Rechazos reales, errores de lectura/escritura local; event.id, saleId y tipo de evento | Estado pendiente y recuperacion existentes; texto almacenado amigable |
| Caja | Movimientos, retirada de stacker y cierre; cashSessionId, requestId y fase | Sileo y flujos de cierre existentes |
| Fiscal | Error original de invocacion, resultado rechazado/error y consulta previa a impresion; ticketId e invoiceId cuando existen | Mensajes locales, sin error del proveedor en el historico |
| Inventario | Registro de produccion y ajuste de stock; requestId o identificador del articulo | Mensajes amigables y validacion inline |
| Sesion y lease | Errores inesperados de autenticacion, carga y heartbeat; fase de la accion | Pantallas de login y bloqueo conservadas |
| Realtime | Breadcrumb al pasar a polling; errores de refresco no recuperables | Recuperacion periodica existente, sin toast por cada cambio de canal |
| CRM/catalogo | Fronteras de carga/accion y funciones remotas; mensaje tecnico separado y causa conservada en errores de catalogo | Sileo para error global; validaciones y decisiones inline |
| Render | AppErrorBoundary captura stack de React; inicializacion anterior al render | Pantalla de recuperacion sin afirmar que Sentry recibio el evento |

## Infraestructura pequena y reutilizable

- `UserFacingError` identifica textos locales revisados y validaciones esperadas. No se debe construir con mensajes arbitrarios del backend.
- `getReadableError` oculta errores desconocidos, captura el original con contexto y permite un mensaje local especifico. Las validaciones Zod no se serializan ni se notifican como incidentes.
- `reportOperationError` reutiliza Sentry, conserva el error original y limita duplicados por identidad/cadena causal y durante 60 segundos por operacion, identificadores, fase y firma. El mapa esta limitado a 500 entradas.
- Los breadcrumbs usan identificadores existentes: no se introduce otro identificador de venta ni se altera la idempotencia.
- `notifyOperationalError` reutiliza Sileo y evita repetir el mismo aviso consecutivo durante 30 segundos.
- La instrumentacion nunca debe propagar un fallo de telemetria al flujo operativo.

## Exclusiones deliberadas

No se capturan validaciones locales marcadas, validaciones Zod en formularios, credenciales incorrectas, cancelaciones de Cashlogy, dispositivo ocupado o no configurado, ni peticiones de impresion duplicadas. Un fallo de transporte en una frontera explicitamente recuperable (cola, sesion o refresco) se silencia. Estar offline NO silencia errores de almacenamiento ni cobros inciertos.

La sustitucion de realtime por polling deja un breadcrumb, no una excepcion. No se envian todas las respuestas de API ni todos los catch. Se mantienen los fallbacks de datos opcionales y las decisiones de usuario.

## Privacidad

El contexto operativo admite solo claves e identificadores concretos; no recibe tickets completos, clientes, tarjetas ni cuerpos de peticiones. Sentry elimina usuario, extras serializados, cuerpos, cookies y cabeceras sensibles, y sanea URLs y mensajes. Se filtran breadcrumbs de consola y clicks que podrian contener datos. Se conservan tipo de excepcion, stack, codigo y mensaje tecnico saneado, incluido el mensaje de objetos Supabase. Replay mantiene el enmascarado existente.

La captura real depende de VITE_SENTRY_ENABLED y VITE_SENTRY_DSN. Las pruebas verifican el mecanismo local; no envian incidentes reales ni ejecutan cobros contra hardware.

## Validacion

Se ejecutan test, build y lint mediante Corepack (pnpm no tiene shim en PATH). Se desactiva solo la verificacion automatica de dependencias de pnpm 11 para usar node_modules existente sin reinstalarlo.

Los tests comunes verifican ocultacion de SQL, Sileo, error original, contexto, exclusiones, offline recuperable frente a dinero incierto, deduplicacion, causas de hardware y hooks reales de sanitizacion Sentry. Se adaptan expectativas anteriores que exigian exponer detalles tecnicos y los runners aislados de sesion/realtime. La lectura SQL de purchase-management se normaliza para saltos de linea Windows.

Build genera el artefacto, pero la subida de sourcemaps no se pudo verificar porque el entorno no conecta con sentry.io. Lint conserva cuatro advertencias previas no-useless-escape en documentMetadata.ts.

## Archivos modificados por esta tarea

Se conservan los cambios de sesion/offline ya presentes en el directorio. Esta lista excluye archivos con cambios previos que esta tarea no edito.

- `src/app/PosPage.tsx`
- `src/components/crm/CrmPage.tsx`
- `src/components/errors/AppErrorBoundary.tsx`
- `src/components/modals/CashMovementModal.tsx`
- `src/components/modals/DiscountModal.tsx`
- `src/components/superadmin/SuperAdminPage.tsx`
- `src/features/cash-registers/hooks/useActiveCashSession.ts`
- `src/features/cash-registers/hooks/useCashSession.ts`
- `src/features/cash-registers/hooks/useCashTicketActions.ts`
- `src/features/cash-registers/service.ts`
- `src/features/catalog/domain/errors.ts`
- `src/features/crm/access/services/accessService.ts`
- `src/features/crm/catalog/pages/CatalogFormatsPage.tsx`
- `src/features/crm/catalog/pages/CatalogTransferPage.tsx`
- `src/features/crm/catalog/services/catalogAdminModel.ts`
- `src/features/crm/discounts/pages/DiscountsPage.tsx`
- `src/features/crm/discounts/services/discountService.ts`
- `src/features/crm/inventory/components/ProductInventoryEditor.tsx`
- `src/features/crm/inventory/inventoryModel.ts`
- `src/features/crm/inventory/pages/InventorySettingsPage.tsx`
- `src/features/crm/inventory/services/inventoryService.ts`
- `src/features/crm/layout/CrmShell.tsx`
- `src/features/crm/production/pages/ProductionPage.tsx`
- `src/features/crm/production/services/productionAdminService.ts`
- `src/features/crm/purchases/components/SupplierDocumentArchiveForm.tsx`
- `src/features/crm/purchases/pages/PurchasesInvoicesPage.tsx`
- `src/features/crm/purchases/pages/PurchasesOverviewPage.tsx`
- `src/features/crm/purchases/pages/PurchasesSuppliersPage.tsx`
- `src/features/crm/sales/components/RevoClosingImportModal.tsx`
- `src/features/crm/sales/pages/SalesReportsPage.tsx`
- `src/features/crm/sales/services/revoCashClosingService.ts`
- `src/features/crm/shared/services/crmServiceSupport.ts`
- `src/features/crm/supplier-documents/pages/SupplierReceiptsPage.tsx`
- `src/features/crm/supplier-documents/services/supplierDocumentService.ts`
- `src/features/customers/CustomerInvoiceModal.tsx`
- `src/features/customers/service.ts`
- `src/features/fiscal/service.ts`
- `src/features/inventory/InventoryPreparationsPanel.tsx`
- `src/features/inventory/preparationsService.ts`
- `src/features/local-printing/api/PrintAgentError.ts`
- `src/features/local-printing/cashlogy/cashlogyError.ts`
- `src/features/local-printing/cashlogy/cashlogyStorage.ts`
- `src/features/local-printing/cashlogy/useCashlogyManagementStore.ts`
- `src/features/local-printing/cashlogy/useCashlogyStore.ts`
- `src/features/local-printing/components/CashlogyConnectorList.tsx`
- `src/features/local-printing/components/CashlogyMachineModal.tsx`
- `src/features/local-printing/components/CashlogyOperationStatus.tsx`
- `src/features/local-printing/components/CashlogyPaymentModal.tsx`
- `src/features/local-printing/components/PrintErrorAlert.tsx`
- `src/features/local-printing/services/printCashClosing.ts`
- `src/features/local-printing/services/printTicket.ts`
- `src/features/local-printing/store/usePrintAgentStore.ts`
- `src/features/offline/hooks/useOfflineController.ts`
- `src/features/production/components/KdsPage.tsx`
- `src/features/production/service.ts`
- `src/features/quick-sale/hooks/useQuickSalePayment.ts`
- `src/features/reservations/hooks/useReservationsController.ts`
- `src/features/restaurant/hooks/useRestaurantController.ts`
- `src/features/restaurant/hooks/useRestaurantDraft.ts`
- `src/features/restaurant/hooks/useRestaurantRealtime.ts`
- `src/features/restaurant/services/validateCashClosure.ts`
- `src/features/session/hooks/useLoginActivity.ts`
- `src/features/session/hooks/useTenantSession.ts`
- `src/features/table-management/TableManagementPage.tsx`
- `src/features/tables/components/EqualSplitOrderModal.tsx`
- `src/features/tables/components/SplitOrderModal.tsx`
- `src/features/tables/components/TableMapView.tsx`
- `src/features/tables/layout-service.ts`
- `src/features/tables/service.ts`
- `src/hooks/useOfflineSync.ts`
- `src/lib/discounts.ts`
- `src/lib/observability.ts`
- `src/lib/observabilityPrivacy.ts`
- `src/lib/offlineStore.ts`
- `src/lib/productImages.ts`
- `src/main.tsx`
- `src/sentry.ts`
- `src/services/platformService.ts`
- `src/services/posService.ts`
- `src/utils/UserFacingError.ts`
- `src/utils/errors.ts`
- `src/utils/notifications.ts`
- `tests/bundle-splitting.test.mjs`
- `tests/device-user-provisioning.test.mjs`
- `tests/observability.test.mjs`
- `tests/offline-session.test.mjs`
- `tests/pos-error-lifecycle.test.mjs`
- `tests/purchase-management.test.mjs`
- `tests/restaurant-realtime-sync.test.mjs`
- `tests/revo-import.test.mjs`
- `tests/table-map.test.mjs`
