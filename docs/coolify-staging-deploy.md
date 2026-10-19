# Prueba de despliegue de Staging en Coolify

## Estado de la inspección

El informe del agente y la consulta administrativa del 2026-10-19 confirman
Python 3.14.4, SSH en el puerto 22, Coolify 4.4.6 y estos metadatos de PostgreSQL:

| Dato | Valor comprobado |
| --- | --- |
| Contenedor | `supabase-db-irsdd2liytrh7dttjr5rzj3j` |
| Proyecto Compose / red | `irsdd2liytrh7dttjr5rzj3j` |
| Servicio Compose | `supabase-db` |
| Imagen | `supabase/postgres:17.6.1.136` |
| Versión SQL | PostgreSQL 17.6 |
| IP observada, dinámica | `10.0.2.12` |
| Roles con LOGIN | `supabase_admin` (superusuario), `postgres` (sin superusuario) |
| Contraseña | `POSTGRES_PASSWORD` presente; valor no compartido |
| Historial de la aplicación | Inicialmente ausente; **recuperado con 161 registros hasta `20261015120000`** |

La API referenciada por la herramienta de copia es
`https://pre-api-tpv.alteilsolutions.com`.
Esa URL es la API de Supabase, **no** la URL del panel/API de Coolify.

El SHA `82c8295a9d122c5329c6b1f4deb215aa8b2dfc5c` observado en GitHub es el
HEAD de la rama y no acredita el estado desplegado ni el baseline de la base.
No se utiliza automáticamente como `STAGING_BASE_SHA`.

La comprobación guiada posterior confirma en main **161 migraciones**, hasta
`20261015120000`. El dump normalizado de `public` y `pos_private` coincide en
ambos servidores, también incluyendo propietarios y ACL:
`dcba2af04af915c2466bd2b54054a8970e00303565da603c686d65cbecfd74c4`.
Sin propietarios/ACL coincide igualmente:
`114e52d3d5d09dc49ffe2341a08a4b1788cdcce851788dc73908c683bd57bf9e`.
Los dumps de todos los esquemas, excluyendo el historial, difieren; no se ha
atribuido esa diferencia a objetos concretos.

La consulta de las policies `supplier_documents_storage_%` sobre
`storage.objects` devuelve **0 en ambos servidores**. Las migraciones
`20260901120000` y `20260905120000` las crean/modifican: su ausencia compartida
debe quedar registrada como desviación de Storage, no como prueba de que esa
parte del esquema coincide con el resultado esperado de las migraciones.
No se han creado policies ni cambiado permisos para corregirla durante esta
adaptación.

La recuperación guiada del historial terminó correctamente en una transacción,
sin ejecutar las migraciones ni restaurar datos de la aplicación. La consulta
posterior en staging devuelve **161 registros**, última versión
`20261015120000`. Se conservaron estos archivos privados:

- Backup completo de staging, recorrido con `pg_restore --file=/dev/null`:
  `/home/admin/staging-history.Qv56JH/staging-before.dump` (21 MB).
- Export del esquema `supabase_migrations` de main:
  `/home/ubuntu/pos-history-export.W3N9Pc/history.dump` (258 KB).
- Copia del export en staging:
  `/home/admin/staging-history.Qv56JH/history-main.dump`.
- SHA-256 del export y su copia:
  `fd0cafce93f9e168176c76fceee8f66bdbb7a44e46dcbb4737ae9f4f4f87392d`.

El primer intento con `pg_restore --schema=supabase_migrations` omitió la
creación del propio esquema y falló; su transacción se revirtió. Se restauró
correctamente el archivo acotado completo, sin ese filtro y conservando
`--single-transaction --exit-on-error`. El esquema no existía previamente.

Las etiquetas y redes del contenedor ya se han consultado con sudo desde la
terminal del administrador. `/data/coolify`, sudoers y snapshots privados
siguen sin inspeccionar.
El proceso del agente tiene `NoNewPrivs=1`: un nuevo intento de sudo dentro de
esa misma sesión no resuelve la restricción. Un administrador debe realizar
las consultas desde su sesión SSH normal, o proporcionar los metadatos desde
el panel. No hace falta conceder acceso general a Docker al agente.

