# Tickit Assist V1

## 1. Arquitectura

Assist es un módulo secundario del POS. Reutiliza el catálogo de módulos del tenant, la configuración de locales, la caché offline y el mapa operativo existente. No modifica cobros, fiscalidad, impresión ni la cola de operaciones económicas.

El recorrido es `pos_restaurant_map → buildAssistSnapshot → AssistEngine → AssistIndicator`. La respuesta existente del mapa incluye la configuración del local y, cuando Assist está autorizado y activo, cantidades y fechas resumidas de las asignaciones de producción que pertenecen a líneas activas. No se descarga un histórico adicional.

La proyección conserva pedidos abiertos, su grupo, mesa/zona, apertura, actividad, comensales, número de líneas y cantidades pendientes/listas. Los grupos de pedidos divididos se evalúan juntos. Las comandas trasladadas utilizan el linaje actual de `production_line_allocations`; la fecha de envío procede del batch original.

El motor produce situaciones estructuradas y explicables con tipo, severidad, entidad, métricas, inicio, fin, expiración y feedback. Las mismas condiciones mantienen el episodio; al desaparecer se resuelven. No incorpora un LLM ni toma decisiones operativas.

## 2. Archivos principales

- `src/features/assist/types.ts`: contratos de configuración, estado y situaciones.
- `src/features/assist/snapshot.ts`: proyección del servicio activo, sin nombres de trabajadores ni datos fiscales.
- `src/features/assist/engine.ts`: reglas, agrupación, carga, deduplicación, resolución y cooldown.
- `src/features/assist/scheduler.ts`: debounce y ejecución diferida, con cancelación.
- `src/features/assist/AssistIndicator.tsx` y `AssistBoundary.tsx`: acceso único, panel, feedback y aislamiento de errores.
- `src/features/tables/service.ts`, `types.ts` y `restaurant/hooks/useRestaurantRealtime.ts`: integración con los datos y sincronización existentes.
- `src/lib/offlineStore.ts`: configuración autorizada y registros compactos de situaciones/feedback, aislados por ruta, tenant, venue, dispositivo y usuario.
- `src/features/platform/tenantFeatureAccess.ts`: módulo opcional, excluido de las habilitaciones implícitas de cachés antiguas.
- `src/features/crm/venues/pages/VenueSettingsPage.tsx` y `access/services/accessService.ts`: activación y sensibilidad por local.
- `src/services/platformService.ts` y `supabase/functions/manage-pos-users/index.ts`: versión del catálogo de Assist. El editor existente de superadmin obtiene su checkbox del catálogo compartido.
- `src/app/PosPage.tsx`: montaje condicional del indicador y límite de errores.
- `tests/tickit-assist*.test.mjs`: reglas, SQL/RLS, caché offline y ciclo de vida. El mock del servicio de mesas de `tests/cashlogy.test.mjs` se adapta a las nuevas dependencias.

## 3. Migración y permisos

`supabase/migrations/20261005225011_tickit_assist.sql` es una migración expand nueva, UTF-8 sin BOM. No cambia migraciones desplegadas ni consume contratos destructivos pendientes ajenos a Assist.

Añade:

- Feature `tickit_assist`, deshabilitada por defecto y sin asignarla a tenants existentes.
- `venues.tickit_assist_enabled`, por defecto `false`, y `tickit_assist_sensitivity`, por defecto `normal`.
- `tickit_assist_situations`: episodios y métricas resumidas. Índice único parcial para un episodio activo por tenant/local/clave; índices para historial acotado y búsquedas idempotentes de episodios.
- `tickit_assist_feedback`: respuesta por situación/usuario, con índice por tenant/local/fecha.
- RPC `set_tickit_assist_venue`, RPC `record_tickit_assist_events`, comprobaciones de acceso/activación y trigger que protege también cambios directos de configuración.

La habilitación del tenant usa `tenant_feature_assignments` y el mecanismo existente de superadmin: la Edge Function verifica superadmin y la RPC del catálogo sólo puede ejecutarse con `service_role`. Los clientes N-1 conservan Assist al guardar otros módulos; el cliente nuevo puede habilitarlo/deshabilitarlo explícitamente mediante el marcador de versión.

Owner puede configurar sus locales; manager sólo los que tenga asignados. Cashier no puede modificar la configuración. Los locales nuevos se crean con Assist desactivado y deben activarse después mediante la ruta autorizada.

Las dos tablas tienen RLS. Las lecturas de Assist requieren acceso al tenant/local y ambos niveles habilitados. No hay políticas de escritura directa; la RPC verifica nuevamente la activación, limita el lote a 64 eventos, deriva el usuario de `auth.uid()` y serializa episodios equivalentes. Las FK mantienen el vínculo venue/tenant. Deshabilitar conserva configuración individual e historial.

