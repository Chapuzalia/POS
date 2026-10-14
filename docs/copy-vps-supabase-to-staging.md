# Copiar Supabase del VPS de main a Cloud staging

El script `scripts/copy-vps-supabase-to-staging.mjs` se ejecuta desde tu equipo
(Windows/Linux/macOS) y conecta por SSH al contenedor de Postgres del VPS de
**producción/main**. No cambia nada en producción. La base de datos no tiene ramas
Git: configura el alias SSH y el contenedor que usa el despliegue de `main`.

Por defecto prepara el dump y comprueba su compatibilidad con Cloud sin modificar
staging. `--replace-staging REF` **reemplaza los datos y esquemas de staging**;
úsalo con los clientes, workers y despliegues de staging detenidos. No despliegues
migraciones en producción durante el dump. El origen puede seguir recibiendo
escrituras: un único `pg_dump` captura todos los esquemas en el mismo snapshot.

## Qué incluye

- `public` y `pos_private`: tablas, datos, secuencias, funciones, índices,
  constraints, triggers, RLS, policies y permisos. Las propiedades de ownership
  se adaptan al usuario `postgres` de Cloud; las ACL se conservan.
  Se omiten únicamente los `DEFAULT ACL` de `supabase_admin` en los esquemas de
  app, porque Cloud no permite al usuario `postgres` cambiar los defaults de ese
  rol gestionado. Se conservan los permisos explícitos de objetos y los defaults
  de `postgres`; la omisión queda registrada en `manifest.json`.
- **Todo `supabase_migrations`**, incluyendo `schema_migrations` con sus versiones,
  nombres y `statements`, y otras tablas del esquema si existen. Se exporta el
  historial realmente aplicado en el VPS, no los archivos del checkout local.
  El historial previo de staging se reemplaza, no se mezcla ni se marca como
  aplicado mediante `migration repair`.
- Datos de `auth` (usuarios, identidades, sesiones y demás tablas compatibles) y
  metadatos de `storage`, policies de ambos esquemas y triggers cuyo código está
  en `public`/`pos_private`. Mantiene los UUID de usuarios y las relaciones de app.
- Copia de todos los esquemas afectados de staging antes de modificarla:
  `backups/vps-to-staging-…/staging-before.dump`.

Mantiene la estructura gestionada por Cloud de `auth`/`storage` y sus historiales
internos (`auth.schema_migrations`, `storage.migrations`). Estos son distintos de
`supabase_migrations`: no deben sustituirse por los del self-hosted. Excluye los
datos de `storage.buckets_vectors` y `storage.vector_indexes`; la copia de Vector
Buckets requiere un procedimiento específico.

Las tablas de Analytics/Iceberg (`storage.buckets_analytics`,
`storage.iceberg_namespaces`, `storage.iceberg_tables`) tienen diferencias entre
self-hosted y Cloud. Se conservan las tablas, datos, policies y secuencias de Cloud.
El script inspecciona sus datos en el snapshot exportado: si están vacías, omite
su restauración; si contienen filas, se detiene para exigir una migración
específica, sin descartar esos datos silenciosamente. El dump original las incluye.

Un dump SQL **no contiene los archivos físicos de Storage**, Edge Functions,
secretos del proyecto, claves de Vault/column encryption, ni ajustes de
Auth/OAuth/SMTP. La metadata de Storage se copia, pero hay que transferir los
objetos físicos aparte para poder descargarlos. Las sesiones copiadas pueden no
funcionar con las claves JWT del proyecto de destino: inicia sesión de nuevo.
Tampoco copia los esquemas de extensiones (`cron`, `vault`, etc.), roles globales
o tablas de otros esquemas de aplicación. Habilita en Cloud las extensiones y
roles personalizados que necesite el esquema antes de restaurar; si faltan, la
restauración fallará y revertirá sus cambios. Revisa los integrations/URLs
copiados de producción antes de reactivar los workers de staging, especialmente
los servicios fiscales y hardware.

## Requisitos y configuración

1. Node 22+, cliente OpenSSH y herramientas `psql`, `pg_dump`, `pg_restore` de la
   misma versión mayor del Postgres Cloud de destino. El destino debe tener
   una versión mayor igual o superior al origen. Puedes indicar `PG_BIN_DIR` si
   tienes varias instalaciones.
2. SSH no interactivo con clave y host previamente comprobado en `known_hosts`.
   El usuario remoto necesita permiso para ejecutar `docker exec` (sin `sudo`
   interactivo). El contenedor debe tener `POSTGRES_PASSWORD` y las herramientas
   Postgres estándar.
3. Contraseña de **base de datos** de staging, no una API key. Desde el panel
   **Connect**, utiliza conexión directa o **Session pooler**, puerto **5432**.
   El transaction pooler (6543) no sirve para esta operación.

Crea en la raíz un archivo `.env.copy-staging.local` (ignorado por Git):