## Datos que faltan

- Origen HTTPS de Coolify; versión instalada ya comprobada: 4.4.6.
- UUID, rama configurada exactamente `Staging`, build pack, auto-deploy y SHA
  desplegado del frontend; confirmar también que no hay deployments activos.
  El script actual admite el frontend Railpack inspeccionado en main: si el
  staging utiliza otro build pack, comprobar su configuración antes de activarlo.
- Comprobar acceso local/TCP, dump y lectura segura de contraseña usando
  `supabase_admin`, el rol de migraciones seleccionado por sus permisos.
- Fijar el baseline Git de staging que corresponda al estado recuperado. El
  historial ya se ha recuperado con la evidencia de esquema anterior; no se
  utilizó `migration repair` ni se ejecutaron SQL históricos de la aplicación.
- Instalar la CLI fijada `2.121.0` y comprobar sus ayudas.
- Preparar usuario/clave SSH restringidos para Actions y token de Coolify.

### Siguiente comprobación: comparar esquemas sin publicar SQL

El usuario indica que staging contiene los mismos datos que main, pero no
conserva el dump/script de la importación. Antes de preparar la recuperación
del historial, comparar los esquemas actuales desde ambas terminales. No
restaurar ni ejecutar migraciones en esta fase.

En main, configurar:

```bash
container=supabase-db-dbdtluvsdqycxl5tecuwljie
```

En staging, configurar:

```bash
container=supabase-db-irsdd2liytrh7dttjr5rzj3j
```

Después ejecutar este mismo bloque en ambas terminales:

```bash
set -o pipefail
sudo docker exec "${container:?Configura el contenedor de este VPS}" \
  pg_dump -w -U supabase_admin -d postgres --schema-only \
  --exclude-schema=supabase_migrations \
  | python3 -c 'import hashlib,sys; data=sys.stdin.buffer.read(); normalized=b"\n".join(line for line in data.splitlines() if not line.startswith((b"\\restrict ", b"\\unrestrict ", b"-- Dumped from database version ", b"-- Dumped by pg_dump version "))); sys.exit("ERROR: dump vacio") if not normalized.strip() else print("schema_sha256="+hashlib.sha256(normalized).hexdigest())'
```

Pegar las dos huellas y cualquier error saneado. El dump incluye propietarios
y permisos; solo se excluye el esquema de historial que falta en staging y se
normalizan los tokens aleatorios de `pg_dump` y sus cabeceras de versión.
El SQL no se guarda ni se imprime. Utilizar los clientes `pg_dump` de las
imágenes ya verificadas en ambos VPS.

Una huella diferente exige revisar las diferencias; no implica por sí sola
que todas sean migraciones pendientes. Una huella igual acredita coincidencia
del dump de esquema normalizado, no compara datos, efectos DML históricos ni
roles globales. No autoriza por sí sola marcar todas las migraciones como
aplicadas. Mantener los despliegues/migraciones pausados durante la comparación
para no comparar estados que cambien entre las dos consultas.

### Consultas del administrador

Estos comandos solo consultan Docker y PostgreSQL. Ejecutarlos en el VPS de
**staging**, desde una terminal SSH del administrador, fuera del agente con
`NoNewPrivs`. El nombre del contenedor ya está confirmado: si no
existe, detenerse e identificarlo en el panel, sin sustituirlo por otro al azar.

