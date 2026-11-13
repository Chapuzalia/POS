# Tickit POS: Data Act y exportación de datos

Revisión de 13/11/2026. Cambios preparados en local. No se han desplegado ni aplicado migraciones remotas, cancelado suscripciones o eliminado datos.

## Conclusión y alcance

Tickit POS se ofrece como SaaS estándar, multicliente y configurable, no como desarrollo exclusivo para un cliente. La aplicación del capítulo VI es la conclusión jurídica de esta revisión a partir de esa operativa y de la definición del artículo 2.8. El régimen se aplica desde el 12/09/2025; no empieza en enero de 2027. Esa última fecha corresponde a la eliminación de cargos por cambio. No existe una exención general por ser pyme, SaaS, B2B o tener una suscripción anual.

Se conservan la estructura contractual, los precios por Oferta, el plazo acordado de seis meses, el soporte en horario laborable y la política de no reembolso con sus excepciones y límites imperativos. No se añade una tarifa, una penalización ni un producto comercial de migración. El equipo de Alteil Solutions, S.L. atiende la asistencia razonable por el canal ya existente; no es necesario crear un departamento o ejecutar toda la implantación en el destino.

Alteil ha confirmado en esta revisión el alojamiento propio en Francia y Dinamarca y la atención por su equipo a través de info@alteilsolutions.com. Esa confirmación no verifica por sí sola ubicaciones y jurisdicciones de todos los subproveedores ni sus contratos.

## Contraste de los artículos 23–31

| Norma | Aplicación y corrección |
| --- | --- |
| 23 | Eliminar obstáculos al cambio a otro servicio del mismo tipo o infraestructura local. La baja ordinaria en la renovación no puede ser la única salida. CG 8.1, 10.2 y 11.5–11.15. |
| 24 | Obligaciones relativas al servicio, contratos y prácticas de Alteil; no se promete reconstruir otro POS ni controlar al proveedor de destino. |
| 25.1–2 | Contrato descargable antes de aceptar; categorías exportables/excluidas, asistencia, continuidad, seguridad, preaviso, transición, extracción, resolución y costes expresos en CG 11. Nuevas versiones y huellas; originales de 12/11 intactos. |
| 25.2.d y 25.4–5 | Preaviso máximo de dos meses. Transición ordinaria hasta treinta días naturales; inviabilidad técnica motivada en catorce días hábiles desde la solicitud, con alternativa limitada en las CG a siete meses desde la solicitud, siguiendo la referencia de las CCE. Prórroga única a elección del Cliente, sin inventar un límite adicional unilateral. |
| 25.2.c/g/h y 25.3 | Resolución al éxito del cambio o al fin del preaviso si se elige supresión sin traslado. Notificación escrita. Extracción durante los seis meses ya acordados y nunca menos de treinta días naturales tras expirar la transición prorrogada. Supresión posterior, preservando la elección del responsable y la conservación legal delimitada. |
| 26 | Registro público `/legal/portabilidad.html`, diccionario de campos, API documentada, formatos y límites. Las exportaciones contables parciales no se presentan como una extracción completa. |
| 27 | Cooperación de buena fe de Alteil, Cliente y destino; estrategia de salida, comprobación de integridad y conciliación final. |
| 28 | Sección pública enlazada desde CG: jurisdicción propia confirmada y medidas técnicas, organizativas y contractuales frente a accesos/transferencias de autoridades extranjeras contrarios al Derecho aplicable. No se identifica «alojamiento EEE» con ausencia de transferencias de terceros. Ver límites pendientes abajo. |
| 29 | Hasta 11/01/2027: únicamente costes reducidos informados antes de contratar y pactados en Oferta, limitados al coste directo soportado; en ausencia de pacto, no se cobran. Interfaces gratuitas ya. Desde 12/01/2027: ningún cargo por el proceso de cambio, tampoco bajo otro nombre. Cuotas y resolución anticipada válidamente pactadas son conceptos distintos. |
| 30.1–6 | Tickit es SaaS, no IaaS: interfaces abiertas gratuitas e información técnica suficiente, salida estructurada y lectura mecánica. No se promete equivalencia funcional ni nuevas tecnologías. El registro deberá actualizarse cuando sean exigibles especificaciones/normas publicadas, respetando los doce meses del apartado 3; no se declara conformidad con una norma armonizada sin identificarla y verificarla. |
| 31.1 | Excepción parcial para servicios genuinamente a medida no comercializados a escala: solo alcanza art. 23.d, 29 y 30.1/3. No excluye todo el capítulo y no se invoca para Tickit estándar. |
| 31.2–3 | La exención del capítulo para pruebas requiere versión no productiva, evaluación y plazo limitado, con información previa. Llamar «demo» al sistema con ventas reales no basta. |