## 4. Detecciones

Estos son límites orientativos iniciales, no benchmarks históricos. `assistThresholds` es el punto donde sustituirlos por agregados compactos en V2.

| Detección | Regla con sensibilidad Normal |
|---|---|
| Mesa sin primera comanda | Grupo abierto al menos 12 min y sin líneas. No se infiere abandono de una mesa que tiene comida y está comiendo. |
| Elaboraciones listas sin servir | Cantidad lista pendiente de servir y al menos 8 min desde la última actualización relevante de readiness. Se agrupa por mesa/comanda. |
| Retraso de cocina | Cantidad pendiente no cancelada y más de 30 min desde el envío más antiguo pendiente. No hay una situación por producto. |
| Saturación | Al menos 18 unidades comerciales pendientes y edad media ponderada de al menos 18 min; alternativamente, crecimiento de al menos 6 unidades durante un mínimo de 2 min y una espera máxima de al menos 15 min. La tendencia conserva sólo 10 min. |
| Desequilibrio de zonas | Al menos dos zonas con actividad, diferencia de carga de al menos 10 puntos y carga máxima al menos 2,5 veces la mínima. La situación identifica la zona con mayor carga. |

Carga por grupo: `2 + min(comensales, 30)/2 + 3 si espera atención + 1 si tiene producción pendiente`. Se suman grupos activos por zona. No es productividad y no se atribuye a quien abrió la mesa: ese dato no garantiza la identidad del responsable actual.

Baja multiplica los límites por 1,5; Alta por 0,75. Los datos incompletos o fechas inválidas/futuras no justifican avisos de antigüedad. Comer, finalizar un servicio o esperar cocina no generan por sí solos una alerta de mesa desatendida.

Las mesas/retardos pasan a ACTION al duplicar el límite correspondiente. Saturación pasa a ACTION cuando su edad media alcanza el límite de preparación. ACTION puede mostrar una notificación de 8 segundos, con cooldown de 15 min por condición/dispositivo; no se repite por una condición persistente. El resto permanece en el panel. `Entendido` y `No es un problema` conservan feedback y suprimen notificaciones posteriores del mismo episodio.

## 5. Rendimiento

La proyección y las reglas cuestan O(pedidos/líneas/asignaciones activos). No se consultan ventas, tickets pagados ni estadísticas históricas. El mapa conserva su contrato anterior; sus selecciones de pedidos abiertos y carryovers están separadas con UNION ALL para aprovechar los índices parciales existentes de cada estado.

Los cambios se agrupan con debounce de 750 ms y se analizan mediante `requestIdleCallback`, con límite de espera de 5 s; en navegadores que no lo ofrecen se utiliza el timeout diferido. El análisis se pospone mientras el POS está ocupado y mientras la página está oculta. Una huella del estado relevante evita reevaluaciones por respuestas del mapa sin cambios; el reloj local permite detectar cruces de umbrales temporales.

Se persisten transiciones de situaciones, cambios de severidad y feedback; no snapshots continuos del restaurante ni métricas por minuto. La caché de episodios activos se escribe al cambiar situaciones/feedback. La cola secundaria admite 128 registros y el checkpoint 64 situaciones, con ventana máxima de 24 h. Su pérdida o saturación nunca modifica una venta.

## 6. Offline y ciclo de vida

La configuración usa la última respuesta autorizada del mapa y los módulos conocidos de la sesión. Sin configuración válida del contexto o sin habilitación conocida del tenant, no se monta Assist. La caché tiene versión y está aislada por ruta, tenant, venue, dispositivo y usuario.

Sin conexión el motor puede seguir usando el último estado operativo en memoria; el panel informa que puede estar desactualizado. Tras recargar offline se conserva configuración y registros de situaciones, pero no se restaura un snapshot del restaurante: se muestra que no hay mesas activas conocidas hasta recibir datos. Se respetan las limitaciones offline existentes de mesas/comandas; Assist no las sustituye.

Feedback/transiciones pueden quedar en la cola secundaria. Al reconectar no se envían hasta recibir una observación válida del mapa posterior a la reconexión y reciente (máximo 90 s). Además, el backend vuelve a verificar la habilitación antes de aceptar cada lote.

