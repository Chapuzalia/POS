# Menús flexibles en comandas de mesa

El menú mantiene una única línea comercial y su precio acordado. Sus platos se gestionan por separado en los pases de producción existentes.

- Se puede guardar el menú sin elegir todos sus platos y completar las elecciones después.
- Cada plato conserva su pase, cantidad enviada, preparación, disponibilidad y servicio. Enviar o servir el primero no envía ni sirve el segundo o el postre.
- Cambiar o quitar un plato pendiente no afecta a los demás. Si ya estaba enviado, se anula únicamente su producción y se genera el aviso habitual para KDS/impresora; el sustituto queda pendiente de un nuevo envío.
- Un plato servido no se sustituye ni se reduce por debajo de sus unidades servidas. Las anotaciones de cocina afectan solo a platos enviados que todavía tienen servicio pendiente.
- Elegir después un componente incluido no añade precio. Se aplican los suplementos configurados de las opciones o modificadores nuevos; se conservan el precio base acordado y las selecciones que no cambian.
- Los menús añadidos desde la carta y con el botón `+` se guardan separados aunque coincidan inicialmente. Las líneas antiguas que ya agrupen varias unidades conservan esa cantidad: editar su selección afecta a esa línea completa. La división existente conserva las asignaciones y el servicio por componente.
- Las elecciones pendientes se muestran en el resumen del menú. Las unidades comerciales solo se completan automáticamente al servir todos sus platos y completar las elecciones obligatorias. Añadir una elección opcional posteriormente conserva los platos servidos y reabre el resumen de servicio.
- El panel muestra cada menú una sola vez: cabecera con su número y precio total, y una fila por plato. Las filas muestran elegir, enviar o servir según su estado; los platos servidos se indican con una marca. El servicio individual está disponible también sin producción activada.
- Los menús completados se contraen y se pueden desplegar con «Ver platos». Precio unitario, cantidad, edición y pases se consultan desde los detalles del menú. Los envíos conjuntos por pase se mantienen arriba; la selección manual y el servicio de toda la comanda quedan en «Más acciones».
- Los productos sueltos aparecen una sola vez en su pase asignado o en el predeterminado («Directo» si no hay configuración disponible). No hay un grupo adicional de «Pendientes». Pertenecer a un pase no implica tener destino de cocina: los productos sin destino se sirven directamente y quedan fuera de los envíos a producción.
- Se mantienen los límites de opciones, cantidades y modificadores. La venta rápida sigue exigiendo completar la selección. Las comandas de mesa siguen requiriendo conexión.

## Preparación y despliegue

Aplicar `20261024123435_flexible_restaurant_menu_courses.sql` antes de publicar el cliente. Es una expansión compatible que añade el contador de servicio por componente y una RPC de servicio; conserva las firmas de las RPC existentes, la comprobación de revisiones, la idempotencia de los envíos y la validación de acceso al local/dispositivo. No modifica tickets pagados ni las RPC de cobro/fiscalidad.

Los contratos pendientes de `supabase/contracts-pending.yml` corresponden a retiradas ajenas a esta funcionalidad. No se mezclan operaciones destructivas con esta expansión; siguen sujetos al baseline de producción y a la ventana de compatibilidad descritos en `safe-production-migrations.md`.

La migración no se ha aplicado a producción. El despliegue y la aplicación en producción requieren autorización explícita según `AGENTS.md`.

## Comprobaciones

`tests/restaurant-menu-courses.test.mjs` ejecuta la migración y las rutinas reales de guardado/producción en PostgreSQL local (PGlite), con casos de elecciones pendientes, precios, sustituciones, avisos, servicio independiente, límites, aislamiento, revisiones, menús idénticos y divisiones.

Comandos: `pnpm exec node --test tests/restaurant-menu-courses.test.mjs`, `pnpm test`, `pnpm lint`, `pnpm build`.
