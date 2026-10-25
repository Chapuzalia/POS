# Revisión funcional de tests — 25/10/2026

Este documento registra la primera pasada. La [segunda poda](test-suite-pruning-round-2-2026-10-25.md) y la [selección crítica vigente](test-suite-critical-2026-10-26.md) documentan las siguientes reducciones; la suite actual tiene **299 casos en total, todos pasando**.

Se revisaron los 143 archivos JavaScript de la suite inicial y el archivo Python de despliegue. El inventario por declaración contiene 1080 casos; los bucles/subtests generan más casos en ejecución. Se retiraron 155 declaraciones estáticas, se conservaron los escenarios ejecutables de los archivos mixtos y se eliminaron también aserciones incidentales de copy y presentación. No se cambió AGENTS.md.

## Criterio aplicado

- Retirar búsquedas de fragmentos de código/SQL, JSX, clases, títulos y prompts inspeccionados con toString como supuesta evidencia funcional. También se retiró la exigencia de un único archivo SQL raíz.
- Conservar importes, snapshots, parsing/OCR, contratos de protocolo y persistencia, permisos ejecutados, SQL en PGlite, estado e interacciones. Leer un módulo para ejecutarlo en un harness no es una comprobación estática.
- Conservar las pruebas que ejecutan analizadores de migraciones y herramientas de empaquetado/despliegue: sus entradas y salidas son texto por definición. También los contratos de manifiestos PWA, sin fijar su título.
- No eliminar texto que es dato de negocio: QR/XML fiscal, identidad de un producto o pase, importes de un recibo, estados de protocolo y errores usados para identificar condiciones. Las selecciones por etiqueta dentro de escenarios de interacción permanecen; no son aserciones que congelen el copy.

## Cashlogy

La nueva suite Vitest ejecuta el store Zustand, cliente HTTP, polling, errores y almacenamiento de intenciones reales. Simula fetch, localStorage y las fronteras externas de persistencia durable y telemetría. Los relojes son simulados; no necesita impresora ni Cashlogy físicos.

Cubre cobro y cambio, estados intermedios/terminales, 401/403/422 y 5xx, pérdida de conexión, JSON inválido/vacío, tipos e importes incoherentes, identidad/requestId/venta/terminal incompatibles, modo test, timeout de inicio/consulta/cancelación/health, respuesta lenta/tardía, recarga y 404, conflictos, concurrencia, cancelación externa y cambios de tenant/local/terminal.

Los primeros 48 casos reprodujeron 25 fallos antes de las correcciones. Se validan las respuestas de transacciones, los céntimos, la conciliación de efectivo aceptado/cambio cuando el agente ofrece el desglose completo y la identidad esperada; los errores 5xx y respuestas inválidas quedan inciertos y se consulta el requestId original sin reenviar el POST. La comprobación de disponibilidad exige booleanos reales. Se conserva la compatibilidad con saleId remoto ausente y con importes de desglose no disponibles.

La revisión independiente detectó una regresión al recuperar un bloqueo cuyo primer GET se había perdido: el placeholder aún conserva la identidad de la venta nueva. Se reprodujo con tres escenarios fallidos y se corrigió adoptando la identidad del bloqueo antes de recuperarlo, cancelarlo o reintentarlo. La revisión posterior confirmó la corrección.

## Límites y huecos visibles

Retirar una regex de RLS o atomicidad no demuestra que la garantía exista ni la reemplaza con cobertura nueva. Fuera de Cashlogy esta tarea conserva las pruebas ejecutables existentes, sin reconstruir todos los escenarios que antes solo inspeccionaban código. Permanecen como áreas a ampliar las antiguas comprobaciones estáticas de login/leases, provisión de usuarios/dispositivos, sesiones entre terminales, mesas virtuales, inventario, reservas, producción y facturas. No se ha modificado ninguna política, migración ni entorno de producción.

Las pruebas nuevas no acreditan el agente externo desplegado, la máquina física ni un flujo E2E completo de navegador.

## Inventario por archivo

Los recuentos son declaraciones test/t.test, no casos parametrizados. «Retirados» solo cuenta casos completos; en varios archivos se quitaron aserciones estáticas o de copy sin reducir casos.