Referencia contractual: Recomendación (UE) 2026/2394 de 29/10/2026, publicada el 06/11/2026, anexos VI (cambio y salida), VII (resolución) y VIII (seguridad y continuidad). Se han adaptado sus temas y mecanismos, sin incorporar en bloque sus opciones ni nuevas obligaciones comerciales. La iniciativa de noviembre de 2025 no se ha tratado como la versión definitiva más reciente.

El Digital Omnibus COM(2025)837 es una propuesta: el Consejo comunicó su posición negociadora el 21/10/2026. No se han utilizado las exenciones propuestas como si fueran Derecho aplicable.

## Qué existía y qué se implementa

Antes de este cambio estaban disponibles:

- Catálogo por local: JSON v4 con imágenes Base64 y referencias portables; no era una copia de toda la empresa.
- Tickets y cierres para gestoría: CSV/XLS/XLSX, por local, fechas y filtros; agregados contables, sin todo el detalle relacional.
- Compras: originales y resumen CSV dentro de ZIP; no todas las líneas, inventario o resultados propios de OCR.
- Mi plan: justificantes y documentos contractuales/facturas SaaS disponibles. Son independientes de la contabilidad del restaurante.

La nueva descarga abarca las colecciones permitidas que existen en el esquema instalado y está en Documentación y en Mi plan, incluida la vista nativa que limita la gestión comercial a la web. Solo se muestra al propietario. El servidor vuelve a verificar la propiedad activa de esa empresa en cada página, independientemente del estado de pago o de los addons. No otorga ese acceso al gerente, cajero, gestor o superadmin que no sea propietario de la empresa.

La migración `20261113151204_tenant_data_export.sql` añade una RPC de lectura, catálogo explícito de campos y autorización de lectura de originales de la empresa para exportación. No cambia funciones de ventas, pagos, fiscalidad, suscripciones o sincronización ni concede escrituras. El acceso a originales comprueba además bucket, ruta de empresa y registro propietario; no basta que alguien introduzca una ruta de otra empresa en sus metadatos.

La lista de campos es cerrada: nuevos campos no se exportan automáticamente. Se conservan relaciones, identidades necesarias para conciliación, instantáneas históricas y evidencias fiscales. Los datos numéricos de tipos numeric/bigint se transportan como texto decimal; los JSON históricos viajan como texto JSON desde PostgreSQL y se guardan sin volver a serializarlos con números JavaScript. Las imágenes/documentos disponibles se incluyen con bytes originales, rutas locales y SHA-256. Si falta un original, se conserva su referencia `attachment` sin crear el fichero y se anota en `missingFiles` de `manifest.json`, con colección, identificador, referencia local y motivo (`not_found` o `missing_reference`). Se reconoce también el HTTP 400 de Storage cuyo cuerpo indica `statusCode: 404`. Los errores de permisos, red, servidor y las huellas discordantes siguen abortando el ZIP.

El paquete incluye manifiesto, esquema y NDJSON por partes de hasta 500 registros; las colecciones se recorren hasta una página vacía. Las consultas usan cursores de clave primaria con sus tipos nativos, incluidos los compuestos. El manifiesto documenta lecturas en momentos distintos, exclusiones y fechas. Las rutas privadas de almacenamiento se usan para descargar y se omiten del archivo final.

### Evolución del esquema SQL

La migración `20261113212616_resilient_tenant_data_export.sql` corrige las referencias a las tablas de inventario retiradas por Inventario V2 sin reescribir migraciones desplegadas. Cada lectura cruza la lista autorizada con el catálogo real de PostgreSQL. Las tablas y columnas ausentes se omiten y se registran en `schemaChanges` de `schema.json` y `manifest.json`; los tipos y las claves primarias se obtienen del esquema actual. Las columnas `INCLUDE` de un índice no forman parte del cursor.

