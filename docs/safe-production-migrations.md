# Migraciones seguras para producción

## Regla principal

Cada release debe mantener compatibilidad N-1: durante el despliegue pueden seguir activos clientes de la versión anterior. Las migraciones ya desplegadas son inmutables; cualquier corrección requiere una migración nueva.

El checker de PR compara `baseSha` (SHA base del PR) con `headSha` (merge de prueba del PR). Esta comparación revisa código; no acredita qué versión está desplegada. Solo acepta migraciones añadidas, rechaza versiones/timestamps duplicados y no permite modificar, renombrar ni eliminar migraciones existentes, salvo la retirada exacta de `CONCURRENTLY` de los cinco índices históricos identificados en la sección de compatibilidad del pipeline.

## Expand

Una migración expand debe empezar exactamente así, sin líneas previas:

```sql
-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
```

Expand añade estructura compatible sin retirar ni cambiar el contrato anterior. Ejemplos habituales:

- tablas o columnas nullable nuevas;
- índices con `CREATE INDEX`, compatible con la ejecución transaccional de la CLI;
- FK y `CHECK` iniciales con `NOT VALID`;
- `UNIQUE`/`PRIMARY KEY` sobre tablas existentes mediante índice único concurrente y `USING INDEX`;
- RPC nuevas manteniendo las anteriores.

Una sustitución compatible de función/procedimiento puede declarar `migration-safety-reviewed: CREATE OR REPLACE ROUTINE` con una razón específica. Debe conservar firma, resultado, permisos y comportamiento N-1. El waiver `REVOKE` solo permite retirar acceso de función a `PUBLIC`/`anon` cuando se concede `EXECUTE` a `authenticated`. Ningún waiver permite operaciones contract.

`migration-safety-reviewed: COMPATIBLE CHECK REPLACEMENT` reconoce únicamente los
dos reemplazos revisados de `fiscal_pos_bridge_settings_bridge_url_check` y
`refund_requests_fiscal_series_check`. El checker compara todos los tokens de la
migración, incluidos los literales: exige los timeouts y un único `ALTER TABLE`
que sustituye atómicamente el mismo CHECK por su predicado aprobado con `NOT VALID`.
Cada predicado conserva íntegra la condición desplegada como rama de un `OR` y
amplía solo HTTP loopback o series R con secuencia de instalación positiva. Otros
DROP, predicados, tablas, constraints, instrucciones o cambios de configuración
siguen bloqueados. No es un waiver genérico ni requiere omitir el checker.
Las dos migraciones se corrigen antes de su primer despliegue en main; Staging
debe volver a su baseline antes de reaplicarlas. El historial de main es inmutable.

## Pending contract

Si el expand deja cleanup destructivo futuro, se registra en `supabase/contracts-pending.yml`:

```yaml
contracts:
  - id: example-cleanup
    expand_migration: 20260901000000_add_example.sql
    description: Remove the legacy column after all clients use the replacement.
    allowed_operations:
      - DROP
    created_at: 2026-09-16
```

El fichero es el backlog técnico machine-readable de cleanup de base de datos. Cada ID es único, referencia una migración expand existente y enumera únicamente las operaciones destructivas esperadas: `DROP`, `RENAME`, `ALTER COLUMN TYPE`, `SET NOT NULL` o `ADD NOT NULL COLUMN`.

Una entry nueva debe acompañar al expand que la origina. Una entry ya desplegada no se modifica. No se elimina sin una migración contract válida que la consuma.

## Contract posterior

Una migración contract debe empezar exactamente así:

```sql
-- migration-safety: contract
-- migration-contract: example-cleanup
set lock_timeout = '5s';
set statement_timeout = '5min';

DROP ...;
```

El checker permite únicamente las operaciones incluidas en `allowed_operations` y mantiene el resto de protecciones sobre timeouts, índices, constraints, RLS, rutinas y bloqueos.

Para aceptar el contract se exige que:

1. el ID exista en `contracts-pending.yml` en `baseSha`;
2. su `expand_migration` exista en `baseSha`;
3. la migración contract sea nueva en `headSha`;
4. la entry desaparezca de `contracts-pending.yml` en ese mismo PR.