Una desactivación remota no llega a un dispositivo desconectado. Se aplica al sincronizar. Al desactivar o cambiar de contexto, se desmonta el componente, se cancelan timeout/idle/intervalo y se aborta el transporte pendiente; una respuesta tardía no actualiza ni vacía el estado anterior. La nueva instancia utiliza otra caché y otro motor. La configuración del local y el historial se conservan para una posterior rehabilitación.

## 7. Consultas, suscripciones y timers

- Lecturas de red propias adicionales: ninguna. Configuración y campos resumidos viajan en `pos_restaurant_map`, cuya invocación/suscripción ya existe.
- Configuración CRM: una llamada explícita a `set_tickit_assist_venue` al modificar activación o sensibilidad; se recargan los locales por el mecanismo existente.
- Persistencia: `record_tickit_assist_events` sólo si hay registros pendientes, conexión, estado reciente y POS libre; máximo un intento por minuto, hasta 64 registros por lote.
- Suscripciones Realtime/listeners propios: ninguno.
- Con Assist montado: un intervalo local de 60 s, un timeout de debounce y un callback idle cancelables; para notificaciones ACTION, un timeout de cierre de 8 s.
- Con Assist desactivado: no se monta el componente, no hay timers, transporte, situaciones ni suscripciones propios. La sincronización ordinaria del POS sigue funcionando.

## 8. Validación y limitaciones

Las pruebas ejecutan reglas reales, cancelación del scheduler, callbacks tardíos, priorización del POS, reconexión, caché por contexto y SQL en PGlite. Las pruebas SQL verifican combinaciones de activación, restricciones CRM/tenant, idempotencia, RLS, resolución, desactivación y compatibilidad N-1. Añadir 10.000 pedidos pagados no aumenta el payload operativo del mapa.

Verificación ejecutada: suite completa `pnpm test` con 663 pruebas correctas; `pnpm lint` sin errores y con cuatro avisos de hooks ya existentes fuera de Assist; `pnpm build` correcto. Las pruebas focalizadas de ciclo de vida también se repitieron tras el guard final para snapshots todavía desconocidos.

QA de navegador: Edge mediante Playwright del runtime compartido; el plugin Browser no está disponible. Se comprobaron la pantalla inicial, el indicador, apertura de panel y feedback offline en 1280×800 y 390×844, sin errores de ejecución ni desbordamiento móvil. La activación CRM y el mensaje de tenant no disponible se probaron a 1280×900 con el adaptador Supabase simulado, sin escribir datos reales. Las pruebas de navegador usan datos sintéticos; no acreditan un despliegue integrado en un tenant real.

Limitaciones V1:

- Assist se muestra en el POS que recibe el mapa de restaurante. Requiere ese flujo operativo; no añade un indicador separado al KDS.
- La carga se compara por zonas con actividad; no se infiere personal disponible ni responsables de mesas. Zonas vacías no se interpretan como capacidad libre.
- Las cantidades de cocina proceden del linaje de asignaciones y son unidades comerciales pendientes, no un coste estimado por cada elaboración/componente/destino. El timestamp de readiness es una aproximación conservadora a partir de la actualización de la asignación.
- Sin benchmarks, las reglas requieren calibración para cada servicio mediante sensibilidad/feedback.
- Las notificaciones son locales por dispositivo. Los episodios activos de base de datos se deduplican por tenant/local/clave; observaciones de distintos terminales son eventualmente consistentes.
- Si se cierra o apaga el dispositivo, puede no persistirse la resolución final. Los episodios huérfanos tienen expiración de 24 h y se cierran perezosamente cuando vuelve a registrarse su clave.
- Persistencia secundaria best effort: no ofrece la garantía de entrega de una operación económica; el límite de cola puede descartar registros antiguos.
- No se han aplicado migraciones ni desplegado la Edge Function a un proyecto Supabase real durante esta implementación.

## 9. V2 recomendada

1. Benchmarks agregados por local, destino, familia de elaboración y franja de servicio, actualizados incrementalmente.
2. Responsabilidad explícita por mesa y dotación por zona, si el producto las incorpora; conservar la distinción entre carga y rendimiento personal.
3. Coste operativo por elaboración/destino, sin duplicar el linaje de producción existente.
4. Retención y cierre de episodios huérfanos en backend, con tareas acotadas por índices y mayor coordinación entre terminales.
5. Lectura de episodios por intervalos/paginación para futuras consultas conversacionales. El LLM consultaría hechos ya detectados y no estaría dentro del motor.
6. Mediciones de latencia en iPad/PWA y una prueba de carga en staging con volumen real, antes de extender la activación.

## 10. Prueba manual y despliegue