```dotenv
VPS_SSH_HOST=usuario@vps-produccion
VPS_DB_CONTAINER=supabase-db
VPS_DB_USER=supabase_admin
VPS_DB_NAME=postgres
# Opcional: clave SSH específica. También puedes usar tu alias de ~/.ssh/config.
# VPS_SSH_KEY=C:/Users/tu-usuario/.ssh/id_ed25519

STAGING_PROJECT_REF=abcdefghijklmnopqrst
STAGING_DB_HOST=aws-1-eu-west-1.pooler.supabase.com
STAGING_DB_USER=postgres.abcdefghijklmnopqrst
STAGING_DB_PORT=5432
STAGING_DB_PASSWORD="CONTRASEÑA_DE_BASE_DE_DATOS_STAGING"
# Alternativa a la contraseña: STAGING_PGPASSFILE=ruta/absoluta/a/pgpass
# Opcional Windows (ajusta la versión a la de Cloud):
# PG_BIN_DIR=C:/Program Files/PostgreSQL/17/bin
```

Sustituye el ref y el host por los valores reales de **staging**. Para conexión
directa: `STAGING_DB_HOST=db.REF.supabase.co` y `STAGING_DB_USER=postgres`.
El script rechaza destinos que no coincidan con el ref configurado, puertos
distintos de 5432 y una confirmación que no coincida con ese ref. Esta comprobación
no puede saber si has configurado por error el ref de un proyecto de producción:
comprueba el nombre del proyecto en el dashboard antes de ejecutarlo.

Las contraseñas se pasan a libpq por el entorno, no por argumentos ni URLs de
comandos. Guarda el archivo y los backups con permisos privados; contienen
datos reales y credenciales de usuarios. En Windows, usa una carpeta de usuario
con ACL restringida: los modos POSIX de Node no configuran ACL de Windows.

## Ejecutar

Primero exporta y comprueba sin cambiar staging:

```powershell
node --env-file=.env.copy-staging.local scripts/copy-vps-supabase-to-staging.mjs --dump-only
```

Para **reemplazar staging**, indicando explícitamente su ref:

```powershell
node --env-file=.env.copy-staging.local scripts/copy-vps-supabase-to-staging.mjs --replace-staging abcdefghijklmnopqrst
```

Cada ejecución obtiene un dump nuevo del VPS. Antes de reemplazar staging, guarda
su backup del alcance completo (`public`, `pos_private`, `supabase_migrations`,
`auth`, `storage`) y comprueba que puede leerlo. Borra/recrea los esquemas de app, vacía
las tablas gestionadas de datos y carga el snapshot en **una sola transacción**,
con `ON_ERROR_STOP`, límite de espera de bloqueos y un lock de coordinación. Si
falla cualquier sentencia o la comprobación de FK, se hace rollback, también del
historial de migraciones. Las FK ya validadas se comprueban con consultas de
integridad, porque la carga desactiva temporalmente triggers; no cambia las
policies RLS ni exige alterar las tablas gestionadas de Cloud.
Realinea las secuencias gestionadas con los IDs cargados. Si tiene ownership,
utiliza `ALTER SEQUENCE ... RESTART`, que es transaccional. Para secuencias de roles
gestionados de Cloud utiliza `nextval` con permiso `USAGE`, únicamente para avanzar
por encima de los IDs restaurados. Esos valores consumidos no se revierten: un
fallo posterior puede dejar huecos en la secuencia de Auth, pero los datos sí se
revierten y la secuencia nunca se reduce. No utiliza `setval` ni cambia las
secuencias históricas de ventas o facturas por esta vía.

Comprueba las versiones de Postgres y columnas gestionadas antes del reemplazo.
No intenta resolver diferencias de versiones de Auth/Storage eliminando columnas
o relajando constraints. Los errores de roles/extensiones/permisos quedan en
`commands.log` dentro de la carpeta de backups y abortan la restauración.

## Después de restaurar

El esquema e historial de staging quedan en el estado de **main**, por lo que
cualquier migración exclusiva de la rama `Staging` vuelve a quedar pendiente.
Revisa y aplica esas migraciones por el procedimiento habitual antes de ejecutar
una versión de la app que las necesite. No cambies ni reescribas migraciones
históricas; sigue [Migraciones seguras para producción](safe-production-migrations.md).

Verifica desde el SQL editor de **staging**:

```sql
SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version;
SELECT count(*) AS users FROM auth.users;
```

Compara las versiones con `manifest.json` del dump. Comprueba login, acceso por
tenant, un flujo de lectura del POS y publicaciones Realtime antes de reactivar
staging. Configura los archivos de Storage y las integraciones de pruebas que
necesites. No se despliega la app ni se ejecutan migraciones adicionales desde
este script.

Si la restauración falla, staging conserva sus datos anteriores por rollback.
`staging-before.dump` queda como copia adicional; no lo restaures entero encima
de Cloud con `--clean`, pues incluye esquemas gestionados. Para una recuperación
posterior tras una restauración completada, utiliza un procedimiento de restore
revisado por esquema o la recuperación de la plataforma. No hay una restauración
inversa automática en este script.

Referencias: [Backup y restore de Supabase](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore),
[migrar Postgres a Supabase](https://supabase.com/docs/guides/platform/migrating-to-supabase/postgres).
