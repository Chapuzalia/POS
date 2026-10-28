# Suite crítica de Tickit — 26/10/2026

Objetivo acordado: **200–300 casos críticos**. La suite queda en **299 casos en total**, incluidos los tests Python del workflow.

| Bloque | Casos ejecutados |
|---|---:|
| Cashlogy: Vitest con cliente HTTP y stores reales | 72 |
| Resto de la app: Node | 208 |
| Protección del despliegue que utiliza el workflow: Python | 19 |
| **Total** | **299** |

Los tests de la app pasan de 980 a 280: se retiran 700 casos ejecutados respecto a la segunda pasada. El inventario estático retira 624 declaraciones test/t.test y sus variantes parametrizadas, y conserva 194 declaraciones Node repartidas en 60 archivos.

## Criterio de selección

Esta pasada reduce deliberadamente la cobertura exhaustiva a una selección representativa de flujos y fallos críticos. No se presenta cada prueba funcional retirada como irrelevante: se da prioridad al presupuesto acordado y a escenarios que ejercitan resultados operativos. Se retiran variantes especializadas, validaciones de helpers ya cubiertas por flujos completos, configuraciones históricas, estadísticas secundarias y detalles de componentes.

La reducción se hace eliminando casos y archivos reales. No se han introducido filtros de ejecución, skips, exclusiones ni contenedores artificiales para ocultar el número de pruebas. Los grupos SQL con fixtures compartidos se conservan íntegros.

## Cobertura prioritaria conservada

- Cashlogy: cobro, errores HTTP/red, datos incoherentes, esperas, cancelación, recarga, concurrencia, recuperación y ausencia de segundos cobros; además de gestión de efectivo y diario durable.
- Persistencia de ventas: IndexedDB real, commit/rollback, cuota agotada, respuesta perdida, idempotencia y conservación del identificador original.
- Caja: importes cobrados, anulaciones, sesiones cerradas, cambios de pago y continuidad de comandas entre turnos y terminales.
- Fiscalidad: emisión económica y fiscal atómica, hashes, identidad y secuencia de instalación, ledger dañado, revocación, funcionamiento offline, entrega ordenada y devoluciones.
- Aislamiento y permisos: tenant, local, dispositivo y roles en consultas y operaciones; RLS y autenticación JWT del router.
- Restaurante/KDS: cantidades y céntimos en cobros parciales, reparto, concurrencia, servicio de platos y cursos independientes, confirmación previa al cobro y recuperación Realtime.
- Impresión: fallo posterior al cobro, QR fiscal obligatorio, copias, cajón, estado incierto y respuesta tardía.
- Compras y proveedores: stock, rollback, borrado autorizado, ámbito del documento, Storage y documentos cuyos importes necesitan revisión.
- Historial, informes y billing: snapshots históricos, cambios locales pendientes, consultas aisladas, permisos y conservación de derechos ante fallos.

Se han trasladado las comprobaciones de entradas/salidas de caja al flujo que combina ventas y movimientos, y las de datos completos del cliente al escenario que crea su snapshot y comprueba que cambios posteriores no lo alteran. No se han reducido sus garantías a comprobaciones de texto.

## Corrección del fixture de menús

Los siete fallos anteriores tenían una causa común en Windows: el archivo SQL del fixture usa CRLF, mientras la propia migración normaliza pg_get_functiondef a LF antes de aplicar sustituciones multilínea. Sus patrones no coincidían y la preparación fallaba con FLEXIBLE_MENU_SELECTION_SIGNATURE_NOT_FOUND.

Se normaliza únicamente el texto cargado por tests/restaurant-menu-courses.test.mjs con replaceAll('\r\n', '\n'). La revisión independiente comprobó que el texto resultante coincide exactamente con el SQL de HEAD, que usa LF. Se mantienen las nueve pruebas, la ejecución de la migración y todas sus aserciones. No se ha modificado ninguna migración ni código de producto.

## Verificación

- `pnpm test`: **72/72 Vitest y 208/208 Node**, sin fallos, cancelaciones, skips ni tareas pendientes. La parte Node termina en unos 28 segundos en esta ejecución.
- `python -m unittest discover -s tests -p test_deploy_pos.py`: **19/19**, sin fallos.
- **Total: 299/299 pasan.**
- `pnpm lint`: sin errores; únicamente las dos advertencias anteriores de dependencias de hooks en CrmPage.tsx y useRestaurantController.ts.
- `git diff --check`: correcto.
- Comparación AST frente a la instantánea previa: exactamente 194 declaraciones Node conservadas y 624 retiradas, sin ausencias accidentales adicionales. Se conservan todos los casos de Cashlogy y Python.
- Revisión independiente: sin hallazgos accionables en la selección ni en la normalización del fixture SQL.

