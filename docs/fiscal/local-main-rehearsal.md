# Guía del entorno local de pruebas de main

Este entorno restaura una copia de main y permite ensayar las migraciones de Staging y probar el POS y el CRM. Todos los comandos siguientes se ejecutan **en PowerShell en tu ordenador**, desde:

```powershell
cd C:\Users\gerar\Alteil_Projects\POS
```

Docker Desktop debe estar abierto y usando contenedores Linux. Los scripts actúan sobre `pos-main-rehearsal-20261002` y la base local `rehearsal`; no se conectan al VPS. Antes de operar comprueban el contexto local de Docker en Windows, la imagen, el volumen, la red interna y que PostgreSQL no tenga puertos publicados.

## Archivos y accesos

| Elemento | Ubicación |
|---|---|
| Dump original | `C:\Users\gerar\OneDrive\Desktop\backup\main.dump` |
| Roles originales | `C:\Users\gerar\OneDrive\Desktop\backup\roles.sql` |
| Configuración y scripts locales | `backups\main-lab\` |
| Contraseñas de pruebas | `backups\main-lab\access.local.md` |
| Claves locales | `backups\main-lab\secrets.local.json` |
| Informe del ensayo inicial | `backups\main-lab\rehearsal.local.md` |
| Logs de nuevos ensayos | `backups\main-lab\runs\` |

La carpeta `backups/` está excluida de Git. Conserva sus archivos: contienen la configuración específica de tu ordenador y las claves del entorno. No los publiques ni ejecutes `prepare.mjs` para restaurar la base: ese script prepara la configuración, pero no restaura datos ni aplica migraciones.

| Aplicación | URL | Cuenta existente |
|---|---|---|
| POS de Mess, Barra 1 | http://localhost:5180/ | `barra1@mess.mess-gold` |
| CRM | http://localhost:5180/crm | `josep@messigualada.com` |
| Studio y API | http://127.0.0.1:58300/ | Studio: `lab` |

Las contraseñas de estas cuentas se cambian exclusivamente en la copia local. Consulta `access.local.md`; las del VPS permanecen intactas.

## Arrancar o reiniciar sin restaurar datos

```powershell
.\backups\main-lab\start.ps1
```

Arranca PostgreSQL, los servicios de Supabase y el frontend. Si el frontend ya está escuchando en el puerto 5180, no inicia otro. Las ventas y demás cambios de las pruebas anteriores se conservan.

Para parar todo sin borrar datos:

```powershell
.\backups\main-lab\stop.ps1
```

Para reiniciar, ejecuta `stop.ps1` y después `start.ps1`. No uses `docker compose down -v`, borres el volumen ni hagas una limpieza global de Docker: esta guía reutiliza el clúster local y sus roles ya restaurados.

## Volver al dump y repetir todas las migraciones pendientes

Este es el ciclo recomendado después de modificar una migración que todavía no está desplegada en main:

1. Cierra las pestañas del POS y CRM locales. Para la próxima prueba utiliza una ventana privada nueva, o borra los datos del sitio `http://localhost:5180` antes de volver a entrar. Esto evita que sesiones, catálogos o una cola offline del ensayo anterior se reutilicen sobre la base restaurada.
2. Ejecuta:

   ```powershell
   .\backups\main-lab\restore.ps1 -ApplyMigrations -Start
   ```

3. Confirma la restauración cuando el script lo solicite. Abre el POS o CRM y entra con las contraseñas locales de `access.local.md`.

El script para el frontend y los servicios, restaura el dump en una **base nueva** y verifica que existe el historial de migraciones. Solo después cambia esa base a `rehearsal`; el estado local anterior se conserva como `rehearsal_previous_<fecha>_<identificador>`. El archivo original del dump nunca se modifica.

Después restaura la configuración local de conexión, prepara Realtime con sus claves locales, aplica las migraciones pendientes y arranca los servicios. Finalmente verifica el login de las dos cuentas, sus permisos, Realtime y la función de accesos del CRM. Este último paso restablece las contraseñas locales de ambas cuentas.

No necesita importar otra vez `roles.sql`: los roles viven en el clúster y se mantienen al sustituir una base de datos. Este procedimiento requiere que exista el contenedor local preparado; no reconstruye un clúster desde cero si has eliminado el volumen.

Para ver qué restauración haría sin ejecutarla:

```powershell
.\backups\main-lab\restore.ps1 -ApplyMigrations -Start -WhatIf
```

Para utilizar otro dump compatible:

```powershell
.\backups\main-lab\restore.ps1 `
  -DumpPath 'C:\ruta\otro-main.dump' `
  -ApplyMigrations -Start
```

Otro backup puede contener otras cuentas, roles o requisitos de migración. Los scripts de accesos están preparados para los dos usuarios existentes del backup actual; revisa esa configuración si cambias de origen.

