# Migraciones seguras para producción

## Regla principal

Cada release debe mantener compatibilidad N-1: durante el despliegue pueden seguir activos clientes de la versión anterior. Las migraciones ya desplegadas son inmutables; cualquier corrección requiere una migración nueva.

El checker compara `baseSha` (último baseline desplegado correctamente) con `headSha`. Solo acepta migraciones añadidas, rechaza versiones/timestamps duplicados y no permite modificar, renombrar ni eliminar migraciones existentes.

## Expand

Una migración expand debe empezar exactamente así, sin líneas previas:

```sql
-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
```

Expand añade estructura compatible sin retirar ni cambiar el contrato anterior. Ejemplos habituales:

- tablas o columnas nullable nuevas;
- índices con `CREATE INDEX CONCURRENTLY`;
- FK y `CHECK` iniciales con `NOT VALID`;
- `UNIQUE`/`PRIMARY KEY` sobre tablas existentes mediante índice único concurrente y `USING INDEX`;
- RPC nuevas manteniendo las anteriores.

Una sustitución compatible de función/procedimiento puede declarar `migration-safety-reviewed: CREATE OR REPLACE ROUTINE` con una razón específica. Debe conservar firma, resultado, permisos y comportamiento N-1. El waiver `REVOKE` solo permite retirar acceso de función a `PUBLIC`/`anon` cuando se concede `EXECUTE` a `authenticated`. Ningún waiver permite operaciones contract.

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

`baseSha` garantiza que el expand ya pertenecía al baseline de producción anterior. No basta con añadir expand, pending y contract juntos en `headSha`: EXPAND y CONTRACT nunca se despliegan juntos.

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

No se fuerzan siempre tres releases. El contract puede ir en el segundo release si el `baseSha` ya contiene el expand y la ventana N-1 garantiza que ningún cliente compatible depende de la estructura antigua. La regla es el baseline desplegado y la compatibilidad real, no un número fijo de releases.

## Operaciones y bloqueos

- No mezclar operaciones expand y contract.
- No eliminar datos en expand.
- Usar `CREATE INDEX CONCURRENTLY` sobre tablas existentes.
- Añadir FK/`CHECK` como `NOT VALID` y validar posteriormente.
- Preparar restricciones `UNIQUE`/`PRIMARY KEY` con índice concurrente y `USING INDEX`.
- Mantener `lock_timeout = '5s'` y `statement_timeout = '5min'` en expand y contract.
- Confirmar antes del contract que la versión N-1 ya no usa la API o estructura retirada.

El pipeline calcula el rango desde el último deploy completo correcto. Si un deploy falla, esas migraciones se vuelven a revisar. En el primer despliegue protegido, `PRODUCTION_BASE_SHA` debe señalar el commit realmente desplegado; después, el último workflow de producción correcto actúa como baseline.

Las migraciones nuevas deben guardarse en UTF-8 sin BOM. `scripts/prepare-production-migrations.mjs` elimina el BOM inicial únicamente de la copia SQL que se empaqueta para producción, conservando las fuentes históricas y el resto de bytes. PostgreSQL rechaza ese marcador con `SQLSTATE 42601` antes de ejecutar la primera sentencia; una migración posterior no puede corregir ese fallo de lectura.

La CLI de producción ejecuta migraciones en pipeline, donde PostgreSQL rechaza `CREATE INDEX CONCURRENTLY` con `SQLSTATE 25001`. La preparación adapta únicamente los tres índices de `20260912222539_paginate_pos_session_tickets.sql` y los dos de `20261003183458_optimize_pos_sale_latency.sql` a índices normales en la copia de despliegue. Comprueba el número esperado de índices y conserva los timeouts y las fuentes. Esta excepción de compatibilidad puede bloquear escrituras mientras se crean los índices; `lock_timeout = '5s'` limita la espera para adquirir el bloqueo y `statement_timeout = '5min'` limita la ejecución.

## Excepción revisada para una única promoción

La excepción está inactiva por defecto. No acredita la seguridad del SQL: solo omite el checker del PR y del despliegue para un merge previamente revisado. Conserva las pruebas del checker, lint, tests, build, backup y ejecución de migraciones.

Para activarla, después de hacer commit de los cambios revisados en `Staging`, configurar estas **repository variables** en GitHub, en Settings → Secrets and variables → Actions → Variables:

- `MIGRATION_SAFETY_EXCEPTION_BASE_SHA`: SHA completo del último despliegue correcto (baseline de producción).
- `MIGRATION_SAFETY_EXCEPTION_HEAD_SHA`: SHA completo final de `Staging`, incluyendo los cambios de estos workflows.
- `MIGRATION_SAFETY_EXCEPTION_MERGE_BASE_SHA`: opcional; SHA completo del `main` actual cuando avanzó tras un despliegue fallido. Debe descender del baseline. Si está vacía, se usa `MIGRATION_SAFETY_EXCEPTION_BASE_SHA` como primer padre.

Abrir o actualizar el PR `Staging` → `main` y usar **Create a merge commit**. La excepción exige el `main` fijado y el `Staging` fijado como padres, en ese orden, tanto en el merge de prueba del PR como en producción; el baseline de producción debe seguir coincidiendo exactamente con `MIGRATION_SAFETY_EXCEPTION_BASE_SHA`. El SHA sintético que aparece como `merged PR` no es el HEAD de `Staging`. Squash, rebase, cambios posteriores en cualquiera de las ramas, forks y otros eventos no quedan exentos. Si el PR ya tenía un check fallido, volver a ejecutar el workflow después de configurar las variables.

La ejecución deja una advertencia y un resumen con los commits exentos. Si la excepción no coincide, registra los SHA esperados y los padres reales para diagnosticarlo. Tras un despliegue correcto, el baseline avanza y la excepción deja de aplicarse a futuras promociones. Eliminar las variables de excepción después de confirmar el despliegue; si falla, los reintentos del mismo merge pueden seguir usando la excepción mientras el baseline anterior permanezca vigente.

Para la promoción revisada el 2026-10-04, el baseline observado es `17aea9a3a9c92316ae5aa06c18648266e95df3cf`. El SHA de `Staging` debe obtenerse después del commit definitivo; no utilizar el SHA anterior a la preparación de la excepción. No cambiar `PRODUCTION_BASE_SHA` para saltarse validaciones.
