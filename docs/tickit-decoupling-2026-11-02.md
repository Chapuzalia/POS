# Desacoplamiento de la app — 2 de noviembre de 2026

Seguimiento del análisis principal del 26/10, sobre el checkout actualizado hasta `4dd092d`, incluyendo las extracciones previas de esta conversación. El alcance es la aplicación y sus pruebas. No se han cambiado `supabase/`, migraciones, `apps/`, workflows, configuración del cliente Supabase, dependencias ni lockfile. No se ha desplegado.

## Cambios principales

- `AppShell` conserva sesión, rutas, tema y aviso de actualización. Caja, venta rápida, restaurante, reservas, impresión e hidratación operativa pertenecen a `PosRuntime`, cargado bajo demanda. La preparación de datos POS también es dinámica y se omite para CRM, Superadmin y KDS.
- La preparación online entrega un snapshot y una función de persistencia. Sólo una activación todavía vigente puede persistirlo y activar el contexto. La restauración offline diferida recibe la misma comprobación de vigencia. Se mantienen las rutas y claves de autenticación anteriores.
- Los cambios posteriores de pago usan el journal y los stores IndexedDB existentes. Operación, payload y evento se confirman juntos; las copias de tickets/ledger se pueden reconstruir después de fallos. Los cobros inciertos conservan su identidad. No cambia la versión ni el esquema IndexedDB ni el contrato del evento enviado al servidor.
- La reconciliación de caja distingue lectura remota, cambios locales durante la lectura y operaciones pendientes. Se usa también al hidratar una sesión. La cola aplaza eventos dependientes de una venta fallida sin detener otras ventas.
- Impresión prepara plantillas con un presupuesto remoto total de un segundo y caché validada por tenant/local/tipo. Se invalidan al guardar/restaurar; respuestas tardías no repueblan una caché invalidada. Los trabajos de impresión se verifican por identidad/estado y un resultado ajeno permanece incierto, sin reenvío automático.
- Restaurante usa el helper monetario de cantidades existente para cálculo, documentos y splits. Se conservan los importes explícitos históricos y las restricciones comerciales de descuentos fijos por unidad.
- Superadmin y billing comunican operaciones pendientes mediante contadores y agregación padre/hijo; su navegación no desmonta paneles ocupados. Los componentes compartidos de estadísticas dejan de importar páginas entre sí. Mesas ya no importa reservas: estado compartido en dominio, fechas en utilidades y badge en mesas.
- La proyección de catálogo y su caché pertenecen a catálogo. CRM conserva su actualización sin callbacks hacia el estado POS de `AppShell`. Un fallo de esta copia posterior no transforma una mutación ya guardada en una mutación fallida.

## Seguimiento de los 22 hallazgos