```bash
container=supabase-db-irsdd2liytrh7dttjr5rzj3j
sudo docker inspect --format \
  'project={{index .Config.Labels "com.docker.compose.project"}} service={{index .Config.Labels "com.docker.compose.service"}} image={{.Config.Image}}{{range $name, $network := .NetworkSettings.Networks}}{{printf "\nnetwork=%s ip=%s" $name $network.IPAddress}}{{end}}' \
  "$container"

sudo docker exec "$container" psql -X -w -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "BEGIN READ ONLY; SELECT version(); SELECT to_regclass('supabase_migrations.schema_migrations') AS history_table; SELECT rolname, rolcanlogin, rolsuper FROM pg_roles WHERE rolname IN ('postgres', 'supabase_admin'); COMMIT;"

# Ejecutar únicamente si history_table existe. No incluye statements ni datos de clientes.
sudo docker exec "$container" psql -X -w -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "BEGIN READ ONLY; SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version; COMMIT;"

sudo docker exec "$container" sh -c \
  'if [ -n "${POSTGRES_PASSWORD:-}" ]; then echo "POSTGRES_PASSWORD presente"; else echo "POSTGRES_PASSWORD ausente"; fi'

sudo docker ps --filter 'name=^/coolify$' --format '{{.Names}} {{.Image}}'
```

Pegar únicamente esos resultados y los metadatos del frontend/panel, nunca
`.env`, claves, tokens o `docker inspect` completo. Si `psql -w` falla por
autenticación, conservar el error saneado y revisar el método con el
administrador; no cambiar `pg_hba.conf` ni permisos para hacer pasar la prueba.

## Preparación del VPS

Reutilizar el receptor `scripts/deploy-pos.py`, con una configuración **propia**
de este VPS. `scripts/pos-deploy.staging.example.json` ya contiene el proyecto,
la red, el rol y la versión requerida `20261015120000` comprobados. Confirmar
la ruta/versión de CLI antes de instalarla como configuración activa. No
instalar la configuración de main.

La configuración fija la CLI **2.121.0**, versión actual de main comunicada
por el usuario. En staging ya se instaló desde la distribución oficial
verificada mediante SHA-256, con `supabase` y su compañero `supabase-go` en
`/usr/bin`. Se comprobaron la versión, `db push --help` y un dry-run real
mediante el receptor restringido antes de activar la action.
El rol elegido debe poder consultar el historial, crear un dump completo y
ejecutar las migraciones. Verificar el acceso local/TCP con ese rol.

Desde una copia revisada de los archivos en el VPS, una vez completada la
configuración local de staging:

```bash
sudo install -m 755 -o root -g root scripts/deploy-pos.py /usr/local/bin/deploy-pos
# Sustituir por la ruta de la configuración local YA completada y verificada.
sudo install -m 600 -o root -g root /ruta/pos-deploy.staging.json /etc/pos-deploy.json
sudo install -d -m 700 -o root -g root /opt/pos-deploy/backups /var/log/pos-deploy
```

Un administrador debe preparar la cuenta `github-deploy` y su clave de staging,
sin reutilizar la clave de main ni la entrada sin restricciones de `admin`:

```text
# authorized_keys de github-deploy
restrict,command="sudo -n -- /usr/local/bin/deploy-pos" ssh-ed25519 <CLAVE_PUBLICA_STAGING>

# sudoers, validar con visudo; permite solo el receptor sin argumentos
github-deploy ALL=(root) NOPASSWD: /usr/local/bin/deploy-pos ""
```

Mantener receptor, configuración y directorios padre bajo control de root.
La preparación del receptor no altera RLS ni datos de la aplicación. La
recuperación del esquema de historial ya se completó como se indica arriba.

**Es obligatorio instalar el receptor actualizado antes de comprobar SSH.**
El transporte de staging usa protocolo 3 y distingue `check` de `apply`.
El receptor anterior de protocolo 2 lo rechaza antes de acceder a la base,
evitando que una comprobación termine aplicando SQL por incompatibilidad.
El receptor nuevo sigue aceptando paquetes de aplicación de protocolo 2 de main.

## Configuración de GitHub

