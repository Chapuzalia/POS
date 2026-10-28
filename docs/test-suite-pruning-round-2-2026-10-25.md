# Segunda poda de tests — 25/10/2026

Este documento registra un estado anterior. La [selección crítica vigente](test-suite-critical-2026-10-26.md) deja **299 casos en total, todos pasando**, conforme al tamaño de 200–300 acordado posteriormente.

Retirados **107 casos adicionales** en esta segunda pasada: **262 en total** respecto a la suite inicial. Se eliminaron 9 archivos adicionales completos. No se ha cambiado código de producto, dependencias, migraciones ni workflows durante esta pasada.

La comparación AST con las instantáneas previas confirma que no falta ningún caso fuera de la lista revisada. Se comprobaron consumidores reales de los helpers antes de retirar las pruebas de funciones sin uso.

## Criterio más exigente

| Motivo | Casos retirados |
|---|---:|
| Repite analyzeMigration sobre una migración; permanece el analizador central y la prueba de comportamiento SQL | 29 |
| Presentación literal o comprobación de constantes sin interacción | 9 |
| Redundante con un escenario conservado de la misma funcionalidad | 9 |
| Herramienta auxiliar de staging/despliegue; fuera del uso de la app | 44 |
| Empaquetado auxiliar; se conserva el router real y su autenticación | 2 |
| Helper sin consumidores en el uso de la app | 12 |
| Fixture mock o clase de proveedor, sin ejecutar procesamiento real de un documento | 2 |

Se retiraron además aserciones sueltas de colores, nombres de temas, constantes de estados y proveedores mock, y pruebas de la sugerencia automática de denominaciones que la app no utiliza. Se conserva el selector manual real y se comprueba que el polling de gestión de efectivo espere durante la selección y entrega del cambio.

## Cobertura operativa conservada

- Los 72 escenarios Vitest de Cashlogy; sus HTTP, validación de importes/identidad, timeout, recuperación, cancelación y protección frente a cobro duplicado. Las aserciones útiles de controles liberados tras 404 y cierre del modal tras cancelar se trasladaron al escenario conservado.
- Ventas, cierres, importes en céntimos, historial, devoluciones, fiscalidad, offline, permisos, tenant/local/dispositivo y los casos SQL que ejecutan el comportamiento real.
- Router Edge con verificaciones JWT y rutas privadas, analizador central de seguridad de migraciones y las 19 pruebas Python que el workflow usa para verificar el despliegue.
- Se ha conservado la regresión que evita que un refresco de la reserva A reemplace la reserva B seleccionada. La revisión independiente confirmó que el harness de integración sustituye ese helper y no cubre ese cambio de selección.

Las suites retiradas de staging, demos, empaquetado y orquestación de despliegue quedan fuera de esta suite centrada en el uso de la app. Sus scripts no se han modificado. Retirar tests de un helper de referencia no acredita el SQL equivalente; se mantiene la cobertura SQL existente, sin atribuirle garantías nuevas.

## Ejemplos de duplicación retirada

| Retirado | Escenario conservado |
|---|---|
| Snapshot de catálogo de catalog-pos-phase-3-3 | Snapshot histórico en catalog-domain-phase-3-1 y consultas reales en ticket-catalog-snapshot-lookup |
| Segundo cashback de 30 euros con fondo de 100 | Mismo escenario en cash-movements, incluyendo entradas de efectivo a cero |
| Diez sumas de una denominación | Combinación de monedas y billetes con addCashDenomination |
| Recuperación 404 y cancelación activa con transporte sustituido | Mismos flujos con cliente HTTP y store reales en Vitest |
| Compilar la función de rentabilidad sin invocarla | Test que ejecuta esa migración y consulta la RPC agrupando ventas reales |
| Fingerprint 7/8 | Umbral exacto 3/4 y rechazo por debajo del umbral |
| Cabecera vacía y duplicado literal IMPORT/IMPORTE | Normalización con vacíos/duplicados, parser completo y rechazo de alias compartido entre campos |

## Archivos afectados por retirada de casos

