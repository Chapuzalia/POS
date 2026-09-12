# Revisión de la suite de tests — 11/09/2026

Propuesta para decidir qué conservar, simplificar o eliminar. No se han modificado ni borrado tests.

## Alcance y método

Inventario de los **118 archivos `tests/*.test.mjs`**, entradas, dependencias y mecanismos de aserción, con lectura detallada de los casos citados. Hay **844 declaraciones principales `test(...)` y 53 declaraciones `t.test(...)`**. Son recuentos estáticos: los bucles generan casos adicionales y un contenedor puede agrupar subtests; no equivalen al total de una ejecución.

El script de package.json ejecuta todos los archivos juntos con Node. El workflow de producción ejecuta `pnpm test`; por eso las restricciones de aspecto pueden bloquear una publicación. No se ha ejecutado la suite ni medido tiempos o frecuencia de fallos. La resolución local de TypeScript falla por una dependencia no disponible; no se han reinstalado paquetes.

Las herramientas MCP del grafo no están disponibles en esta sesión. Se ha usado lectura y búsqueda directa. Esta es una clasificación de diseño de tests, no una certificación de cobertura o de corrección del producto. Se respetan cambios previos en deployment-workflow.test.mjs, app-version.test.mjs y production.yml.

**102 de 118 archivos usan readFile/readFileSync.** No significa que todos sean estáticos: algunos leen código para ejecutarlo en VM o cargan SQL en PGlite. Por eso no recomiendo borrar por nombre, por usar regex o por importar fs.

## Bloques principales

Asignación por responsabilidad predominante, sin contar dos veces un archivo. Textos, modales y comprobaciones de código son además dimensiones transversales.

| Bloque | Archivos | Declaraciones principales | Orientación |
|---|---:|---:|---|
| Importes, descuentos y cierres | 17 | 110 | Conservar cálculos; sustituir regex sobre persistencia por resultados. |
| Catálogo, selección e importaciones | 17 | 85 | Conservar reglas y transformaciones; recortar restricciones heredadas de refactors. |
| Workflows de mesas, reservas y producción | 18 | 152 | Conservar comportamiento; reemplazar comprobaciones de código, separar estética. |
| Comunicaciones, Cashlogy e impresión | 11 | 93 | Conservar contratos, reintentos, estados e idempotencia; depurar regex de conexión entre módulos e interfaz. |
| Offline, recuperación y ciclo de sesión | 10 | 47 | Conservar reglas de recuperación; sustituir pruebas de nombres y orden de código. |
| Identidad, permisos y configuración | 11 | 46 | Conservar políticas y aislamiento; mejorar pruebas estáticas y quitar textos incidentales. |
| Interfaz, modales, estilos y textos | 13 | 43 | Primer bloque para recortar; conservar interacción, accesibilidad y persistencia con pruebas de comportamiento. |
| Inventario, compras y OCR | 12 | 201 | Conservar matemáticas, parsing, evidencia y transacciones; separar UI y regex SQL. |
| Facturación y contratos fiscales | 2 | 36 | Conservar contratos y snapshots; sustituir regex sobre permisos y flujos. |
| Build, despliegue, migraciones, PWA y observabilidad | 7 | 31 | Conservar salvaguardas; flexibilizar versiones, nombres y estructura incidental. |

## Qué conservar y qué desechar

### 1. Textos, clases y composición visual: primera poda