| Tipo | Nombre | Valor |
| --- | --- | --- |
| Variable | `COOLIFY_URL` | `https://tickit-vps.tail723c3c.ts.net`, compartido con main, sin `/api/v1` |
| Variable | `STAGING_COOLIFY_APPLICATION_UUID` | `9gaewsb4ioes4gjfhprbkc4i`; rama `Staging` y Railpack confirmados en el panel, pendientes de preflight por API |
| Variable | `STAGING_BASE_SHA` | `7131c1488596e882c20b856e8f3da114ce15180d`, baseline de migraciones de la copia inicial |
| Variable | `STAGING_PREVIOUS_APP_VERSION` | `development`, versión publicada antes del primer rollout; después se usa el SHA del último deploy correcto |
| Variable | `STAGING_SSH_PORT` | `22`, o el puerto verificado; por defecto 22 |
| Variable | `STAGING_DEPLOY_ENABLED` | Ausente o `false` durante las comprobaciones; `true` para publicar |
| Secret | `STAGING_COOLIFY_API_TOKEN` | Token de su instancia/equipo con permisos `read`, `write`, `deploy` |
| Secrets | `STAGING_TS_CLIENT_ID`, `STAGING_TS_AUDIENCE` | Client ID y Audience de la identidad OIDC de Tailscale restringida a `Staging` |
| Secrets | `STAGING_SSH_HOST`, `STAGING_SSH_USER` | VPS de staging y usuario restringido |
| Secrets | `STAGING_SSH_PRIVATE_KEY`, `STAGING_SSH_KNOWN_HOSTS` | Clave de staging y host key verificada por un canal fiable |

El recurso Supabase `irsdd2liytrh7dttjr5rzj3j` está fijado directamente en el
workflow. La IP no se fija: se descubre en la red verificada en cada ejecución.

## Acceso privado al frontend por Tailscale

El frontend de staging está en otro VPS, `tickit-vps`, con IP de Tailscale
`100.118.217.48`. El receptor de migraciones sigue en `193.181.214.249:22`.
Son conexiones independientes: SSH al VPS de Supabase y API al Coolify privado.

Se activó `tailscale serve --bg http://127.0.0.1:8000` tras comprobar que no
había configuración previa. La URL HTTPS anterior responde `200` en
`/api/health` desde el PC del administrador con Tailscale conectado.

Cada job se une temporalmente a Tailscale con la acción oficial v4 fijada a
un commit. Usa OIDC de GitHub (`id-token: write`); no necesita un client secret.
La identidad de staging debe tener:

- Issuer: GitHub (`https://token.actions.githubusercontent.com`).
- Subject exacto: `repo:Chapuzalia/POS:ref:refs/heads/Staging`.
- Scope `auth_keys` con escritura y solo `tag:github-actions-staging`.
- Client ID y Audience configurados con los nombres de la tabla anterior.

La política guardada permite a `autogroup:member` mantener su acceso general;
`tag:github-actions-staging` solo puede iniciar TCP a `100.118.217.48:443`.
El propietario de la etiqueta es `autogroup:admin`. No conservar además la
regla global `src: ["*"]`, porque también concedería acceso completo al runner.
Los dispositivos con otras etiquetas necesitan sus propios permisos.