`baseSha` acredita que expand y su pending contract ya están en la rama base del PR. No basta con añadir expand, pending y contract juntos en `headSha`. Antes de autorizar el contract para un entorno, el operador debe comprobar además que su expand está aplicado en la base real y que todos los clientes admitidos son compatibles. La rama base de Git no sustituye esa comprobación.

## Ciclo de vida

### Release A

- Añadir la nueva columna, RPC o estructura.
- Mantener la estructura legacy.
- Registrar el pending contract.
- Desplegar.

### Release B

- Desplegar clientes que ya no dependan de la estructura legacy.
- Mantener compatibilidad N-1 durante la transición.
- Desplegar.

### Release C o posterior

- Crear la migración contract que referencia el ID.
- Eliminar la entry pendiente en el mismo PR.
- Desplegar el cleanup.

No se fuerzan siempre tres releases. La retirada depende de que el expand esté aplicado en la base real y de que ningún cliente compatible use la estructura antigua. La política explícita de versiones PWA y el ledger de la base son la autoridad operativa.

## Operaciones y bloqueos

- No mezclar operaciones expand y contract.
- No eliminar datos en expand.
- Usar `CREATE INDEX` en las migraciones ejecutadas por la CLI; planificar su creación sobre tablas existentes con los timeouts de bloqueo y ejecución.
- Añadir FK/`CHECK` como `NOT VALID` y validar posteriormente.
- Preparar restricciones `UNIQUE`/`PRIMARY KEY` con índice concurrente y `USING INDEX`.
- Mantener `lock_timeout = '5s'` y `statement_timeout = '5min'` en expand y contract.
- Confirmar antes del contract que la versión N-1 ya no usa la API o estructura retirada.

Los workflows de `main` y `Staging` ejecutan Python, lint, tests y build, y después pueden solicitar el despliegue al controlador privado. No consultan workflows anteriores ni necesitan un SHA previamente desplegado. Las variables de activación están deshabilitadas por defecto: producción requiere `PRIVATE_DEPLOY_PRODUCTION_ENABLED=true`; staging requiere tanto `PRIVATE_DEPLOY_STAGING_ENABLED=true` como `STAGING_DEPLOY_ENABLED=true`. GitHub no recibe credenciales SSH, de Coolify ni de PostgreSQL.

En el host, el receptor lee `supabase_migrations.schema_migrations` en la base objetivo y calcula las migraciones pendientes por versión. Valida el contenido SQL real antes de cualquier escritura. Un commit que omite versiones ya aplicadas se rechaza. Si no hay pendientes, no cambia la contraseña de PostgreSQL, no genera backup ni ejecuta `db push`; continúa con Edge y frontend. La misma SHA puede volver a desplegarse con un request ID nuevo. El idempotency key identifica entorno, run y attempt, no el contenido del commit.

Las migraciones nuevas deben guardarse en UTF-8 sin BOM. `scripts/prepare-production-migrations.mjs` elimina el BOM inicial únicamente de la copia SQL que se empaqueta para producción, conservando las fuentes históricas y el resto de bytes. PostgreSQL rechaza ese marcador con `SQLSTATE 42601` antes de ejecutar la primera sentencia; una migración posterior no puede corregir ese fallo de lectura.

La CLI de producción ejecuta migraciones en pipeline, donde PostgreSQL rechaza `CREATE INDEX CONCURRENTLY` con `SQLSTATE 25001`. Por autorización explícita, se retira únicamente esa palabra de los tres índices de `20260912222539_paginate_pos_session_tickets.sql` y los dos de `20261003183458_optimize_pos_sale_latency.sql`. El checker compara el texto completo con el baseline y permite exclusivamente esas cinco retiradas en esos dos archivos; cualquier otra modificación histórica sigue bloqueada. La preparación acepta las fuentes corregidas y conserva la adaptación de copias antiguas, comprobando el número esperado de índices. Los índices normales pueden bloquear escrituras mientras se crean; `lock_timeout = '5s'` limita la espera para adquirir el bloqueo y `statement_timeout = '5min'` limita la ejecución.

## Autorizaciones de SQL del worker

El análisis de SQL pendiente se incluye junto al receptor en la imagen del worker de Coolify. Los comentarios de revisión dentro del SQL descargado no se aceptan como autoautorización. Una operación destructiva, contract o finding del checker bloquea el despliegue salvo autorización exacta del operador en la configuración privada del entorno.