El caso concreto está en [table-map.test.mjs:426](../tests/table-map.test.mjs#L426), con la aserción en la línea 428: exige literalmente `<h1>Mapa de mesas -</h1>`. Un cambio de título puede romperlo aunque el mapa siga funcionando. Eliminar esa aserción; no borrar los 53 casos del archivo: contiene pruebas útiles de coordenadas, uniones, colisiones y estados.

Primer lote propuesto: **2 archivos, 7 declaraciones principales**:

- **discount-modal-visual.test.mjs (2):** exige `max-w-xl`, `h-11 min-h-11`, `min-h-14`, alineación y disposición. Eliminar los casos actuales.
- **pos-product-cards.test.mjs (5):** fija alturas, rejillas, estructura y componentes concretos. Eliminar esas pruebas actuales. Las comprobaciones de `aria-pressed`/`alt` incluidas no demuestran accesibilidad ni selección: trasladar ese objetivo a una prueba de interacción si se conserva como requisito.
**pos-select-indicators.test.mjs (1)** queda fuera del borrado directo: exige una receta de JSX, pero intenta evitar que aparezcan marcas en opciones no seleccionadas. Sustituir por selección visible correcta; retirar entonces la regex.

Poda por aserción, sin borrar archivos completos:

- **crm-theme:** colores hexadecimales, sombras, medidas, posición junto a «Salir» y textos. Conservar el objetivo de persistir el tema y mantenerlo independiente del TPV.
- **catalog-ui:** tokens Tailwind, anchura de 940 px, nombres de componentes y textos «Duplicar aquí». Conservar duplicación y ordenación funcionales.
- **catalog-tab-icons:** los siete primeros iconos en orden y un mínimo de 40. Conservar unicidad de claves y que una selección se guarde/recupere.
- **table-map / reservations-ux:** encabezados, textos de botones, breakpoints, clases, sombras y duración exacta de animación. Conservar navegación, asignación de mesas y validación.

No todo texto exacto es cosmético: claves JSON, estados de protocolo, importes impresos y contenido de un QR pueden ser contratos. Un error debe probar principalmente su condición/código; su redacción solo si existe un requisito concreto.

### 2. Modales: mantener las reglas, retirar la receta de JSX

[pos-modal-backdrop.test.mjs](../tests/pos-modal-backdrop.test.mjs) inspecciona imports, props y clases. No abre un modal, pulsa Escape ni verifica el foco. Sus seis casos mezclan política de cierre con márgenes y bordes.

Conservar como comportamiento: apertura/cierre, foco, Escape, confirmación al descartar y bloqueo durante una operación de cobro. Eliminar las comprobaciones de padding, anchuras y clases. Consolidar la política en el modal compartido y añadir únicamente las excepciones con impacto funcional.

[product-dialog-mixer-close.test.mjs](../tests/product-dialog-mixer-close.test.mjs) busca `onCancel()` dentro de un fragmento delimitado por nombres de funciones y prohíbe `setTimeout|isClosing`. Sustituirlo por aceptar el producto/mixer y comprobar que se añade una sola línea y se cierra el diálogo.

**crm-select y crm-venue-selector** repiten comprobaciones del mismo selector (HeroUI, ListBox, teclado, selección). Consolidarlas en una prueba del componente compartido y otra de cambio efectivo de local. No hace falta comprobar esa receta de JSX en ambos archivos.

**data-table-rows** prohíbe componentes de fila e impone un mínimo de ocho consumidores. Puede estar documentando una limitación real del DataTable, pero el test está acoplado a la estructura del repositorio. Sustituir por una regresión que renderice y opere la tabla antes de retirar el guard.

### 3. Funcionalidad y workflows: conservar resultados observables

Conservar cálculos de dinero en céntimos, impuestos, descuentos, reparto, cierres, recetas, disponibilidad, snapshots y transformaciones de importación. Ejemplos claros: discounts, cash-movements (parte ejecutable), inventory-recipes-v2, reservations-domain, catalog-domain-phase-3-1 y revo-cash-closing-import.

Varios nombres prometen más que la implementación: **discount-integration, reservations-integration, split-orders, restaurant-payment-background y realtime** inspeccionan texto de código/SQL. No prueban por sí solos una integración en funcionamiento. No eliminar la garantía: reemplazar el mecanismo.

Prioridades de sustitución:

1. Reparto y cobro parcial: importes, revisiones concurrentes, idempotencia y liberación de mesa solamente al terminar.
2. Recuperación offline y Cashlogy: no cobrar dos veces, no perder ventas, distinguir estado incierto y no reabrir un modal indebidamente.
3. Reservas: disponibilidad, capacidad, confirmación de descarte y asignación antes de sentar.
4. Permisos/locales: un usuario o dispositivo no puede operar fuera de su ámbito.

Dos casos especialmente engañosos:

- **production-domain:** «two destinations on the same physical printer become one dispatch» y «destinations on different printers remain separate physical dispatches» llaman a `groupPhysicalTargets`, definida en el propio test. No ejecutan la agrupación SQL de producción. Sustituir por ejecución del SQL; descartar esa copia como evidencia.
- **equal-split-orders:** el test del descuento heredado calcula con `allocate`, una función local del test. Sus regex y esa cuenta ilustran lo esperado, pero no demuestran que el servidor lo haga. Sustituir por el resultado real de la RPC/SQL.

No borrar archivos por llamarse «refactor» o «phase»: **crm-refactor** y **catalog-crm-phase-3-2**, por ejemplo, contienen reglas y cálculos ejecutables útiles.

### 4. Comunicaciones: bloque de alto valor, con distintos niveles de simulación

**local-printing, cashlogy y verifacti-integration** ejecutan clientes/mapeadores y comprueban contratos, errores, reintentos, cancelación e idempotencia con transportes controlados. Conservar esas pruebas. Sus partes estáticas de UI o wiring se pueden recortar por separado.

**restaurant-realtime-sync** ejecuta hooks reales con React, eventos y temporizadores simulados. **cashlogy-background-recovery** ejecuta acciones reales del store en VM. Son más valiosos que buscar un nombre en un archivo, aunque los arneses manuales también pueden necesitar mantenimiento y no equivalen a un navegador real.

No se ha encontrado una suite de navegador con Playwright/Testing Library en el alcance revisado. No atribuir a estas pruebas cobertura end-to-end de clics, foco, layout, hardware o proveedores remotos.

### 5. Base de datos y OCR: no confundir regex SQL con transacciones probadas

Hay pruebas con **PGlite en 6 archivos**: restaurant-carryovers-sql, revo-cash-closing-sql, reservation-order-reuse, supplier-document-addons, supplier-document-global-learning y supplier-document-supplier-flow. Conservar los escenarios ejecutados de integridad, rollback, reutilización e idempotencia. Son bases efímeras, no validación del entorno productivo completo.

Los tests que solo buscan `auth.uid`, `tenant_id`, `for update` o `insert into` en SQL no demuestran permisos ni atomicidad. Reemplazarlos progresivamente por casos positivos/negativos ejecutados, sin retirar antes las únicas salvaguardas de procesos críticos.

El bloque OCR tiene muchos casos, pero cubre variaciones de entrada, evidencia inventada, ambigüedad, fallback y costes de proveedores. El volumen o usar textos como fixtures no lo hace descartable: interpretar texto es precisamente su función. Priorizar la retirada de regex de interfaz y estructura, no de esos escenarios.

### 6. Build y workflows de despliegue: mantener garantías, aflojar detalles incidentales

**deployment-workflow** exige versiones exactas de corepack/pnpm/vercel, el nombre de un step y comandos escritos de una manera concreta. Quitar esos detalles duplicados; conservar que una build validada preceda a la migración y que la promoción ocurra después. Una prueba estructural del workflow puede tener sentido aquí, pero debe proteger dependencias y condiciones, no redacción.

**bundle-splitting** comprueba fronteras de carga y configuración por texto. Si preocupa el peso inicial, medir el resultado del build con un presupuesto explícito es más útil que inmovilizar imports o nombres de grupos.

Conservar **build-environment**, la parte ejecutable de **migration-safety**, **observability** (privacidad y errores) y las garantías de instalación/caché de **pwa**. Las dimensiones de iconos PWA son un contrato del recurso, no comparables a fijar el título de una pantalla.

**supplier-document-edge-types** ejecuta el compilador: separar esa comprobación en typecheck puede aclarar la suite. No eliminarla solo porque la aplicación ya compila: la Edge Function usa otro alcance.

### Orden recomendado para decidir

1. Aprobar la poda de los dos archivos de composición estética y de aserciones de copy/clases en archivos mixtos.
2. Consolidar pruebas repetidas de selectores y política de modales, conservando interacción y accesibilidad.
3. Sustituir regex y cálculos copiados en flujos críticos por comportamiento real.
4. Separar ejecución rápida de dominio, contratos/SQL y typecheck/build para entender qué falla y por qué.

Esta revisión identifica fragilidad por diseño, no demuestra cuáles fallan con mayor frecuencia ni cuánto tiempo consumen. Para ordenar por coste real harían falta resultados/historial de CI. No recomiendo un porcentaje global de borrado sin esa evidencia.

## Inventario completo por archivo

**Estático**: inspecciona código/configuración. **Ejecutable**: ejecuta lógica de producto o contratos. **Mixto**: combina ambos o requiere separar casos. **SQL ejecutado**: contiene pruebas con PostgreSQL efímero (PGlite), aunque también puede contener comprobaciones estáticas. La técnica no determina por sí sola el valor. Los enlaces llevan al archivo local relativo a este documento.

### Importes, descuentos y cierres

| Archivo | Casos¹ | Técnica | Decisión propuesta |
|---|---:|---|---|
| [cash-closing-chart.test.mjs](../tests/cash-closing-chart.test.mjs) | 5 | Ejecutable | Conservar. |
| [cash-movements.test.mjs](../tests/cash-movements.test.mjs) | 12 | Mixto | Conservar cálculos; sustituir regex sobre persistencia por resultados. |
| [cash-payment.test.mjs](../tests/cash-payment.test.mjs) | 4 | Ejecutable | Conservar. |
| [cashlogy-cash-session-balance.test.mjs](../tests/cashlogy-cash-session-balance.test.mjs) | 5 | Mixto | Conservar cálculos; sustituir regex sobre persistencia por resultados. |
| [crm-cash-closing-reports.test.mjs](../tests/crm-cash-closing-reports.test.mjs) | 8 | Mixto | Conservar cálculos; sustituir regex sobre persistencia por resultados. |
| [crm-dashboard-day-activity.test.mjs](../tests/crm-dashboard-day-activity.test.mjs) | 2 | Mixto | Conservar cálculos; sustituir regex sobre persistencia por resultados. |
| [crm-dashboard-open-cash.test.mjs](../tests/crm-dashboard-open-cash.test.mjs) | 14 | Mixto | Conservar cálculos; sustituir regex sobre persistencia por resultados. |
| [discount-integration.test.mjs](../tests/discount-integration.test.mjs) | 6 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [discount-promotions.test.mjs](../tests/discount-promotions.test.mjs) | 22 | Mixto | Conservar cálculos; sustituir regex sobre persistencia por resultados. |
| [discount-target-filters.test.mjs](../tests/discount-target-filters.test.mjs) | 3 | Mixto | Conservar cálculos; sustituir regex sobre persistencia por resultados. |
| [discounts.test.mjs](../tests/discounts.test.mjs) | 8 | Ejecutable | Conservar. |
| [operational-day-integration.test.mjs](../tests/operational-day-integration.test.mjs) | 2 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [operational-day.test.mjs](../tests/operational-day.test.mjs) | 7 | Mixto | Conservar cálculos; sustituir regex sobre persistencia por resultados. |
| [shift-summary.test.mjs](../tests/shift-summary.test.mjs) | 3 | Mixto | Conservar cálculos; sustituir regex sobre persistencia por resultados. |
| [tax.test.mjs](../tests/tax.test.mjs) | 6 | Mixto | Conservar cálculos; sustituir regex sobre persistencia por resultados. |
| [ticket-line-discount-defaults.test.mjs](../tests/ticket-line-discount-defaults.test.mjs) | 1 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [ticket-line-discount-fiscal-snapshot.test.mjs](../tests/ticket-line-discount-fiscal-snapshot.test.mjs) | 2 | Mixto | Conservar cálculos; sustituir regex sobre persistencia por resultados. |

### Catálogo, selección e importaciones

| Archivo | Casos¹ | Técnica | Decisión propuesta |
|---|---:|---|---|
| [catalog-architecture.test.mjs](../tests/catalog-architecture.test.mjs) | 4 | Mixto | Conservar reglas y transformaciones; recortar restricciones heredadas de refactors. |
| [catalog-crm-phase-3-2.test.mjs](../tests/catalog-crm-phase-3-2.test.mjs) | 9 | Mixto | Conservar reglas y transformaciones; recortar restricciones heredadas de refactors. |
| [catalog-domain-phase-3-1.test.mjs](../tests/catalog-domain-phase-3-1.test.mjs) | 15 | Mixto | Conservar reglas y transformaciones; recortar restricciones heredadas de refactors. |
| [catalog-domain-sql-phase-3-1.test.mjs](../tests/catalog-domain-sql-phase-3-1.test.mjs) | 2 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [catalog-migration.test.mjs](../tests/catalog-migration.test.mjs) | 4 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [catalog-panel-top-items.test.mjs](../tests/catalog-panel-top-items.test.mjs) | 4 | Ejecutable | Conservar. |
| [catalog-pos-phase-3-3.test.mjs](../tests/catalog-pos-phase-3-3.test.mjs) | 5 | Mixto | Revisar pruebas de fin de migración; conservar snapshots y caché por local. |
| [catalog-sale-formats.test.mjs](../tests/catalog-sale-formats.test.mjs) | 4 | Mixto | Conservar reglas y transformaciones; recortar restricciones heredadas de refactors. |
| [catalog-tab-icons.test.mjs](../tests/catalog-tab-icons.test.mjs) | 2 | Mixto | Quitar orden inicial y cantidad mínima arbitraria; conservar claves únicas y persistencia. |
| [catalog-transfer.test.mjs](../tests/catalog-transfer.test.mjs) | 4 | Mixto | Conservar reglas y transformaciones; recortar restricciones heredadas de refactors. |
| [menu-lifecycle.test.mjs](../tests/menu-lifecycle.test.mjs) | 3 | Mixto | Conservar reglas y transformaciones; recortar restricciones heredadas de refactors. |
| [mixers.test.mjs](../tests/mixers.test.mjs) | 7 | Ejecutable | Conservar. |
| [product-sales-stats.test.mjs](../tests/product-sales-stats.test.mjs) | 2 | Ejecutable | Conservar. |
| [product-selection-dialog.test.mjs](../tests/product-selection-dialog.test.mjs) | 5 | Ejecutable | Conservar. |
| [revo-cash-closing-import.test.mjs](../tests/revo-cash-closing-import.test.mjs) | 5 | Ejecutable | Conservar. |
| [revo-cash-closing-sql.test.mjs](../tests/revo-cash-closing-sql.test.mjs) | 1 + 5 sub | SQL ejecutado / mixto | Conservar reglas y transformaciones; recortar restricciones heredadas de refactors. |
| [revo-import.test.mjs](../tests/revo-import.test.mjs) | 9 | Mixto | Conservar reglas y transformaciones; recortar restricciones heredadas de refactors. |

### Workflows de mesas, reservas y producción

| Archivo | Casos¹ | Técnica | Decisión propuesta |
|---|---:|---|---|
| [empty-table-cancel.test.mjs](../tests/empty-table-cancel.test.mjs) | 4 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [equal-split-orders.test.mjs](../tests/equal-split-orders.test.mjs) | 10 | Estático + lógica copiada | Sustituir regex SQL y cálculo copiado; quitar textos incidentales del modal. |
| [map-elements.test.mjs](../tests/map-elements.test.mjs) | 3 | Ejecutable | Conservar. |
| [pre-ticket-and-quick-sale-virtual-table.test.mjs](../tests/pre-ticket-and-quick-sale-virtual-table.test.mjs) | 8 | Mixto | Conservar comportamiento; reemplazar comprobaciones de código, separar estética. |
| [production-domain.test.mjs](../tests/production-domain.test.mjs) | 7 | Estático + lógica copiada | Eliminar 2 pruebas de función local copiada cuando se sustituyan por SQL real; conservar garantías. |
| [remove-served-order-line.test.mjs](../tests/remove-served-order-line.test.mjs) | 4 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [reservation-order-reuse.test.mjs](../tests/reservation-order-reuse.test.mjs) | 4 | SQL ejecutado / mixto | Conservar comportamiento; reemplazar comprobaciones de código, separar estética. |
| [reservations-domain.test.mjs](../tests/reservations-domain.test.mjs) | 6 | Ejecutable | Conservar. |
| [reservations-integration.test.mjs](../tests/reservations-integration.test.mjs) | 8 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [reservations-ux.test.mjs](../tests/reservations-ux.test.mjs) | 14 | Estático | Quitar estética y textos incidentales; sustituir disponibilidad, descarte y capacidad por interacción. |
| [restaurant-carryover-auto-recovery.test.mjs](../tests/restaurant-carryover-auto-recovery.test.mjs) | 4 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [restaurant-carryovers-sql.test.mjs](../tests/restaurant-carryovers-sql.test.mjs) | 2 + 10 sub | SQL ejecutado / mixto | Conservar comportamiento; reemplazar comprobaciones de código, separar estética. |
| [restaurant-order-line-editing.test.mjs](../tests/restaurant-order-line-editing.test.mjs) | 3 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [restaurant-payment-background.test.mjs](../tests/restaurant-payment-background.test.mjs) | 3 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [split-orders.test.mjs](../tests/split-orders.test.mjs) | 7 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [table-deletion-history.test.mjs](../tests/table-deletion-history.test.mjs) | 5 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [table-map.test.mjs](../tests/table-map.test.mjs) | 53 | Mixto | Conservar geometría y estados; quitar título, clases, medidas cosméticas y tiempos exactos. |
| [virtual-tables.test.mjs](../tests/virtual-tables.test.mjs) | 7 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |

### Comunicaciones, Cashlogy e impresión

| Archivo | Casos¹ | Técnica | Decisión propuesta |
|---|---:|---|---|
| [cash-closing-printing.test.mjs](../tests/cash-closing-printing.test.mjs) | 10 | Mixto | Conservar contratos, reintentos, estados e idempotencia; depurar regex de conexión entre módulos e interfaz. |
| [cashlogy-background-recovery.test.mjs](../tests/cashlogy-background-recovery.test.mjs) | 2 | Ejecutable con dobles / VM | Conservar contratos, reintentos, estados e idempotencia; depurar regex de conexión entre módulos e interfaz. |
| [cashlogy-management-pin.test.mjs](../tests/cashlogy-management-pin.test.mjs) | 3 | Mixto | Conservar contratos, reintentos, estados e idempotencia; depurar regex de conexión entre módulos e interfaz. |
| [cashlogy-recovered-quick-sale.test.mjs](../tests/cashlogy-recovered-quick-sale.test.mjs) | 5 | Ejecutable con dobles / VM | Conservar contratos, reintentos, estados e idempotencia; depurar regex de conexión entre módulos e interfaz. |
| [cashlogy.test.mjs](../tests/cashlogy.test.mjs) | 23 | Mixto | Conservar contratos, reintentos, estados e idempotencia; depurar regex de conexión entre módulos e interfaz. |
| [local-printing.test.mjs](../tests/local-printing.test.mjs) | 24 | Mixto | Conservar contratos, reintentos, estados e idempotencia; depurar regex de conexión entre módulos e interfaz. |
| [print-document-lines.test.mjs](../tests/print-document-lines.test.mjs) | 5 | Ejecutable | Conservar. |
| [print-jobs-table.test.mjs](../tests/print-jobs-table.test.mjs) | 1 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [print-templates.test.mjs](../tests/print-templates.test.mjs) | 10 | Mixto | Conservar contratos, reintentos, estados e idempotencia; depurar regex de conexión entre módulos e interfaz. |
| [realtime.test.mjs](../tests/realtime.test.mjs) | 2 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [restaurant-realtime-sync.test.mjs](../tests/restaurant-realtime-sync.test.mjs) | 8 | Ejecutable con dobles / VM | Conservar contratos, reintentos, estados e idempotencia; depurar regex de conexión entre módulos e interfaz. |

### Offline, recuperación y ciclo de sesión

| Archivo | Casos¹ | Técnica | Decisión propuesta |
|---|---:|---|---|
| [app-version.test.mjs](../tests/app-version.test.mjs) | 3 | Mixto | Conservar reglas de recuperación; sustituir pruebas de nombres y orden de código. |
| [clear-local-cache.test.mjs](../tests/clear-local-cache.test.mjs) | 2 | Ejecutable | Conservar. |
| [login-inactivity.test.mjs](../tests/login-inactivity.test.mjs) | 5 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [login-lease.test.mjs](../tests/login-lease.test.mjs) | 5 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [offline-sale-economics.test.mjs](../tests/offline-sale-economics.test.mjs) | 6 | Mixto | Conservar reglas de recuperación; sustituir pruebas de nombres y orden de código. |
| [offline-session.test.mjs](../tests/offline-session.test.mjs) | 11 | Mixto | Conservar reglas de recuperación; sustituir pruebas de nombres y orden de código. |
| [offline-sync-rejection.test.mjs](../tests/offline-sync-rejection.test.mjs) | 3 | Ejecutable | Conservar. |
| [pos-error-lifecycle.test.mjs](../tests/pos-error-lifecycle.test.mjs) | 3 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [pos-reconnect-quick-sale-regressions.test.mjs](../tests/pos-reconnect-quick-sale-regressions.test.mjs) | 4 | Mixto | Conservar reglas de recuperación; sustituir pruebas de nombres y orden de código. |
| [refactor-domain-policies.test.mjs](../tests/refactor-domain-policies.test.mjs) | 5 | Ejecutable | Conservar. |

### Identidad, permisos y configuración

| Archivo | Casos¹ | Técnica | Decisión propuesta |
|---|---:|---|---|
| [app-routes.test.mjs](../tests/app-routes.test.mjs) | 3 | Mixto | Conservar políticas y aislamiento; mejorar pruebas estáticas y quitar textos incidentales. |
| [crm-catalog-login.test.mjs](../tests/crm-catalog-login.test.mjs) | 2 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [crm-password-settings.test.mjs](../tests/crm-password-settings.test.mjs) | 1 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [crm-refactor.test.mjs](../tests/crm-refactor.test.mjs) | 8 | Mixto | Conservar políticas y aislamiento; mejorar pruebas estáticas y quitar textos incidentales. |
| [crm-venue-settings.test.mjs](../tests/crm-venue-settings.test.mjs) | 2 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [device-user-provisioning.test.mjs](../tests/device-user-provisioning.test.mjs) | 10 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [manager-crm-login.test.mjs](../tests/manager-crm-login.test.mjs) | 2 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [multi-device-cash-sessions.test.mjs](../tests/multi-device-cash-sessions.test.mjs) | 3 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [platform-lifecycle.test.mjs](../tests/platform-lifecycle.test.mjs) | 10 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [remove-admin-role.test.mjs](../tests/remove-admin-role.test.mjs) | 2 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [tenant-feature-gating.test.mjs](../tests/tenant-feature-gating.test.mjs) | 3 | Mixto | Conservar políticas y aislamiento; mejorar pruebas estáticas y quitar textos incidentales. |

### Interfaz, modales, estilos y textos

| Archivo | Casos¹ | Técnica | Decisión propuesta |
|---|---:|---|---|
| [catalog-ui.test.mjs](../tests/catalog-ui.test.mjs) | 4 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [crm-pwa-safe-area.test.mjs](../tests/crm-pwa-safe-area.test.mjs) | 5 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [crm-select.test.mjs](../tests/crm-select.test.mjs) | 4 | Estático | Consolidar teclado/selección/valor enviado; eliminar tokens y obligación global de componente. |
| [crm-theme.test.mjs](../tests/crm-theme.test.mjs) | 5 | Estático | Quitar colores, medidas, ubicación y copy; conservar independencia/persistencia del tema. |
| [crm-venue-selector.test.mjs](../tests/crm-venue-selector.test.mjs) | 4 | Estático | Consolidar con crm-select; conservar cambio efectivo de local. |
| [data-table-rows.test.mjs](../tests/data-table-rows.test.mjs) | 1 | Estático | Sustituir regla de JSX por una regresión de render/ordenación del DataTable. |
| [discount-modal-visual.test.mjs](../tests/discount-modal-visual.test.mjs) | 2 | Estático | Eliminar los 2 casos de composición estética. |
| [pos-ipad-viewport.test.mjs](../tests/pos-ipad-viewport.test.mjs) | 3 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [pos-modal-backdrop.test.mjs](../tests/pos-modal-backdrop.test.mjs) | 6 | Estático | Separar estética de cierre bloqueado, Escape y foco; probar interacciones. |
| [pos-product-cards.test.mjs](../tests/pos-product-cards.test.mjs) | 5 | Estático | Eliminar los 5 casos actuales; recuperar selección/accesibilidad con interacción si hace falta. |
| [pos-select-indicators.test.mjs](../tests/pos-select-indicators.test.mjs) | 1 | Estático | Sustituir regex por selección visible correcta; no es solo estética. |
| [pos-startup-transition.test.mjs](../tests/pos-startup-transition.test.mjs) | 2 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [product-dialog-mixer-close.test.mjs](../tests/product-dialog-mixer-close.test.mjs) | 1 | Estático | Sustituir regex por aceptar una línea y comprobar cierre. |

### Inventario, compras y OCR

| Archivo | Casos¹ | Técnica | Decisión propuesta |
|---|---:|---|---|
| [inventory-management.test.mjs](../tests/inventory-management.test.mjs) | 24 | Mixto | Conservar matemáticas, parsing, evidencia y transacciones; separar UI y regex SQL. |
| [inventory-recipes-v2.test.mjs](../tests/inventory-recipes-v2.test.mjs) | 9 | Mixto | Conservar matemáticas, parsing, evidencia y transacciones; separar UI y regex SQL. |
| [purchase-management.test.mjs](../tests/purchase-management.test.mjs) | 15 | Mixto | Conservar matemáticas, parsing, evidencia y transacciones; separar UI y regex SQL. |
| [supplier-document-addons.test.mjs](../tests/supplier-document-addons.test.mjs) | 6 | SQL ejecutado / mixto | Conservar matemáticas, parsing, evidencia y transacciones; separar UI y regex SQL. |
| [supplier-document-edge-types.test.mjs](../tests/supplier-document-edge-types.test.mjs) | 2 | Compilador TypeScript | Separar typecheck de tests; no borrar la comprobación de Edge sin equivalente. |
| [supplier-document-global-learning.test.mjs](../tests/supplier-document-global-learning.test.mjs) | 15 + 30 sub | SQL ejecutado / mixto | Conservar matemáticas, parsing, evidencia y transacciones; separar UI y regex SQL. |
| [supplier-document-metadata.test.mjs](../tests/supplier-document-metadata.test.mjs) | 11 | Ejecutable | Conservar. |
| [supplier-document-ocr-quality.test.mjs](../tests/supplier-document-ocr-quality.test.mjs) | 25 | Mixto | Conservar matemáticas, parsing, evidencia y transacciones; separar UI y regex SQL. |
| [supplier-document-profile-repair.test.mjs](../tests/supplier-document-profile-repair.test.mjs) | 5 | Mixto | Conservar matemáticas, parsing, evidencia y transacciones; separar UI y regex SQL. |
| [supplier-document-receipts.test.mjs](../tests/supplier-document-receipts.test.mjs) | 70 | Mixto | Conservar matemáticas, parsing, evidencia y transacciones; separar UI y regex SQL. |
| [supplier-document-supplier-flow.test.mjs](../tests/supplier-document-supplier-flow.test.mjs) | 14 + 8 sub | SQL ejecutado / mixto | Conservar matemáticas, parsing, evidencia y transacciones; separar UI y regex SQL. |
| [venue-suppliers.test.mjs](../tests/venue-suppliers.test.mjs) | 5 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |

### Facturación y contratos fiscales

| Archivo | Casos¹ | Técnica | Decisión propuesta |
|---|---:|---|---|
| [customer-invoices.test.mjs](../tests/customer-invoices.test.mjs) | 21 | Mixto | Conservar contratos y snapshots; sustituir regex sobre permisos y flujos. |
| [verifacti-integration.test.mjs](../tests/verifacti-integration.test.mjs) | 15 | Mixto | Conservar contratos y snapshots; sustituir regex sobre permisos y flujos. |

### Build, despliegue, migraciones, PWA y observabilidad

| Archivo | Casos¹ | Técnica | Decisión propuesta |
|---|---:|---|---|
| [build-environment.test.mjs](../tests/build-environment.test.mjs) | 2 | Ejecutable | Conservar. |
| [bundle-splitting.test.mjs](../tests/bundle-splitting.test.mjs) | 5 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [consolidated-database.test.mjs](../tests/consolidated-database.test.mjs) | 2 | Estático | Conservar objetivo funcional; sustituir regex y retirar detalles incidentales. |
| [deployment-workflow.test.mjs](../tests/deployment-workflow.test.mjs) | 2 | Estático | Conservar orden build→migración→promoción; quitar pins duplicados y nombres de steps. |
| [migration-safety.test.mjs](../tests/migration-safety.test.mjs) | 7 | Mixto | Conservar salvaguardas; flexibilizar versiones, nombres y estructura incidental. |
| [observability.test.mjs](../tests/observability.test.mjs) | 8 | Mixto | Conservar salvaguardas; flexibilizar versiones, nombres y estructura incidental. |
| [pwa.test.mjs](../tests/pwa.test.mjs) | 5 | Mixto | Conservar salvaguardas; flexibilizar versiones, nombres y estructura incidental. |

¹ Declaraciones estáticas, no número de casos ejecutados.

