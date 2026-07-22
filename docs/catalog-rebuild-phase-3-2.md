# Reconstrucción del catálogo — Fase 3.2

## Resultado

El CRM administra el modelo definitivo del catálogo. La carga se realiza una vez por local con `get_catalog(..., 'admin')`, las vistas trabajan con `CatalogData` y todas las mutaciones pasan por `CatalogCommandService`/`CatalogRepository`. No existen lecturas, escrituras ni doble escritura sobre el modelo legacy desde las pantallas migradas.

El TPV continúa usando temporalmente `catalog/compatibility/project-current-ui.ts`. Su retirada pertenece exclusivamente a la Fase 3.3.

## Pantallas

- **Productos**: búsqueda, filtros por estado/tipo/categoría/pestaña, productos internos, orden, precio o rango, IVA, variantes, apariciones y acciones de activación/eliminación.
- **Editor de producto**: alta rápida de estándar o menú; información común, imagen, IVA, estado, producto interno, variante inicial y aparición inicial. El modo avanzado administra variantes, aparición en TPV y asignaciones reutilizables.
- **Categorías y pestañas**: CRUD, activación, impacto antes de eliminar, orden global y asociaciones categoría–pestaña con orden propio.
- **Grupos de selección**: grupos reutilizables `menu_component`/`mixer`, opciones, suplementos positivos/cero/negativos, cantidades y orden.
- **Modificadores**: grupos, opciones, suplemento, valor predeterminado, activación y orden, como dominio definitivo separado.
- **Importar/exportar**: exportación mediante `export_catalog`; importación REVO convierte categorías, pestaña, relaciones, productos, variantes y apariciones a un único lote transaccional de comandos.

La terminología visible usa “variante” y “aparición en TPV”; los identificadores técnicos no se muestran al usuario.

## Flujo de datos y caché

`useCatalogAdmin` mantiene una carga administrativa por local, limpia el estado al cambiar de local e ignora respuestas obsoletas. `CatalogRepository` conserva el TTL y deduplica cargas concurrentes. Toda mutación invalida el local afectado antes de recargar; nunca reutiliza datos de otro local.

Los resúmenes de la tabla se construyen con mapas de variantes, apariciones, pestañas y categorías. Por tanto, la vista no ejecuta consultas N+1.

## Comandos y atomicidad

La migración `41.catalog-crm-commands.sql` añade únicamente contratos necesarios para el CRM:

- `catalog_command_batch`: bloquea el local y ejecuta hasta 5.000 comandos definitivos dentro de una sola transacción PostgreSQL.
- `catalog_tab_category_command`: guarda o elimina asociaciones categoría–pestaña con validación de pertenencia e impacto.
- `catalog_image_command`: registra, reemplaza o elimina metadatos de imagen y devuelve solo rutas realmente huérfanas.

El alta compuesta de producto crea producto, variantes y aparición en un solo lote. La importación completa también es atómica: cualquier error revierte el lote entero. Los reordenamientos se envían como una sola operación `reorder`.

## Imágenes

Se aceptan JPEG, PNG, WebP y AVIF de hasta 10 MB. El cliente corrige orientación durante la decodificación, redimensiona y convierte a WebP; el resultado optimizado no puede superar 1 MB. La ruta queda acotada a `tenant/local/products/producto/uuid.webp`, y el backend valida MIME, tamaño, hash SHA-256 y pertenencia del producto.

La eliminación física ocurre después de confirmar la mutación. Una ruta compartida no se borra mientras siga referenciada; si falla el registro de una subida nueva, el binario recién subido se limpia.

## Seguridad e integridad

- Todos los comandos exigen usuario administrador del local o `service_role`.
- El backend obtiene el tenant desde el local y no confía en identificadores de tenant enviados por el cliente.
- Productos, variantes, pestañas, categorías, apariciones, grupos y opciones se validan contra el mismo local.
- No se eliminan tablas legacy ni se introducen migraciones destructivas.
- Los componentes del CRM no importan Supabase; el único acceso directo del servicio administrativo es al bucket para transferir binarios.

## Compatibilidad e importación