| Archivo inicial | Declaraciones iniciales | Retirados | Estado |
|---|---:|---:|---|
| accepted-sales-payment-recovery.test.mjs | 11 | 0 | Conservado |
| accepted-sales-sql.test.mjs | 7 | 0 | Conservado |
| accepted-sales-storage.test.mjs | 9 | 0 | Conservado |
| accounting-closure-ticket-codes.test.mjs | 5 | 0 | Conservado |
| app-modal-interactions.test.mjs | 7 | 0 | Conservado |
| app-routes.test.mjs | 3 | 1 | Conserva funcionalidad; depurado |
| browser-crypto.test.mjs | 4 | 0 | Conservado |
| cash-closing-printing.test.mjs | 12 | 1 | Conserva funcionalidad; depurado |
| cash-ledger-annulment.test.mjs | 3 | 0 | Conservado |
| cash-movements.test.mjs | 12 | 7 | Conserva funcionalidad; depurado |
| cash-payment.test.mjs | 4 | 0 | Conservado |
| cash-ticket-annulment.test.mjs | 5 | 0 | Conservado |
| cashlogy-background-recovery.test.mjs | 28 | 1 | Conserva funcionalidad; depurado |
| cashlogy-cash-session-balance.test.mjs | 5 | 3 | Conserva funcionalidad; depurado |
| cashlogy-management-pin.test.mjs | 3 | 2 | Conserva funcionalidad; depurado |
| cashlogy-recovered-quick-sale.test.mjs | 9 | 0 | Conservado |
| cashlogy.test.mjs | 20 | 3 | Conserva funcionalidad; depurado |
| catalog-domain-phase-3-1.test.mjs | 15 | 0 | Conservado |
| catalog-menu-draft-migration.test.mjs | 1 | 0 | Conservado |
| catalog-pos-phase-3-3.test.mjs | 1 | 0 | Conservado |
| commercial-addons-migration.test.mjs | 1 | 0 | Conservado |
| consolidated-database.test.mjs | 2 | 2 | Eliminado: solo estructura/código |
| copy-vps-supabase-to-staging.test.mjs | 11 | 0 | Conservado |
| crm-access-scope.test.mjs | 5 | 0 | Conservado |
| crm-sales-report-loading.test.mjs | 10 | 0 | Conservado |
| crm-sales-report-query-optimization.test.mjs | 4 | 0 | Conserva funcionalidad; sin regex de fuente |
| crm-sales-report-suggestions.test.mjs | 2 | 0 | Conserva funcionalidad; sin regex de fuente |
| crm-stats-period-performance.test.mjs | 5 | 0 | Conservado |
| customer-invoices.test.mjs | 19 | 9 | Conserva funcionalidad; depurado |
| deploy-coolify.test.mjs | 9 | 0 | Conservado |
| device-user-provisioning.test.mjs | 8 | 8 | Eliminado: solo estructura/código |
| discount-promotions.test.mjs | 18 | 4 | Conserva funcionalidad; depurado |
| edge-deployment.test.mjs | 7 | 1 | Conserva funcionalidad; depurado |
| equal-split-single-ticket.test.mjs | 12 | 0 | Conserva funcionalidad; sin regex de fuente |
| fiscal-bridge-eligibility.test.mjs | 1 | 0 | Conservado |
| fiscal-bridge-revocation-sql.test.mjs | 2 | 0 | Conservado |
| fiscal-device-gate.test.mjs | 8 | 0 | Conservado |
| fiscal-head-preparation.test.mjs | 3 | 0 | Conservado |
| fiscal-historical-migration.test.mjs | 12 | 0 | Conservado |
| fiscal-installation-revocation.test.mjs | 2 | 0 | Conservado |
| fiscal-offline-bridge-sync.test.mjs | 9 | 0 | Conservado |
| fiscal-offline-preparation.test.mjs | 8 | 0 | Conservado |
| fiscal-refund-bridge.test.mjs | 8 | 0 | Conservado |
| fiscal-settings-recovery.test.mjs | 5 | 0 | Conservado |
| fiscal-ticket-qr-settings.test.mjs | 4 | 0 | Conservado |
| hold-button.test.mjs | 8 | 0 | Conservado |
| inventory-management.test.mjs | 15 | 12 | Conserva funcionalidad; depurado |
| inventory-recipes-v2.test.mjs | 9 | 2 | Conserva funcionalidad; depurado |
| local-printing.test.mjs | 47 | 0 | Conserva funcionalidad; sin regex de fuente |
| local-session-ticket-history.test.mjs | 3 | 0 | Conservado |
| login-inactivity.test.mjs | 6 | 5 | Conserva funcionalidad; depurado |
| login-lease.test.mjs | 5 | 5 | Eliminado: solo estructura/código |
| migration-safety-exception.test.mjs | 6 | 0 | Conservado |
| migration-safety.test.mjs | 17 | 0 | Conservado |
| multi-device-cash-sessions.test.mjs | 3 | 3 | Eliminado: solo estructura/código |
| observability.test.mjs | 8 | 0 | Conservado |
| offline-sale-economics.test.mjs | 6 | 3 | Conserva funcionalidad; depurado |
| offline-session.test.mjs | 11 | 0 | Conservado |
| offline-sync-rejection.test.mjs | 3 | 0 | Conservado |
| operational-day-integration.test.mjs | 2 | 2 | Eliminado: solo estructura/código |
| operational-day.test.mjs | 7 | 1 | Conserva funcionalidad; depurado |
| payment-method-cash-session-lock.test.mjs | 7 | 0 | Conservado |
| pending-sync.test.mjs | 1 | 0 | Conservado |
| pos-invoice-installation-reuse.test.mjs | 7 | 0 | Conservado |
| pos-pending-payment-continuity.test.mjs | 4 | 0 | Conservado |
| pos-read-snapshots.test.mjs | 4 | 0 | Conservado |
| pos-sale-latency.test.mjs | 7 | 0 | Conservado |
| prepare-production-migrations.test.mjs | 4 | 0 | Conservado |
| print-agent-timeouts.test.mjs | 4 | 0 | Conservado |
| product-sales-stats-refresh.test.mjs | 4 | 0 | Conservado |
| production-columns.test.mjs | 3 | 0 | Conservado |
| production-domain.test.mjs | 7 | 7 | Eliminado: solo estructura/código |
| production-lifecycle-sql.test.mjs | 5 | 0 | Conservado |
| production-paid-orders.test.mjs | 4 | 0 | Conservado |
| production-passes.test.mjs | 8 | 7 | Conserva funcionalidad; depurado |
| production-routing-cache.test.mjs | 8 | 8 | Eliminado: solo estructura/código |
| production-workflow-sql.test.mjs | 2 | 0 | Conservado |
| production-workflow.test.mjs | 8 | 0 | Conservado |
| profitability-operational-day.test.mjs | 4 | 0 | Conserva funcionalidad; sin regex de fuente |
| profitability.test.mjs | 11 | 10 | Conserva funcionalidad; depurado |
| purchase-document-deletion.test.mjs | 14 | 0 | Conservado |
| purchase-management.test.mjs | 13 | 11 | Conserva funcionalidad; depurado |
| pwa-fiscal-installation.test.mjs | 12 | 0 | Conservado |
| pwa-navigation.test.mjs | 4 | 0 | Conservado |
| quick-sale-payment-isolation.test.mjs | 1 | 0 | Conservado |
| refactor-domain-policies.test.mjs | 5 | 0 | Conservado |
| refund-installation-series.test.mjs | 3 | 0 | Conservado |
| reservation-map-navigation.test.mjs | 3 | 0 | Conservado |
| reservations-domain.test.mjs | 6 | 0 | Conservado |
| reservations-integration.test.mjs | 6 | 5 | Conserva funcionalidad; depurado |
| restaurant-carryovers-sql.test.mjs | 12 | 0 | Conservado |
| restaurant-fiscal-bridge-sync.test.mjs | 4 | 0 | Conservado |
| restaurant-kitchen-comments.test.mjs | 10 | 0 | Conservado |
| restaurant-menu-batch-modifiers.test.mjs | 8 | 0 | Conservado |
| restaurant-menu-batch.test.mjs | 9 | 0 | Conservado |
| restaurant-menu-courses.test.mjs | 10 | 0 | Conservado |
| restaurant-menu-panel.test.mjs | 11 | 0 | Conservado |
| restaurant-pending-payment.test.mjs | 4 | 0 | Conservado |
| restaurant-realtime-sync.test.mjs | 8 | 0 | Conservado |
| restaurant-served-line-removal.test.mjs | 2 | 0 | Conservado |
| restore-venue-layout.test.mjs | 6 | 0 | Conservado |
| session-ticket-history-performance.test.mjs | 8 | 0 | Conservado |
| session-ticket-refund-controls.test.mjs | 3 | 0 | Conservado |
| session-ticket-refund-mapping.test.mjs | 4 | 0 | Conservado |
| split-orders.test.mjs | 7 | 6 | Conserva funcionalidad; depurado |
| staging-baseline.test.mjs | 3 | 0 | Conservado |
| staging-demo-history.test.mjs | 5 | 0 | Conservado |
| staging-demos.test.mjs | 6 | 0 | Conservado |
| stripe-billing-auth.test.mjs | 2 | 0 | Conservado |
| stripe-billing-domain.test.mjs | 16 | 0 | Conservado |
| stripe-billing-feature-refresh.test.mjs | 1 | 0 | Conservado |
| stripe-billing-promotions.test.mjs | 15 | 0 | Conservado |
| stripe-billing-recovery.test.mjs | 10 | 0 | Conservado |
| stripe-billing-service.test.mjs | 9 | 0 | Conservado |
| stripe-billing-sql.test.mjs | 9 | 0 | Conservado |
| supplier-document-financials.test.mjs | 11 | 0 | Conservado |
| supplier-document-products.test.mjs | 10 | 0 | Conservado |
| supplier-document-receipts.test.mjs | 70 | 15 | Conserva funcionalidad; depurado |
| supplier-document-storage-policies.test.mjs | 8 | 0 | Conservado |
| supplier-document-supplier-flow.test.mjs | 22 | 1 | Conserva funcionalidad; depurado |
| tax.test.mjs | 6 | 1 | Conserva funcionalidad; depurado |
| tenant-feature-gating.test.mjs | 4 | 3 | Conserva funcionalidad; depurado |
| tenant-feature-refresh.test.mjs | 4 | 0 | Conservado |
| theme-preferences.test.mjs | 3 | 0 | Conservado |
| ticket-catalog-snapshot-lookup.test.mjs | 6 | 0 | Conserva funcionalidad; sin regex de fuente |
| ticket-cost-snapshot-optimization.test.mjs | 4 | 0 | Conservado |
| tickit-api.test.mjs | 2 | 0 | Conservado |
| tickit-assist-lifecycle.test.mjs | 5 | 0 | Conservado |
| tickit-assist-offline.test.mjs | 2 | 0 | Conservado |
| tickit-assist-sql.test.mjs | 4 | 0 | Conservado |
| tickit-assist.test.mjs | 10 | 0 | Conservado |
| venue-restaurant-operations.test.mjs | 10 | 0 | Conservado |
| verifactu-activation.test.mjs | 5 | 0 | Conservado |
| verifactu-bridge-client.test.mjs | 10 | 0 | Conservado |
| verifactu-crm-settings.test.mjs | 2 | 0 | Conserva funcionalidad; sin regex de fuente |
| verifactu-hash.test.mjs | 4 | 0 | Conservado |
| verifactu-local-domain.test.mjs | 15 | 0 | Conservado |
| verifactu-local-installations.test.mjs | 3 | 0 | Conservado |
| verifactu-pos-routing.test.mjs | 1 | 0 | Conservado |
| verifactu-sale-rpc.test.mjs | 1 | 0 | Conservado |
| verifactu-schema.test.mjs | 1 | 0 | Conservado |
| verifactu-sif-setup.test.mjs | 5 | 0 | Conservado |
| virtual-tables.test.mjs | 6 | 6 | Eliminado: solo estructura/código |