Cada colección publica un `schemaToken` que también devuelve cada página. El cliente aborta si los campos, tipos o claves cambian entre el índice y las páginas; no guarda un ZIP con formatos mezclados. La firma y el formato principal del RPC se mantienen para clientes N-1. Si faltan la clave primaria, las columnas necesarias para aislar la empresa o las referencias necesarias para descargar originales, la extracción falla explícitamente en vez de omitir esas garantías.

Una columna o tabla nueva no se añade automáticamente, pues puede contener secretos o datos internos. Los cambios de nombre aparecen como elementos ausentes y no se adivina qué campo nuevo los sustituye. Añadir categorías exportables o cambiar su significado sigue requiriendo revisar la lista autorizada y el diccionario público; esta adaptación evita que una retirada o un cambio de tipo ordinarios bloqueen toda la extracción, pero no garantiza la cobertura semántica de cualquier rediseño SQL. El diccionario público describe el catálogo permitido; `schema.json` describe la entrega efectiva.

La fixture de integración respeta los `DROP TABLE` de las migraciones, incluidas las dos tablas de inventario retiradas. Las regresiones cubren sus ausencias, retirada y renombrado de campos, cambios de tipo y clave, columnas nuevas privadas, cursores y cambios de esquema entre peticiones. Esta fixture sigue siendo un esquema reducido para probar el RPC; no sustituye aplicar todas las migraciones de Supabase en un entorno de integración.

Los resultados propios de OCR se conservan sin metadatos internos del proveedor. Las reglas globales de reconocimiento, credenciales, emparejamientos, sesiones, telemetría interna, bloqueos, reintentos y orquestación no se exportan. El histórico de cambios de catálogo filtra sus objetos antes/después con la misma lista permitida; una columna secreta futura no se filtra por esa vía. No se entregan tablas de cobro y precios internos de Alteil; los documentos del Cliente de ese circuito siguen accesibles desde Mi plan.

Se incluye la configuración de impresoras persistida en el servidor, sin secretos ni emparejamientos de agentes, y los avisos operativos de Tickit Assist con métricas del negocio y respuestas de usuarios. Son configuración y datos propios del Cliente, distintos de reglas internas o algoritmos del proveedor.

Las imágenes de documentos de compras se normalizan a WebP en la carga existente. Su `file_hash` identifica los bytes de entrada anteriores a esa conversión y no se utiliza como checksum del WebP conservado. Se conserva como metadato de entrada; el manifiesto calcula separadamente la huella de los bytes descargados. Las imágenes de catálogo sí se comparan con su SHA-256 de almacenamiento cuando está disponible. Se exporta el fichero documental que el servicio conserva, sin prometer recuperar versiones previas a la conversión que no se almacenan.

`supabase/contracts-pending.yml` y la guía de migraciones seguras se han revisado. Sus tres retiradas pendientes son ajenas a esta ampliación. Que una ampliación esté en main no acredita su aplicación real ni la retirada de todos los clientes N-1: no se consumen contratos destructivos en esta migración. Las tablas fiscales heredadas se exportan si aún existen.

## Límites operativos pendientes de comprobar al publicar