| Archivo de origen | Casos retirados |
|---|---:|
| accepted-sales-sql.test.mjs | 1 |
| cash-closing-printing.test.mjs | 3 |
| cash-movements.test.mjs | 1 |
| cash-payment.test.mjs | 2 |
| cashlogy-background-recovery.test.mjs | 2 |
| cashlogy.test.mjs | 3 |
| catalog-pos-phase-3-3.test.mjs | 1 |
| copy-vps-supabase-to-staging.test.mjs | 11 |
| crm-sales-report-query-optimization.test.mjs | 1 |
| crm-sales-report-suggestions.test.mjs | 1 |
| crm-stats-period-performance.test.mjs | 1 |
| deploy-coolify.test.mjs | 9 |
| edge-deployment.test.mjs | 2 |
| equal-split-single-ticket.test.mjs | 1 |
| fiscal-bridge-revocation-sql.test.mjs | 1 |
| fiscal-ticket-qr-settings.test.mjs | 1 |
| inventory-management.test.mjs | 1 |
| inventory-recipes-v2.test.mjs | 7 |
| migration-safety-exception.test.mjs | 6 |
| operational-day.test.mjs | 2 |
| payment-method-cash-session-lock.test.mjs | 1 |
| pos-read-snapshots.test.mjs | 1 |
| pos-sale-latency.test.mjs | 1 |
| prepare-production-migrations.test.mjs | 4 |
| production-lifecycle-sql.test.mjs | 1 |
| production-paid-orders.test.mjs | 1 |
| production-workflow-sql.test.mjs | 1 |
| profitability-operational-day.test.mjs | 2 |
| purchase-document-deletion.test.mjs | 1 |
| refactor-domain-policies.test.mjs | 2 |
| refund-installation-series.test.mjs | 1 |
| reservations-domain.test.mjs | 2 |
| restaurant-fiscal-bridge-sync.test.mjs | 1 |
| restaurant-kitchen-comments.test.mjs | 1 |
| restaurant-menu-courses.test.mjs | 1 |
| restore-venue-layout.test.mjs | 1 |
| staging-baseline.test.mjs | 3 |
| staging-demo-history.test.mjs | 5 |
| staging-demos.test.mjs | 6 |
| stripe-billing-recovery.test.mjs | 1 |
| supplier-document-receipts.test.mjs | 5 |
| supplier-document-storage-policies.test.mjs | 1 |
| ticket-catalog-snapshot-lookup.test.mjs | 1 |
| tickit-api.test.mjs | 1 |
| tickit-assist-sql.test.mjs | 1 |
| venue-restaurant-operations.test.mjs | 1 |
| verifactu-activation.test.mjs | 1 |
| verifactu-crm-settings.test.mjs | 1 |
| verifactu-local-installations.test.mjs | 1 |

Además se depuraron aserciones redundantes en los casos mixtos de billing, fiscalidad PWA, preferencias de tema y snapshots de costes.

## Verificación de esta pasada

- `pnpm test`: 72/72 escenarios Vitest de Cashlogy pasan; suite heredada 901/908 pasan. Los siete fallos siguen siendo los previos de `restaurant-menu-courses.test.mjs`, con `FLEXIBLE_MENU_SELECTION_SIGNATURE_NOT_FOUND` al preparar la base de pruebas. No hay fallos nuevos.
- Comprobación enfocada de los archivos podados: 138/138 pasan. Tras conservar la regresión de reservas y la conversión horaria del cierre, se ejecutaron de nuevo sus 12 escenarios: todos pasan.
- `pnpm lint`: sin errores; continúan únicamente las dos advertencias anteriores de dependencias de hooks en `CrmPage.tsx` y `useRestaurantController.ts`.
- `git diff --check`: correcto.
- Auditoría AST: 925 declaraciones heredadas antes, 818 después; las 107 ausencias corresponden exactamente a la lista revisada. Ninguna eliminación adicional accidental.

No se repitió el build porque esta pasada solo modifica tests y documentación. Tampoco se desplegó ni se escribió en servicios externos.