| Hallazgo | Resultado en este alcance |
|---|---|
| H01: importes fraccionarios | Corregido mediante cálculo compartido; pruebas de cierre, snapshots y reparto de céntimos. |
| H02: rutas de tests en CI | No se modifica: pertenece a workflows/despliegue, fuera del código de app autorizado. |
| H03: durabilidad de mutaciones | Journal transaccional de cambios de pago y recuperación de proyecciones; cierre bloqueado ante operaciones económicas sin terminar. |
| H04: impresión dependiente de cloud | Lecturas acotadas, aborto, fallback y caché de plantillas. |
| H05: infraestructura dentro de fiscal | Apertura/esquema/primitivas trasladados a `lib/localDatabase.ts`, conservando literalmente el contrato existente. |
| H06: composición global | Runtime POS y preparación de datos separados del shell común. La vista POS conserva sus controladores propietarios; no se ha creado un framework de contratos de UI. |
| H07: parcheo textual SQL | Excluido: exigiría cambios de migraciones/SQL. |
| H08: resolvers API/SQL duplicados | Excluido: requiere coordinar backend y resolvers SQL. |
| H09: contratos RPC manuales | Validación reforzada en la frontera crítica de jobs de impresión. El tipado completo de RPC/SQL sigue siendo manual; no se regeneró el contrato del backend. |
| H10: bloqueo incompleto de actualización | Reporte de busy en Superadmin/billing, contadores concurrentes y navegación protegida. |
| H11: hidratación y limpieza amplias | Snapshot de bootstrap, persistencia previa a activación vigente y estado operativo dentro del runtime. Corregidas carreras de logout durante login/validación offline. |
| H12: ruta/auth/storage | Contrato conservado; no se sustituyó la navegación completa ni se renombraron claves/rutas. |
| H13: proyecciones de tickets/ledger | Precedencia del journal para copias pendientes y reconciliación frente a lecturas remotas, también durante arranque. Las fuentes históricas permanecen por compatibilidad. |
| H14: ámbitos y orden offline | Dependencias por venta y protección del ámbito original del journal. Las claves legacy y sus ámbitos no se migran. |
| H15: agregado restaurante/KDS | Controladores aislados en runtime POS y cálculo repetido extraído a servicio puro. Las revisiones, reservas y garantías compartidas del servidor se conservan; el controlador de restaurante sigue siendo grande. |
| H16: Realtime/polling | Las suscripciones operativas POS quedan dentro de su runtime. Se conservan el coalescing y polling existentes; no se han cambiado filtros por venue sin mediciones reales de carga. |
| H17: invalidación de catálogo | Preparación/caché de la proyección en catálogo; CRM deja de depender del shell POS. El contrato `PosCatalogState` pasa a dominio. |
| H18: reservas/mesas | Dependencia unidireccional con tipos/fechas neutrales y badge en mesas. |
| H19: hardware | Jobs y confirmaciones críticas validados. Los listados/metadatos opcionales y la compatibilidad bilateral con agentes físicos no quedan certificados. |
| H20: OCR/pantallas extensas | OCR/Edge excluidos. No se han dividido por tamaño los grandes editores CRM; su diseño interno sigue siendo una concentración residual. |
| H21: helpers transversales | Helpers de backend fuera de CRM e imports de impresión específicos. |
| H22: ciclo de páginas CRM | Eliminado con componentes compartidos fuera de las páginas. |

## Evidencia final

- `pnpm test`: **386/386 Vitest y 237/237 Node**, sin fallos ni skips, en el estado congelado final. Los tests HTTP locales se ejecutaron con permiso para conectar a `127.0.0.1`.
- `pnpm exec tsc -b`: código 0.
- `pnpm lint`: código 0; permanecen las dos advertencias anteriores de `selectedVenueId` en CRM y `refreshProduction` en restaurante.
- Build Vite local: correcto usando la configuración existente, excluyendo únicamente el plugin de publicación Sentry. Se conservaron el guard de variables y la generación de assets PWA. No se publicó release ni sourcemaps.
- `git diff --check`: correcto. Sin diferencias en los árboles y archivos excluidos indicados al principio.
- Grafo AST final: **cero componentes fuertemente conexos de imports de ejecución**. Se distinguen imports de tipos y dinámicos como en el análisis original; no se afirma que desaparezcan todos los acoplamientos semánticos.
- Bundle local: **54 módulos JavaScript iniciales**, 1.115.029 bytes sin comprimir y aproximadamente 348 KB gzip. Sus mapas de fuentes no incluyen los controladores de caja, venta rápida, restaurante ni reservas; sí mantienen sesión y sincronización compartida. Se excluyen CSS, WASM, mapas y cargas dinámicas posteriores. El informe histórico corresponde a otra revisión y otro modo de publicación; no se presenta una comparación porcentual de rendimiento.

Durante el desarrollo hubo reproducciones rojas intencionales y una ejecución global tomó un archivo de caja antes de que terminara su última edición. La ejecución final anterior se hizo con las modificaciones congeladas y pasó completa; no se eliminaron ni ocultaron pruebas.

No se ha probado navegador/PWA/iPad real, hardware físico, dos terminales reales ni convivencia con una PWA antigua instalada. La caché de plantillas es de memoria, con TTL de 60 segundos; sin red y sin copia válida se usa la plantilla segura existente. El cambio de pago incorpora metadatos aditivos en los registros del journal existente, sin modificar sus stores ni la forma de los eventos externos.