- **Coherencia de corte:** las lecturas no forman una instantánea transaccional única. No bloquean ventas; mientras haya cambios debe conciliarse el destino y repetirse la extracción final. Primero deben sincronizarse las colas de todos los dispositivos. Una exportación web no puede recuperar datos exclusivamente locales de un TPV desconectado.
- **Volumen:** el ZIP se prepara en memoria del navegador. Debe probarse en staging con un volumen representativo; para archivos que superen su capacidad, Alteil debe proporcionar otra entrega segura. No hay evidencia de una prueba de carga sobre el tamaño real de producción.
- **Ciclo contractual:** la descarga no ordena la baja, determina el éxito del cambio ni borra datos. Alteil debe tramitar y documentar manualmente recepción, calendario, prórrogas, asistencia, continuidad, resolución y recuperación. No se ha creado un CRM adicional de solicitudes ni un servicio de migración integral.
- **Borrado y copias:** no se ha programado una purga automática de datos fiscales/ventas. Debe documentarse por expediente la instrucción del responsable, la fecha de extracción, la conservación legal, el bloqueo y la eliminación/expiración de backups con fecha y reaplicación de supresiones tras una restauración. El deber del cliente de conservar facturas no equivale a un permiso ilimitado de Alteil para retenerlas.
- **Transparencia de terceros:** completar con evidencia contractual las jurisdicciones, accesos y medidas de Cloudflare/Sentry y cualquier otro proveedor real. La localización propia confirmada no sustituye ese inventario. El registro expresa medidas contractuales; debe verificarse su ejecución operativa. No se certifica cumplimiento integral del art. 28 solo por publicar la página.
- **Ofertas individuales:** comprobar las cláusulas concretas de permanencia/subvención y liquidación anual. No existe una aprobación universal de toda penalización o retención anual por llamarla no reembolso; han de ser claras, proporcionadas y no obstaculizar el cambio. Estas CG no añaden penalizaciones ni vencimiento anticipado de cuotas futuras.
- **Publicación:** desplegar conjuntamente migración, frontend y documentos versionados; mantener las URLs anteriores, actualizar/avisar a los clientes vigentes conforme al contrato y conservar la evidencia. Hace falta autorización expresa para cualquier actuación en producción. El cambio de versión legal exige que clientes que inicien una nueva contratación usen el formulario actualizado; no altera suscripciones/pagos ya en curso.

## Verificación

Los tests nuevos ejecutan la RPC real sobre PostgreSQL embebido (PGlite), con columnas y tipos procedentes del DDL del repositorio. Comprueban todos los conjuntos, permisos por rol/empresa, precisión, registros históricos de usuarios sin membresía actual, más de 1000 ventas, claves compuestas, cursores inválidos, revocación y rutas de ficheros falsificadas. El servicio de archivo se comprueba con ZIP descomprimido y huellas calculadas independientemente, errores de red/originales y preservación de números JSON anidados.

La fixture aísla las tablas y permisos que necesita la RPC; no reproduce todo el servidor Supabase, PostgREST ni sus límites de infraestructura. No se ha ejecutado una descarga sobre producción ni se han inspeccionado sus secretos o documentos personales.

Resultado final ejecutado:

- `pnpm test`: 655 pruebas funcionales y 236 heredadas aprobadas.
- `pnpm lint`: aprobado; tres avisos preexistentes en NativeBillingNotice, useRestaurantController y CrmPage.
- `pnpm build`: aprobado, incluida la comprobación TypeScript de la API y del frontend. Sin token de Sentry no se ha creado release ni subido mapas de fuentes.
- `analyzeMigration()` del checker del repositorio: sin hallazgos para la migración nueva. `git diff --check`: sin errores. Enlaces públicos, huellas activas y conservación de las huellas anteriores comprobados.

## Fuentes oficiales consultadas

- [Reglamento (UE) 2023/2854, especialmente arts. 2, 23–32 y 50, y considerandos 82–99](https://www.boe.es/doue/2023/2854/L00001-00071.pdf).
- [Comisión: explicación del Data Act y su capítulo VI](https://digital-strategy.ec.europa.eu/en/factpages/data-act-explained).
- [Recomendación (UE) 2026/2394 y sus anexos VI–VIII](https://www.boe.es/doue/2026/2394/L00001-00127.pdf).
- [Comisión: modelos y cláusulas contractuales, página actualizada el 11/11/2026](https://digital-strategy.ec.europa.eu/en/library/recommendation-non-binding-model-contractual-terms-data-access-and-use-and-non-binding-standard).
- [Consejo, 21/10/2026: posición negociadora sobre Digital Omnibus](https://www.consilium.europa.eu/en/press/press-releases/2026/10/21/digital-rulebook-council-agrees-position-to-simplify-data-protection-privacy-and-cyber-reporting-rules/).
- [Comisión: estudio de interoperabilidad y mecanismo de publicación/adaptación de normas, 23/02/2026](https://digital-strategy.ec.europa.eu/en/library/results-study-interoperability-data-processing-services).
- [RGPD, art. 28.3.g y seguridad del tratamiento](https://www.boe.es/doue/2016/119/L00001-00088.pdf).
- [LOPDGDD, arts. 32 y 33](https://www.boe.es/eli/es/lo/2018/12/05/3/con#a33).