Referencia: [acción oficial de Tailscale](https://tailscale.com/docs/integrations/github/github-action).

La cuenta `github-deploy`, forced command, sudoers sin argumentos y clave
exclusiva de staging ya se probaron desde el PC. El paquete de comprobación
del SHA `82c8295a9d122c5329c6b1f4deb215aa8b2dfc5c` terminó correctamente:
5 migraciones pendientes, sin backup ni aplicación de SQL. La conexión OIDC
desde Actions y el despliegue real aún están pendientes.

La captura del historial de staging confirma un despliegue terminado del SHA
`82c8295a9d122c5329c6b1f4deb215aa8b2dfc5c`. El endpoint publicado
`http://9gaewsb4ioes4gjfhprbkc4i.137.74.40.125.sslip.io/app-version.json`
devuelve `{"supportedVersions":["development"]}`. La configuración del panel
muestra Railpack y tipo de sitio Dynamic; la verificación del primer deploy
debe comprobar que los valores de build se reflejan en los archivos servidos.

El SHA desplegado de main, `5222f321fac2cb1ffe1953a55dbf5ce647fd126a`, no es
ancestro de `Staging`. Su ancestro común `7131c1488596e882c20b856e8f3da114ce15180d`
contiene exactamente los mismos 161 archivos de migración, comparados mediante
sus blobs y rutas de Git. El checker desde ese ancestro a `82c8295` pasa y
revisa las cinco migraciones pendientes. Por eso el punto inicial de revisión
SQL y la versión anterior del frontend se configuran por separado. Tras el
primer deploy correcto, ambos se obtienen del último release publicado.

Desactivar auto-deploy del frontend **antes del primer push** de prueba y esperar
a que no haya despliegues activos. El workflow lo exige para controlar el orden.
Confirmar en la API instalada las operaciones documentadas en
[la guía de main](coolify-production-deploy.md) antes de habilitar el deploy.

## Primera prueba

1. Completar la inspección y el historial; instalar el receptor/configuración
   y preparar los secrets. Mantener `STAGING_DEPLOY_ENABLED` en `false`.
2. Subir el workflow y sus scripts a la rama exacta `Staging`. El evento `push`
   ejecuta el job de verificación y omite el de despliegue.
3. El job comprueba el destino, baseline, frontend, checker de migraciones,
   tests/lint/build, SSH, historial y CLI. El receptor hace `db push --dry-run`
   en una conexión con `default_transaction_read_only=on`, sin crear backup,
   aplicar migraciones ni recargar PostgREST. Sí crea temporales/log privado
   del VPS y usa el lock para serializar la comprobación.
4. Con las comprobaciones correctas, establecer `STAGING_DEPLOY_ENABLED=true`.
   Un nuevo push, o reejecutar **todos los jobs** del evento push anterior,
   ejecuta la comprobación seguida del backup, migraciones y frontend.
5. Comprobar backup, historial, SHA publicado, `app-version.json`, login y
   lectura habitual del POS con un tenant de pruebas antes de pasar a main.

También existe `workflow_dispatch` con `mode=check` por defecto y `mode=deploy`
para publicar. La ejecución manual debe seleccionar `Staging`. [GitHub requiere](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
que el workflow esté registrado en la rama por defecto para ofrecer ese evento;
el primer test puede hacerse con `push` sin depender del botón manual.
`mode=check` no publica aunque la variable de activación esté en `true`.

Un run que solo comprueba nunca avanza el baseline: para usar su SHA en el
siguiente release se exige que el job `Deploy staging release` terminara
correctamente. No se heredan las excepciones puntuales de migraciones de main.
Un fallo de historial debe resolverse con evidencia de la copia, sin configurar
el baseline para omitir checks.

Los grupos de concurrencia, credenciales, destinos y baseline de staging son
independientes de main. El workflow rechaza los UUID conocidos de producción
y verifica la rama de la aplicación antes de solicitar cambios.

## Verificación local realizada

Pruebas sin conexión al VPS:

```bash
node --test tests/deploy-coolify.test.mjs tests/staging-baseline.test.mjs
python3 -B -m unittest discover -s tests -p test_deploy_pos.py
pnpm test
```

Resultado local: 10 pruebas específicas de despliegue/baseline, 11 del receptor
Python y 951 de la suite completa correctas. En el sandbox de Windows se usó
un directorio temporal del workspace; tras errores de acceso intermitentes,
la suite completa pasó con `node --test --test-concurrency=4 tests/*.test.mjs`.
Ambos workflows pasan actionlint 1.7.12 exceptuando su falso positivo conocido
para `concurrency.queue`, y `git diff --check` pasa.

El administrador ya probó el receptor remoto en modo check y el endpoint
HTTPS privado de Coolify. La primera ejecución de Actions y la aplicación
de las cinco migraciones siguen pendientes; mantener el despliegue desactivado
hasta completar esa comprobación.