La configuración del receptor puede declarar:

```json
{
  "migration_approvals": [
    {
      "environment": "production",
      "migration": "20261019120000_example.sql",
      "sha256": "<64 caracteres hex del SQL preparado>",
      "expires_at": "2026-10-27T00:00:00Z",
      "reason": "Revisión del SQL exacto y de compatibilidad de clientes",
      "expand_migration": "20261018120000_example_expand.sql"
    }
  ]
}
```

El hash corresponde a los bytes SQL que recibe el receptor, después de la preparación compatible de BOM y de los índices históricos. La autorización debe coincidir con el entorno, nombre completo, hash y fecha UTC futura; exige una razón de revisión. No basta el nombre, un commit anterior, un workflow correcto ni un waiver global. Cambiar un byte invalida la autorización. Para un contract, la autorización exige además `expand_migration`, cuyo timestamp debe existir en el ledger aplicado real; no se permite aplicar expand y contract juntos. La revisión debe confirmar que ningún cliente admitido depende del contrato antiguo.

El receptor mantiene además un registro instalado de contenido SQL por entorno (`/var/lib/tickit-deploy/migration-history.<environment>.json`). Esto permite detectar cambios posteriores de bytes en versiones ya aplicadas sin depender de una SHA anterior. Inicializar ese registro sobre una base existente exige una autorización `migration_history_bootstrap` con entorno, caducidad y digest de su mapa canónico aplicado; ver [operaciones del controlador](deployment-controller.md). El directorio del registro debe ser propiedad de root y no permitir escritura de otros usuarios.

El ledger debe existir. Un ledger existente pero vacío necesita una autorización de bootstrap instalada y con caducidad: `bootstrap: {allow_empty_ledger: true, environment: "production", expires_at: "...Z"}`. Esa opción nunca crea ni sustituye una tabla de historial ausente. Un `contracts-pending.yml` enviado por el commit es documentación de revisión, no una autorización del host.

Coolify recibe `DEPLOY_CONTROLLER_CONFIG`; el bloque `receiver` de cada entorno genera `/etc/tickit-deploy/receiver.<environment>.json` dentro del contenedor. El receptor, checker, configuración, ejecutables y sus directorios se validan como archivos de confianza root. Las autorizaciones no se distribuyen dentro del checkout descargado ni requieren un instalador en el VPS.

## Backups, compatibilidad PWA y resultados

Antes de aplicar SQL pendiente, el receptor mantiene el backup y la verificación de integridad existentes. `backup_copy_dir` permite una segunda copia verificada por SHA-256 en un directorio o montaje instalado; si esa copia falla, no se aplica SQL. No hay borrado ni poda automática de backups.

`SUPPORTED_APP_VERSIONS` es una lista explícita instalada por entorno en el host, separada del historial de despliegues. Debe contener todas las versiones de PWA que deban seguir funcionando; se añade siempre la SHA actual. Retirar una versión requiere revisar el uso de PWAs y las operaciones offline pendientes. No se fuerza una actualización durante operaciones críticas. `app-version.json` conserva `supportedVersions` y añade `currentVersion` para comprobar la SHA realmente servida.

Coolify conserva las comprobaciones de repositorio, rama, Railpack, auto-deploy deshabilitado y ausencia de despliegues en curso. Cada solicitud fuerza rebuild, incluso para la misma SHA, y el resultado debe informar exactamente la SHA solicitada. El controlador comprueba también la versión servida. Un fallo o estado `interrupted` exige inspeccionar los eventos privados; no se deduce éxito por el estado de un workflow anterior.

El workflow de PR conserva su checker contra la base del PR. Las variables antiguas `PRODUCTION_BASE_SHA`, `STAGING_BASE_SHA`, `STAGING_PREVIOUS_APP_VERSION` y `MIGRATION_SAFETY_EXCEPTION_*` ya no habilitan ni omiten validaciones del nuevo pipeline. Los scripts antiguos permanecen únicamente para compatibilidad; no hay un segundo pipeline automático activo.

Activar o instalar este sistema sobre producción, configurar autorizaciones, ejecutar migraciones, reiniciar servicios o desplegar necesita permiso explícito del usuario. La preparación local y las comprobaciones de solo lectura no activan producción.
