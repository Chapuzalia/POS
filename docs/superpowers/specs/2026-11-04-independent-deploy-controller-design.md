# Controller independiente para varios proyectos

Estado: aprobado por el usuario el 2026-11-04 e implementado localmente. No modifica producción.

## Intención y decisiones

Extraer el controller de Tickit POS a un repositorio independiente. Una única
instancia en Coolify administrará varios proyectos con frontend y Supabase
autoalojado en Coolify. Cada aplicación conservará únicamente su integración
cliente de GitHub Actions. El controller podrá construirse, probarse y arrancar
sin el checkout, las dependencias ni los servicios de POS.

El usuario eligió una instancia para varios proyectos. Se consideró una
instancia por proyecto: permite reutilizar más código sin cambiar el modelo de
estado, pero no satisface la gestión centralizada solicitada. No se añadirá un
panel web, despliegue paralelo, extensiones ejecutables ni soporte de proveedores
distintos de los actuales.

Decisiones propuestas por el implementador: conservar una cola global serial,
los entornos lógicos `production` y `staging` y el flujo de aprobación existente.
Las ramas y los archivos de workflow serán configurables por entorno.

## Configuración y autenticación

La configuración privada del controller tendrá una audiencia HTTPS y un mapa
`projects`, indexado por un identificador estable y validado, por ejemplo
`tickit-pos`. Cada entrada declarará:

- Nombre visible, repositorio GitHub `owner/repo` e ID numérico inmutable.
- Credencial Git de solo lectura y sus archivos privados por proyecto.
- Por entorno: activación, rama, workflow permitido, eventos admitidos,
  credenciales de acceso, frontend de Coolify, health URL y política de PWA.
- Por entorno: proyecto y red de Supabase, guarda de historial, política de
  migraciones, inicialización explícita y parámetros existentes del receptor.
- Destino de Telegram por proyecto; el bot compartido será un secreto de runtime.

El token de Coolify, las claves Git y el bot nunca se guardarán en el repositorio
ni se copiarán al servicio API. La configuración se validará completa antes de
iniciar el worker. No se permitirán destinos de frontend o Supabase compartidos
accidentalmente entre proyectos o entornos, ni credenciales de acceso reutilizadas
entre destinos. No se configurarán comandos arbitrarios.

`POST /deploy` exigirá `{project, environment, commit, request_id}`. La selección
del proyecto solo localizará una política: la autorización seguirá exigiendo
firma, audiencia, repositorio e ID, rama, workflow y SHA exactos de GitHub OIDC,
además de las credenciales del destino. Consultar una operación exigirá la misma
identidad de proyecto, entorno, commit y ejecución. Un proyecto no podrá enviar,
consultar ni reconciliar operaciones de otro mediante la API.

La audiencia, URL de origen Git y ramas dejarán de contener valores implícitos
de POS. El código instalado seguirá siendo de confianza: nunca ejecutará los
scripts descargados del repositorio que se va a desplegar.

## Cola, estado y recursos

SQLite incluirá el proyecto en solicitudes, idempotencia, vinculación de tokens,
bloqueos y versiones compatibles. Fallar en `proyecto A/production` bloqueará
solo ese destino; no bloqueará `proyecto B/production`. Un despliegue activo,
incluida la espera de Telegram, ocupará la cola global hasta terminar o caducar.

Cada proyecto tendrá su mirror Git y clave. Historiales SQL, directorios de
backups, logs del receptor y configuración privada se separarán por proyecto y
entorno. La retención no podrá seleccionar copias de otro destino. Se conservará
el bloqueo global del host para evitar dos workers concurrentes sobre Docker.

Telegram mostrará proyecto, entorno, migración y motivos de riesgo, con enlace
al repositorio correcto. Se mantendrán los botones Desplegar/Cancelar, validación
de pertenencia al grupo, nonce y mensaje exactos, caducidad y aprobación por
contenido. Habrá un único consumidor del bot; la cola serial evita consumidores
simultáneos. Se documentará que el bot debe dedicarse a esta instancia.

## Contrato de los proyectos compatibles

La primera versión mantendrá el contrato que el código actual puede verificar:

- Frontend GitHub desplegado en Coolify mediante Railpack, auto-deploy desactivado,
  versión de build igual al SHA solicitado y endpoint HTTPS `/app-version.json`
  con `currentVersion` y `supportedVersions`. Se entregará un ejemplo mínimo
  independiente de Vite/React/POS para producir ese archivo en el build.
- Supabase autoalojado en el mismo host administrado por el worker, con los
  recursos Docker declarados y las comprobaciones existentes. No incluye
  Supabase Cloud ni hosts remotos nuevos.
- Migraciones en `supabase/migrations/` con el formato actual, un historial
  existente o inicialización vacía explícitamente autorizada y limitada en tiempo.