La importación REVO normaliza nombres para reutilizar categorías y productos existentes. En productos existentes actualiza estado y variantes coincidentes; crea las variantes que falten y evita duplicar apariciones. Categorías nuevas, relaciones y productos se incluyen en el mismo lote definitivo. No crea formatos de venta ni escribe columnas o tablas legacy.

## Verificación

La cobertura añadida comprueba resúmenes sin N+1, filtros, invariantes de variantes y capacidades de selección, lote atómico, reordenamiento determinista, proyección temporal del TPV y ausencia de accesos legacy. La fixture SQL ejecuta y revierte un catálogo representativo con menú, dos variantes, aparición fijada, producto interno, grupo, suplemento negativo, asignación por variante e imagen compartida.

La interfaz se verificó en escritorio y en un viewport móvil de 390 × 844: sin desbordamiento global ni errores/warnings de consola. La sesión real suministrada ya estaba activa en otro dispositivo; no se forzó su desconexión para evitar pérdida de cambios.

## Decisiones de alcance

- No se introduce un sistema i18n parcial: el CRM actual usa literales en español y se mantiene ese patrón. La futura internacionalización debe abordar el CRM completo.
- No se ofrece duplicado de producto en esta fase: copiar de forma segura imágenes y relaciones reutilizables requiere una política explícita y no es necesario para completar el CRUD solicitado.
- Los borrados con relaciones activas se bloquean o muestran impacto; no se realizan cascadas silenciosas desde la interfaz.

## Pendiente exacto para la Fase 3.3

1. Migrar el TPV para consumir directamente `CatalogData` en modo `pos`.
2. Sustituir tipos históricos usados por vistas y líneas del TPV.
3. Retirar `project-current-ui.ts` y los servicios que dependan de su proyección.
4. Verificar el flujo completo de venta, menús, mixers y modificadores sobre el contrato definitivo.
5. Solo después de esa migración, evaluar la retirada de tablas/columnas legacy mediante una fase destructiva separada.

## Componentes y formularios

- `CatalogProductsCrm` concentra lista, filtros, impacto y apertura del editor.
- `CatalogProductEditor` comparte el alta simple y la edición avanzada de variantes, apariciones y asignaciones.
- `CatalogStructureCrm` gestiona categorías, pestañas y sus relaciones.
- `CatalogGroupsCrm` reutiliza el mismo patrón para Selection Groups y modifiers sin confundir ambos dominios.
- `CatalogTransferCrm` expone importación y exportación definitivas.
- `useCatalogAdmin` contiene el ciclo de carga por local; `catalogAdminModel` mantiene reglas puras y resúmenes; `catalogAdminService` es la única fachada de mutación del CRM.

Los límites mínimo/máximo y el carácter obligatorio viven en la asignación, no en el grupo, tal como define el esquema final. La pantalla muestra los valores derivados y permite configurarlos al asignar el grupo a un producto o variante.

## Legacy eliminado del CRM

Se eliminaron `ProductForm`, `CategoryForm`, `productFormModel`, `ProductsPage`, `CategoriesPage`, `SaleFormatsPage`, `CatalogOrganizationPage`, `ComplementsPage`, `CatalogImportPage`, `catalogService` y `catalogImportService`. Con ellos desaparecen del CRM los accesos directos a `sale_formats`, las relaciones transitorias de mixers y las escrituras directas a tablas de catálogo.

Permanecen para 3.3 el adaptador `project-current-ui.ts`, `load-current-catalog.ts`, los tipos históricos que consume el TPV y las tablas/columnas legacy aún necesarias para proyectar la interfaz de venta actual.

## Riesgos y pasos manuales

- Aplicar `supabase/41.catalog-crm-commands.sql` en cada entorno antes de desplegar el frontend.
- Verificar que el bucket de catálogo mantiene las políticas de Storage de las fases anteriores para rutas con tenant y local.
- Hacer una prueba de aceptación con una cuenta administradora sin desplazar una sesión de caja activa.
- El bundle conserva el aviso genérico de Vite por superar 500 kB; esta fase lo reduce respecto a la referencia previa y no introduce crecimiento desproporcionado.
- La limpieza física de esquema y la retirada del adaptador quedan prohibidas hasta completar 3.3.