Desplegar primero la migración por el pipeline habitual de migraciones seguras; después actualizar `manage-pos-users` y el frontend. No basta con publicar sólo el frontend: necesita las columnas nuevas y las RPC. Revisar el checklist del proyecto en `docs/safe-production-migrations.md`; los contratos destructivos pendientes se gestionan en su release contract correspondiente.

1. **Estado inicial:** entrar en superadmin y editar un tenant. En Módulos opcionales debe aparecer Tickit Assist sin marcar. En CRM → Configuración → desplegar un local, debe aparecer el mensaje de módulo no disponible. El POS no debe mostrar el indicador.
2. **Tenant:** marcar Tickit Assist en el editor del tenant y guardar. Esto no activa sus locales. Comprobar en CRM que aparece el control por local, inicialmente desactivado.
3. **Venue:** como owner o manager asignado, activar “Activar asistencia operativa en este local”. Elegir Baja, Normal o Alta. El guardado es inmediato. Comprobar que el resto de locales sigue desactivado. Para detectar cocina, activar/configurar el flujo de Producción/KDS existente y sus rutas.
4. **POS:** volver al POS del local y dejar que sincronice su mapa/configuración. Debe aparecer el icono de Tickit Assist en la barra superior: escudo verde cuando todo está normal, aviso ámbar cuando requiere atención y triángulo rojo cuando requiere actuar. Las incidencias activas se muestran en un contador; información usa un icono azul y, sin incidencias ni conexión, se muestra el icono de desconexión. Pulsarlo abre un desplegable anclado, que se cierra con Escape, al pulsar fuera o con su botón de cierre. Los cambios de tenant se reciben también mediante el refresco de módulos existente; no son instantáneos en todos los terminales.
5. **Mesa:** con sensibilidad Alta, abrir una mesa sin líneas y esperar 9 min. Debe aparecer una situación agrupada. Añadir la primera comanda: debe resolverse después de sincronizar y analizar. Una mesa con comida servida no debe recibir un aviso por simple inactividad.
6. **Cocina:** enviar una comanda a producción. Con Alta, una preparación pendiente supera el límite a partir de 22,5 min. Marcarla lista/cancelada: el retraso debe desaparecer. Dejar elaboraciones listas sin servir al menos 6 min prueba la segunda fase de atención a mesa. Servirlas resuelve esa condición.
7. **Saturación:** acumular trabajo pendiente con edad suficiente, no sólo cantidad. Probar que una cola nueva y grande no dispara saturación por sí sola. Vaciar la cola debe resolverla.
8. **Zonas:** abrir varios grupos de mesas/comensales en una zona y mantener otra con poca actividad. Debe aparecer una orientación sobre la carga de la zona; no hay rankings ni nombres de trabajadores.
9. **Feedback y cooldown:** abrir el panel, usar Entendido o No es un problema y comprobar “Respuesta guardada”. La misma situación conserva su episodio. Verificar que ACTION no reaparece continuamente ni al recargar dentro del checkpoint vigente.
10. **Desactivación:** desactivar el local desde CRM; al sincronizar desaparecen indicador y recursos propios. Reactivar y luego deshabilitar el tenant desde superadmin: todos sus locales quedan efectivamente inactivos, pero sus flags individuales se conservan. Rehabilitar el tenant respeta esos flags.
11. **Permisos:** intentar la RPC de configuración como cashier y como manager no asignado a ese venue: debe fallar. Intentar modificar el módulo del tenant desde CRM o ejecutar su RPC como authenticated: debe fallar. Intentar persistir feedback/situaciones de un local fuera del ámbito o con un nivel desactivado: debe fallar.
12. **Offline:** con configuración conocida, desconectar la red. El POS sigue operativo y Assist utiliza sólo los datos disponibles, indicando su posible antigüedad. Registrar feedback, reconectar y comprobar el envío después del mapa fresco. Repetir deshabilitando remotamente el tenant/local mientras el dispositivo está desconectado: no debe aceptar escrituras al volver a sincronizar.
13. **Contextos/caché:** cambiar de tenant, venue o usuario; no deben verse situaciones anteriores. En un contexto sin configuración cacheada, recargar offline: Assist debe permanecer desactivado.
14. **Rendimiento:** en DevTools Network, filtrar por `tickit_assist`. En reposo no deben aparecer lecturas/polling propios. Las escrituras deben corresponder a transiciones/feedback y estar limitadas. Desactivar el módulo y verificar ausencia de llamadas propias, dejando que la sincronización ordinaria del POS continúe.

Comandos de verificación: `pnpm lint`, `pnpm test`, `pnpm build`; focalizado: `node --test tests/tickit-assist*.test.mjs tests/tenant-feature-gating.test.mjs`.