- Edge Functions bajo `supabase/functions/`, import map y `supabase/config.toml`
  con las opciones admitidas por el router existente. Se probará también un
  proyecto sin Edge Functions para que el frontend y las migraciones no dependan
  de tener funciones desplegadas. La ausencia debe ser explícita en la política:
  no se interpretará como orden de borrar funciones existentes.

No bastará con renombrar archivos. La preparación de migraciones actual exige
una migración de POS y transforma dos archivos históricos. La preparación
genérica no exigirá esos archivos ni reescribirá SQL arbitrario. La configuración
de POS conservará reglas de compatibilidad explícitas, limitadas a sus archivos
y contenido revisado, para producir los mismos bytes preparados e historiales
que el controller anterior. El BOM seguirá normalizándose en la copia temporal.
Las excepciones históricas de POS no se aplicarán a otros proyectos.

Las limitaciones del frontend, formatos SQL y router se documentarán como contrato
de compatibilidad; no se prometerá soporte para cualquier stack sin esos requisitos.

## Extracción y entrega

El repositorio nuevo contendrá código del controller, scripts de despliegue y
seguridad requeridos, Dockerfile/Compose, cliente de ejemplo, configuración de
ejemplo sin recursos reales, documentación y sus tests. Tendrá package.json,
lockfile y comandos de verificación propios. No dependerá de archivos del padre,
del workspace pnpm de POS ni de su suite de negocio.

Se preparará primero en una carpeta de entrega dentro del workspace autorizado,
con nombre provisional `deploy-controller`, para poder verificarlo de forma
independiente. La ubicación definitiva y el remoto GitHub se acordarán antes de
publicarlo. Esta preparación no creará ni publicará un repositorio remoto.

Una vez verificada la extracción, POS conservará su workflow y un cliente mínimo
adaptado al campo `project`. Se retirarán de POS el runtime, imagen, Compose y
tests que pasen a pertenecer exclusivamente al repositorio nuevo. Los helpers
usados por otras comprobaciones de POS se mantendrán allí cuando sean necesarios.
No se usará un submódulo ni una dependencia de runtime de POS hacia el controller.

## Transición del controller instalado

La entrega incluirá una ruta de importación explícita de la instalación antigua
hacia `tickit-pos`, probada con datos sintéticos. El operador indicará el ID
destino: no habrá reasignación automática a partir del primer proyecto configurado.

Se conservarán IDs, estados, idempotencia, reconciliaciones, versiones PWA,
historiales de hashes SQL, logs y backups. La importación rechazará conflictos y
datos de origen desconocidos, conservará los originales y producirá un resumen
de lo trasladado. No se copiarán operaciones de proyectos distintos al destino.
Los backups antiguos seguirán accesibles y excluidos de borrados automáticos.

El procedimiento de corte será: impedir nuevas solicitudes, comprobar que no
hay operación activa, detener el worker antiguo, guardar una copia consistente
del estado y aplicar la importación antes de habilitar el nuevo. No funcionarán
ambos controllers desplegando simultáneamente. Se comprobará primero en local
y staging. La activación, cambios de Coolify/Tunnel/secretos y cualquier operación
de producción requerirán aprobación explícita aparte.

No cambia la política de recuperación de SQL: se conserva backup previo y
verificación de migraciones aplicadas; no se añade un rollback destructivo
automático que pueda perder ventas nuevas.

## Comprobaciones de aceptación

- Construir y ejecutar checks del nuevo proyecto sin acceso al código padre de POS.
- Probar dos repositorios ficticios con iguales nombres de entorno y request ID:
  credenciales, tokens, consultas, historial SQL, PWA y backups quedan separados.
- Rechazar identidad cruzada, configuración con destinos duplicados, SHA incorrecto
  y rutas inválidas sin iniciar mutaciones.
- Confirmar que un fallo bloquea solo su destino y que la espera/cancelación de
  Telegram mantiene las garantías existentes y el proyecto correcto en el mensaje.
- Probar un proyecto sin las migraciones históricas de POS y otro sin Edge Functions.
- Probar importación del estado anterior, conflictos y conservación de bloqueos,
  hashes preparados y versiones compatibles.
- Ejecutar tests y lint propios, validar Compose y comprobar el cliente de POS;
  ejecutar la suite relevante de POS tras retirar sus dependencias del controller.
- No enviar mensajes reales, aplicar SQL ni desplegar durante la preparación local.

## Pendiente de concretar

Destino elegido por el usuario: carpeta `deploy-controller` junto a POS, con
repositorio Git local propio. Remoto GitHub pendiente; no se ha publicado nada.
Los nombres internos,
estructura de carpetas y formato exacto de importación quedan al implementador,
respetando este contrato y reutilizando el código y tests existentes.