No se han modificado producto, dependencias, configuración de tests, políticas o migraciones en esta tercera pasada. El build no se ha repetido al cambiar únicamente pruebas y documentación.

## Inventario de la selección Node

Los recuentos de esta tabla son declaraciones, no el total de variantes parametrizadas ni los tests Python/Vitest de arriba.

| Archivo conservado | Declaraciones conservadas | Declaraciones retiradas |
|---|---:|---:|
| accepted-sales-payment-recovery.test.mjs | 5 | 6 |
| accepted-sales-sql.test.mjs | 2 | 4 |
| accepted-sales-storage.test.mjs | 6 | 3 |
| cash-closing-printing.test.mjs | 3 | 5 |
| cash-ledger-annulment.test.mjs | 3 | 0 |
| cash-movements.test.mjs | 2 | 2 |
| cash-ticket-annulment.test.mjs | 3 | 2 |
| cashlogy-background-recovery.test.mjs | 8 | 17 |
| cashlogy-cash-session-balance.test.mjs | 2 | 0 |
| cashlogy-management-pin.test.mjs | 1 | 0 |
| cashlogy-recovered-quick-sale.test.mjs | 4 | 5 |
| cashlogy.test.mjs | 7 | 7 |
| catalog-domain-phase-3-1.test.mjs | 5 | 10 |
| crm-access-scope.test.mjs | 2 | 3 |
| crm-sales-report-query-optimization.test.mjs | 2 | 1 |
| customer-invoices.test.mjs | 3 | 7 |
| discount-promotions.test.mjs | 4 | 10 |
| edge-deployment.test.mjs | 2 | 2 |
| equal-split-single-ticket.test.mjs | 5 | 6 |
| fiscal-device-gate.test.mjs | 3 | 5 |
| fiscal-head-preparation.test.mjs | 2 | 1 |
| fiscal-installation-revocation.test.mjs | 2 | 0 |
| fiscal-offline-bridge-sync.test.mjs | 3 | 6 |
| fiscal-offline-preparation.test.mjs | 3 | 5 |
| fiscal-refund-bridge.test.mjs | 2 | 6 |
| fiscal-settings-recovery.test.mjs | 1 | 4 |
| local-printing.test.mjs | 8 | 39 |
| observability.test.mjs | 1 | 7 |
| offline-sale-economics.test.mjs | 1 | 2 |
| offline-session.test.mjs | 5 | 6 |
| payment-method-cash-session-lock.test.mjs | 6 | 0 |
| pos-read-snapshots.test.mjs | 2 | 1 |
| print-agent-timeouts.test.mjs | 2 | 2 |
| production-lifecycle-sql.test.mjs | 3 | 1 |
| purchase-document-deletion.test.mjs | 3 | 10 |
| pwa-fiscal-installation.test.mjs | 6 | 6 |
| pwa-navigation.test.mjs | 1 | 3 |
| reservations-domain.test.mjs | 1 | 3 |
| restaurant-carryovers-sql.test.mjs | 11 | 1 |
| restaurant-menu-courses.test.mjs | 9 | 0 |
| restaurant-menu-panel.test.mjs | 1 | 10 |
| restaurant-pending-payment.test.mjs | 2 | 2 |
| restaurant-realtime-sync.test.mjs | 2 | 6 |
| restaurant-served-line-removal.test.mjs | 2 | 0 |
| session-ticket-history-performance.test.mjs | 2 | 6 |
| session-ticket-refund-mapping.test.mjs | 2 | 2 |
| stripe-billing-recovery.test.mjs | 1 | 8 |
| stripe-billing-service.test.mjs | 2 | 7 |
| stripe-billing-sql.test.mjs | 3 | 6 |
| supplier-document-financials.test.mjs | 2 | 9 |
| supplier-document-storage-policies.test.mjs | 6 | 1 |
| supplier-document-supplier-flow.test.mjs | 9 | 12 |
| tax.test.mjs | 1 | 4 |
| tenant-feature-gating.test.mjs | 1 | 0 |
| venue-restaurant-operations.test.mjs | 4 | 5 |
| verifactu-activation.test.mjs | 1 | 3 |
| verifactu-bridge-client.test.mjs | 3 | 7 |
| verifactu-hash.test.mjs | 3 | 1 |
| verifactu-local-domain.test.mjs | 2 | 13 |
| verifactu-sale-rpc.test.mjs | 1 | 0 |

Se eliminaron 66 archivos Node adicionales completos. Los informes del 25/10 registran las dos pasadas anteriores; este documento describe la selección vigente.