`tests/test_deploy_pos.py`: conservado; ejecuta las herramientas con paquetes y procesos controlados.

## Verificación

- `pnpm test:functional`: 72/72 pasan, con relojes simulados y sin rechazos asíncronos no controlados.
- `pnpm test`: nueva suite y suite heredada ejecutadas. En la última ejecución global había 69 casos nuevos (los tres últimos casos de conciliación se ejecutaron después) y 1015 heredados: 1008 pasan y 7 fallan. Los siete fallos ya estaban en la ejecución inicial y corresponden a `tests/restaurant-menu-courses.test.mjs` con `FLEXIBLE_MENU_SELECTION_SIGNATURE_NOT_FOUND` durante la preparación SQL.
- Tras las últimas modificaciones se ejecutaron también 144 pruebas heredadas de Cashlogy, impresión, producción, latencia y navegación PWA: todas pasan.
- Casos afectados: elecciones diferidas y postre tardío; sustitución de un plato enviado; permisos/revisión al servir; menús idénticos y divisiones; comentarios de cocina; reapertura por un plato opcional tardío; cancelación de un plato dividido listo. Se conservan todos; no se han ocultado ni deshabilitado.
- La ejecución inicial heredada tenía 1170 casos: 1152 pasaron y 18 fallaron. Once fallos correspondían a restricciones del sandbox (Git temporal y puerto loopback); desaparecieron al ejecutar las mismas herramientas fuera de ese bloqueo. Los siete anteriores persistieron.
- `python -m unittest discover -s tests -p test_deploy_pos.py`: 19/19 pasan fuera de la restricción de carpetas temporales del sandbox.
- `pnpm lint`: sin errores. Permanecen dos advertencias anteriores de dependencias de hooks en `CrmPage.tsx` y `useRestaurantController.ts`.
- `pnpm build`: API, TypeScript y bundle completados, exit 0. La subida de sourcemaps a Sentry falló por resolución DNS; no se ha considerado subida verificada.
- Typecheck explícito de la nueva suite/configuración con `tsc --ignoreConfig --noEmit --target es2023 --moduleResolution bundler --module esnext --skipLibCheck --types vite/client,node --jsx react-jsx --allowImportingTsExtensions tests/functional/cashlogy-payment.test.ts vitest.config.ts`: correcto.

La comprobación AST del inventario confirma que solo faltan las 155 declaraciones elegidas para retirada; no se ha perdido ningún otro caso ejecutable.