## Restaurar primero y aplicar las migraciones después

Si quieres inspeccionar la base en su estado original antes de migrarla:

```powershell
.\backups\main-lab\restore.ps1
```

Deja PostgreSQL encendido y los demás servicios parados. El frontend de Staging espera el esquema nuevo, por lo que todavía no es el momento de abrir el POS.

Puedes consultar el estado del dump con:

```powershell
$docker = "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin\docker.exe"
& $docker exec pos-main-rehearsal-20261002 `
  psql -U postgres -d rehearsal -X -v ON_ERROR_STOP=1 `
  -c 'SELECT max(version) FROM supabase_migrations.schema_migrations; SELECT status,count(*) FROM public.tickets GROUP BY status;'
```

Para listar las migraciones pendientes sin aplicarlas:

```powershell
.\backups\main-lab\migrate.ps1 -WhatIf
```

Para aplicarlas y abrir el entorno:

```powershell
.\backups\main-lab\migrate.ps1 -Start
```

El runner lee los archivos actuales de `supabase/migrations/`, los ordena por versión y compara con `supabase_migrations.schema_migrations` de la copia. Copia el SQL que ejecuta, guarda sus hashes y tiempos, y registra cada migración aplicada. No aplica nuevamente una versión ya registrada: **si modificas una migración aplicada y quieres ensayarla otra vez, restaura primero el dump**.

Cada archivo se ejecuta con `psql --single-transaction` y `ON_ERROR_STOP=1`. Las migraciones pendientes del ensayo inicial pasan con este método; no equivale a ejecutar el workflow del VPS ni evita el checker del despliegue. El script rechaza índices concurrentes que requieren otro método de ejecución.

## Comprobar servicios, esquema y logs

```powershell
$docker = "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin\docker.exe"

& $docker compose -f .\backups\main-lab\compose.local.json ps

& $docker exec pos-main-rehearsal-20261002 `
  psql -U postgres -d rehearsal -X -v ON_ERROR_STOP=1 `
  -c 'SELECT max(version) FROM supabase_migrations.schema_migrations; SELECT status,count(*) FROM public.tickets GROUP BY status; SELECT record_kind,count(*) FROM public.fiscal_local_records GROUP BY record_kind;'

& $docker compose -f .\backups\main-lab\compose.local.json logs --tail 50 auth rest realtime functions
```

En el backup inicial hay 8.548 tickets: 8.527 pagados y 21 anulados. Tras las 17 migraciones, antes de crear nuevas ventas, hay 8.548 altas y 21 anulaciones fiscales; la última versión es `20261002120000`.

Los logs del frontend están en `vite.local.log` y `vite-error.local.log`. Los logs SQL y el manifiesto de cada ejecución de `migrate.ps1` están en `runs/<fecha>-<identificador>/`.

## Si falla una restauración o migración

- Si falla `pg_restore`, el estado anterior sigue en `rehearsal`; los servicios quedan parados. Revisa el error antes de arrancarlos. La base de restauración parcial se conserva para diagnóstico.
- Si falla una migración, las anteriores ya aplicadas permanecen. El script se detiene y deja los servicios parados. Revisa el log de esa migración; para repetir el ensayo desde un estado conocido, corrige el SQL y vuelve a ejecutar `restore.ps1 -ApplyMigrations -Start`.
- Un archivo con `COMMIT` explícito puede haber confirmado su SQL aunque una operación posterior falle. No elimines una fila del historial para forzar un reintento: restaura el dump y repite el ciclo.
- Las bases `rehearsal_previous_*` conservan ensayos anteriores y ocupan espacio. Puedes listarlas con `SELECT datname FROM pg_database WHERE datname LIKE 'rehearsal_previous_%';`. No se borran automáticamente.
- Si al abrir la aplicación aparece el estado anterior o una sesión inválida, cierra las pestañas antiguas y abre una ventana privada nueva. No reutilices una cola offline creada antes de la restauración.

## Alcance de las pruebas

La base y los servicios están en una red interna; el gateway publica únicamente `127.0.0.1:58300`. El frontend utiliza las claves públicas locales y no cambia `.env.local` del proyecto.

El dump incluye metadatos de Storage, pero no los archivos que el VPS guarda fuera de PostgreSQL. Los archivos que subas durante las pruebas locales no se restauran ni se borran con `restore.ps1`. Correo, OCR externo, AEAT y hardware/agentes externos no quedan validados por este entorno.

Puedes probar ventas, pagos, anulaciones, históricos y configuración desde el POS y CRM. El ensayo inicial validó el SQL y la integridad del histórico, además de login, catálogo, dashboard y conexiones; todavía hay que comprobar los flujos de negocio que quieras acreditar antes del merge.
