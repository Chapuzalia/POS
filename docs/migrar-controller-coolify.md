# Migrar el deploy controller a su propio proyecto en Coolify

Esta guía es para tu instalación actual de **Tickit POS**, en el mismo VPS.
La aplicación de POS y Supabase continúan encendidos. Solo se detiene el
controller mientras se trasladan su configuración, cola, historial y backups.
No se restaura PostgreSQL ni se deshacen migraciones: las ventas nuevas permanecen.

**Ejecuta los bloques en orden. Si un bloque falla, no continúes con el siguiente.**
No ejecutes `docker compose down -v`, limpiezas de volúmenes ni borrados de la
aplicación antigua. Mantendremos esa instalación para recuperación.

Hay dos terminales: **PC / PowerShell** y **VPS / Bash**. Están marcadas.
Los valores `TU_...` se sustituyen antes de ejecutar. No hay que instalar Node,
Python ni Supabase CLI en el VPS: utilizaremos una imagen auxiliar del controller.

## 1. PC: preparar y publicar el repositorio nuevo

En GitHub crea un repositorio **vacío**, preferiblemente privado, llamado
`deploy-controller`. No añadas README, licencia ni `.gitignore` desde GitHub.
Debe ser un repositorio nuevo: **no utilices la URL del repositorio POS**.

Abre PowerShell:

```powershell
Set-Location 'C:\Users\david\Desktop\CRAFO\chapuzalia\inmobiliaria\chapu\deploy-controller'
git status --short
git branch --show-current
```

Para que Coolify utilice exactamente los datos que vamos a importar, cambiaremos
solo la declaración final del volumen de datos. Este comando se detiene si el
archivo ya no tiene la estructura esperada:

```powershell
python -c "from pathlib import Path; p=Path('docker-compose.deploy-controller.yml'); s=p.read_text(encoding='utf-8'); old='volumes:\n  deploy-data:\n  deploy-ipc:\n'; new='volumes:\n  deploy-data:\n    external: true\n    name: deploy-controller-data-v2\n  deploy-ipc:\n'; assert s.endswith(old), 'El Compose ya ha cambiado: revisa el final antes de continuar'; p.write_text(s[:-len(old)]+new,encoding='utf-8',newline='\n')"
git diff -- docker-compose.deploy-controller.yml
```

El final del archivo debe quedar así:

```yaml
volumes:
  deploy-data:
    external: true
    name: deploy-controller-data-v2
  deploy-ipc:
```

Publica el repositorio nuevo. Sustituye la URL por la que te muestra GitHub:

```powershell
git add .
git commit -m "docs: prepare Coolify migration and persistent data volume"
git remote add origin 'https://github.com/TU_USUARIO_O_ORGANIZACION/deploy-controller.git'
git push -u origin codex/independent-controller
```

Si `origin` ya existe, usa `git remote -v` y comprueba que apunta al repositorio
**nuevo**. No lo reemplaces a ciegas. Si `git commit` dice que no hay cambios,
puedes omitir ese comando; el push sigue siendo necesario.

Prepara una copia del código para el VPS. Esto evita crear otra clave Git en
el servidor solo para los preparativos. Sustituye usuario e IP:

```powershell
git archive --format=tar.gz --output=deploy-controller-migracion.tar.gz HEAD
scp .\deploy-controller-migracion.tar.gz TU_USUARIO_SSH@TU_IP_VPS:deploy-controller-migracion.tar.gz
```

El archivo contiene código, no las credenciales del controller.

## 2. GitHub y Coolify: suspender solicitudes, mantener POS funcionando

En el repositorio **POS**, abre Settings → Secrets and variables → Actions →
Variables. Anota sus valores actuales y pon:

| Variable | Durante el traslado |
| --- | --- |
| `PRIVATE_DEPLOY_PRODUCTION_ENABLED` | `false` |
| `PRIVATE_DEPLOY_STAGING_ENABLED` | `false` |

No borres sus secretos Access. Espera a que terminen las solicitudes ya enviadas.
Cancelar un workflow en GitHub **no cancela** una operación aceptada por el worker.

En Coolify desactiva **Auto Deploy del controller antiguo**. Conserva también
desactivado el Auto Deploy de los frontends que administra; el controller es quien
debe ordenar sus releases. No pares el frontend, Supabase, Coolify ni el Tunnel.

## 3. VPS: preparar carpeta e imagen auxiliar

Entra por SSH como haces normalmente. Si usas un usuario distinto de root:

```bash
sudo install -m 600 "$HOME/deploy-controller-migracion.tar.gz" /root/deploy-controller-migracion.tar.gz
sudo -i
```

Si ya entraste como root, omite esos dos comandos; el archivo ya estará en
`/root/deploy-controller-migracion.tar.gz`.

Los siguientes bloques se ejecutan **como root y en la misma sesión Bash**:

```bash
set -euo pipefail
umask 077

DEPLOY_ROOT=/srv/deploy-controller
NEW_VOLUME=deploy-controller-data-v2
MIGRATION_IMAGE=deploy-controller-migration:local

if [ -e "$DEPLOY_ROOT" ]; then
  echo 'Ya existe /srv/deploy-controller. No lo sobrescribas; revisa el intento anterior.'
  exit 1
fi
if docker volume inspect "$NEW_VOLUME" >/dev/null 2>&1; then
  echo 'Ya existe el volumen nuevo. No continúes sin revisar su contenido.'
  exit 1
fi

install -d -m 700 "$DEPLOY_ROOT/source" "$DEPLOY_ROOT/persistent" "$DEPLOY_ROOT/migration"
SOURCE_DIR="$DEPLOY_ROOT/source"
PERSISTENT="$DEPLOY_ROOT/persistent"
CUTOVER="$DEPLOY_ROOT/migration"
export SOURCE_DIR PERSISTENT CUTOVER
declare -p DEPLOY_ROOT NEW_VOLUME MIGRATION_IMAGE SOURCE_DIR PERSISTENT CUTOVER > "$CUTOVER/session.sh"

tar -xzf /root/deploy-controller-migracion.tar.gz -C "$SOURCE_DIR"
test -f "$SOURCE_DIR/scripts/import-legacy-state.py"
test -f "$SOURCE_DIR/examples/tickit-pos.json"

docker version
docker compose version
df -h /srv /var/lib/docker

docker build --target worker \
  -f "$SOURCE_DIR/infra/deploy-controller/Dockerfile" \
  -t "$MIGRATION_IMAGE" "$SOURCE_DIR"
```

La construcción descarga las herramientas fijadas por el Dockerfile. **No arranca
el worker ni despliega POS.** Si falla, el controller antiguo todavía está intacto.

## 4. VPS: identificar exactamente los contenedores antiguos

```bash
docker ps --format 'table {{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.service"}}'
```

Busca el servicio `deploy-worker` del controller **antiguo**. Copia su ID y
sustituye `TU_ID_WORKER_ANTIGUO`:

```bash
OLD_WORKER=TU_ID_WORKER_ANTIGUO

test "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$OLD_WORKER")" = deploy-worker
docker exec "$OLD_WORKER" test -f /etc/tickit-deploy/controller.json

OLD_PROJECT=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$OLD_WORKER")
mapfile -t OLD_APIS < <(docker ps \
  --filter "label=com.docker.compose.project=$OLD_PROJECT" \
  --filter 'label=com.docker.compose.service=deploy-api' --format '{{.ID}}')
test "${#OLD_APIS[@]}" -eq 1
OLD_API=${OLD_APIS[0]}

OLD_BACKUPS_SOURCE=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/opt/pos-deploy/backups"}}{{.Source}}{{end}}{{end}}' "$OLD_WORKER")
test -n "$OLD_BACKUPS_SOURCE"
test -d "$OLD_BACKUPS_SOURCE"

printf 'Worker antiguo: %s\nAPI antigua: %s\nProyecto Docker antiguo: %s\n' "$OLD_WORKER" "$OLD_API" "$OLD_PROJECT"
du -sh "$OLD_BACKUPS_SOURCE"
df -h "$PERSISTENT"
declare -p DEPLOY_ROOT NEW_VOLUME MIGRATION_IMAGE SOURCE_DIR PERSISTENT CUTOVER OLD_WORKER OLD_API OLD_PROJECT OLD_BACKUPS_SOURCE > "$CUTOVER/session.sh"
```

Necesitas espacio libre para **otra copia de los backups**, más el estado y los
logs. El original permanece donde está. Si no cabe, amplía el disco o utiliza
otro almacenamiento persistente antes de seguir.

Si se corta SSH, vuelve como root y recupera las variables con:

```bash
set -euo pipefail
umask 077
source /srv/deploy-controller/migration/session.sh
```

## 5. VPS: cerrar la entrada y comprobar la cola

Ahora detén **solo la API del controller** para impedir nuevas solicitudes:

```bash
docker stop -t 30 "$OLD_API"

docker exec -i "$OLD_WORKER" node --input-type=module <<'JS'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/var/lib/tickit-deploy/state.sqlite', {readOnly:true});
console.table(db.prepare('SELECT id,environment,status,reconciled,error FROM deployments ORDER BY created_at DESC LIMIT 15').all());
const pending = db.prepare("SELECT count(*) AS n FROM deployments WHERE status NOT IN ('success','failed','interrupted','cancelled')").get();
db.close();
if (Number(pending.n)) {
  console.error('STOP: quedan solicitudes queued o activas. No pares el worker ni importes todavía.');
  process.exitCode = 1;
}
JS
```

Debe terminar sin `STOP`. Si hay una operación activa, espera y repite la
comprobación. Si está en `awaiting_approval`, decide por Telegram.

Si hay `queued` bloqueados detrás de un fallo, revisa primero ese fallo. Por
ejemplo, sustituyendo el UUID:

```bash
docker exec "$OLD_WORKER" tail -n 100 /var/lib/tickit-deploy/logs/TU_UUID.log
```

Un estado `failed` o `interrupted` sin reconciliar **se conservará** y seguirá
bloqueando su entorno. Solo después de verificar los efectos reales de esa
operación se puede ejecutar, en el worker antiguo:

```bash
docker exec "$OLD_WORKER" node /opt/tickit/apps/deploy-controller/src/worker.ts reconcile TU_UUID
```

Esto no revierte SQL ni acredita que una migración haya terminado. Para reactivar
solicitudes ya encoladas puede ser necesario volver a abrir la API y enviar una
solicitud autorizada. Para volver a abrir la API:

```bash
docker start "$OLD_API"
```

Reactiva temporalmente solo el gate del entorno revisado y utiliza su workflow
antiguo para enviar una solicitud: **puede ejecutar los despliegues pendientes**.
Cuando terminen, vuelve a poner los gates privados en `false`, para otra vez la
API con `docker stop -t 30 "$OLD_API"` y repite la comprobación de cola.
Si prefieres no ejecutar esos pendientes, detén el procedimiento y revisa su
cancelación; no los borres de SQLite. Si no puedes confirmar qué
se aplicó, detén aquí el traslado y revisa el log privado.

## 6. VPS: guardar los secretos antes de parar el worker

**Este paso tiene que hacerse con el worker todavía encendido.** `/etc/tickit-deploy`
es temporal y se pierde al pararlo.

```bash
install -d -m 700 "$CUTOVER/runtime" "$CUTOVER/source-data" "$CUTOVER/receiver-logs"

docker inspect "$OLD_WORKER" > "$CUTOVER/old-worker.inspect.json"
docker cp "$OLD_WORKER:/etc/tickit-deploy/." "$CUTOVER/runtime/"
cp "$SOURCE_DIR/examples/tickit-pos.json" "$CUTOVER/pos-template.json"
chmod -R go-rwx "$CUTOVER"

docker stop -t 60 "$OLD_WORKER"
test "$(docker inspect -f '{{.State.Running}}' "$OLD_WORKER")" = false
test "$(docker inspect -f '{{.State.Running}}' "$OLD_API")" = false

docker cp "$OLD_WORKER:/var/lib/tickit-deploy/." "$CUTOVER/source-data/"
docker cp "$OLD_WORKER:/var/log/pos-deploy/." "$CUTOVER/receiver-logs/"
chmod -R go-rwx "$CUTOVER"
test -f "$CUTOVER/source-data/state.sqlite"
```

`docker cp` permite copiar desde contenedores detenidos; el estado se copia
después de parar el worker para conservar SQLite y sus archivos WAL coherentes.
[Referencia de Docker](https://docs.docker.com/reference/cli/docker/container/cp/).

La carpeta `migration` contiene credenciales. No la subas a GitHub, ni pegues
su contenido en el chat. Los comandos no imprimen las claves ni el token.

## 7. VPS: convertir las variables para el controller nuevo

Copia este bloque completo. Recupera la configuración utilizada por el worker,
mantiene recursos/credenciales/aprobaciones y prepara tres variantes de activación.
La identidad de POS es `Chapuzalia/POS`, ID `1291169434`; el antiguo nombre
`daviidsolv/POS` resuelve actualmente al mismo repositorio. **No pongas aquí el
nombre del repositorio nuevo del controller.**

```bash
docker run --rm -i --network none \
  --mount "type=bind,src=$CUTOVER,dst=/migration" \
  --entrypoint /usr/bin/python3 "$MIGRATION_IMAGE" -B - <<'PY'
# PREPARAR_CONFIGURACION_MIGRACION
import copy
import importlib.util
import json
from pathlib import Path
import re
import subprocess

root = Path('/migration')
installed = Path('/opt/deploy-controller')
snapshot = json.loads((root / 'old-worker.inspect.json').read_text())
env = dict(item.split('=', 1) for item in snapshot[0]['Config']['Env'] if '=' in item)
old = json.loads((root / 'runtime/controller.json').read_text())
raw = json.loads(env.get('DEPLOY_CONTROLLER_CONFIG', '{}'))
assert str(old['repositoryId']) == '1291169434', 'El ID no corresponde al repositorio POS esperado; revisar antes de continuar.'
assert 'projects' not in old, 'Esta configuracion ya pertenece al controller nuevo.'

def secret(name, filename):
    value = env.get(name, '')
    path = root / 'runtime' / filename
    return value or (path.read_text() if path.is_file() else '')

key = secret('DEPLOY_REPOSITORY_KEY', 'repository_ed25519').replace('\r\n', '\n').rstrip() + '\n'
known_hosts = secret('DEPLOY_GITHUB_KNOWN_HOSTS', 'github_known_hosts').rstrip() + '\n'
assert key.startswith('-----BEGIN OPENSSH PRIVATE KEY-----'), 'Falta la deploy key antigua.'
assert known_hosts.strip(), 'Faltan las claves verificadas de GitHub.'
token = env.get('DEPLOY_TELEGRAM_BOT_TOKEN', '')
chat = env.get('DEPLOY_TELEGRAM_CHAT_ID', '')
rules = json.loads((root / 'pos-template.json').read_text())['projects']['tickit-pos']['environments']['production']['receiver']['migration_compatibility']
environments = {}
for name, branch, workflow, events in [
    ('production', 'main', 'production.yml', ['push']),
    ('staging', 'Staging', 'staging.yml', ['push', 'workflow_dispatch']),
]:
    policy = copy.deepcopy(old['environments'][name])
    policy.update(branch=branch, workflow=workflow, events=events)
    policy.pop('receiverPolicySha256', None)
    path = root / 'runtime' / f'receiver.{name}.json'
    receiver = json.loads(path.read_text()) if path.is_file() else copy.deepcopy(raw.get('environments', {}).get(name, {}).get('receiver'))
    if receiver is not None:
        telegram = receiver.get('telegram', {})
        token = token or telegram.get('bot_token', '')
        chat = chat or telegram.get('chat_id', '')
        # Executables and state paths now belong to the new image/project.
        for field in ('environment', 'project', 'repository', 'supabase_bin', 'supabase_version', 'node_bin',
                      'migration_safety_checker', 'backup_dir', 'log_dir', 'migration_history_file', 'telegram'):
            receiver.pop(field, None)
        receiver['migration_compatibility'] = copy.deepcopy(rules)
        receiver.setdefault('deploy_edge', True)
        policy['receiver'] = receiver
    assert not policy['enabled'] or receiver is not None, 'Falta receiver de un entorno activo.'
    environments[name] = policy
assert re.fullmatch(r'-[1-9][0-9]{0,18}', str(chat)), 'Falta el grupo Telegram; recuperarlo de la configuracion antigua.'

project = {'name': 'Tickit POS', 'repository': 'Chapuzalia/POS', 'repositoryId': str(old['repositoryId']),
           'telegramChatId': str(chat), 'environments': environments}
active = {'audience': old.get('audience', 'https://deploy.alteilsolutions.com'), 'projects': {'tickit-pos': project}}
disabled = copy.deepcopy(active)
for policy in disabled['projects']['tickit-pos']['environments'].values():
    policy['enabled'] = False
staging = copy.deepcopy(active)
staging['projects']['tickit-pos']['environments']['production']['enabled'] = False

spec = importlib.util.spec_from_file_location('startup', installed / 'scripts/start-deploy-worker.py')
startup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(startup)
validator = "import {readFileSync} from 'node:fs'; import {validateConfig} from '" + (installed / 'apps/deploy-controller/src/config.ts').as_uri() + "'; validateConfig(JSON.parse(readFileSync(0,'utf8')));"
variants = {'controller.disabled.json': disabled, 'controller.staging.json': staging, 'controller.original-gates.json': active}
for value in variants.values():
    prepared = startup.configuration_files(json.dumps(value), telegram_token=token)
    check = subprocess.run(['node', '--input-type=module', '-e', validator], input=prepared['controller.json'], text=True, capture_output=True)
    assert check.returncode == 0, 'La politica nueva no valida. Revisar destinos, ramas, audiencia y credenciales; no continuar.'
    assert not token or token not in prepared['controller.json'], 'El bot no puede quedar en la politica HTTP.'

output = root / 'coolify'
output.mkdir(mode=0o700, exist_ok=False)
values = {name: json.dumps(value, separators=(',', ':')) for name, value in variants.items()}
values.update({'repository-keys.json': json.dumps({'tickit-pos': key}, separators=(',', ':')),
               'github-known-hosts.txt': known_hosts, 'telegram-bot-token.txt': token})
for name, value in values.items():
    path = output / name
    path.write_text(value, encoding='utf-8')
    path.chmod(0o600)
print('Configuracion validada y guardada en migration/coolify. No se han mostrado secretos.')
print('Staging estaba habilitado:', environments['staging']['enabled'])
print('Produccion estaba habilitada:', environments['production']['enabled'])
print('Token Telegram recuperado:', bool(token))
PY
```

Si el token no se ha recuperado, introdúcelo después desde su ubicación privada
en Coolify. Sin token, las migraciones sensibles fallarán de forma cerrada.
No cambies el bot por uno compartido con otra aplicación.

La conversión conserva los gates originales. Si staging estaba deshabilitado,
`controller.staging.json` **no lo habilita ni inventa sus recursos**.

## 8. VPS: importar el historial y los backups

El destino `persistent/data` todavía no debe existir. La herramienta conserva
los estados fallidos y hashes anteriores; no modifica los contenedores Supabase.

```bash
test ! -e "$PERSISTENT/data"

docker run --rm --network none \
  --mount "type=bind,src=$CUTOVER,dst=/migration,readonly" \
  --mount "type=bind,src=$OLD_BACKUPS_SOURCE,dst=/legacy-backups,readonly" \
  --mount "type=bind,src=$PERSISTENT,dst=/target" \
  --mount type=bind,src=/run/lock,dst=/run/lock \
  --entrypoint /usr/bin/python3 "$MIGRATION_IMAGE" -B \
  /opt/deploy-controller/scripts/import-legacy-state.py \
  --source /migration/source-data \
  --destination /target/data \
  --project tickit-pos \
  --backups /legacy-backups \
  --receiver-logs /migration/receiver-logs

test -f "$PERSISTENT/data/state.sqlite"
diff -qr "$OLD_BACKUPS_SOURCE" "$PERSISTENT/data/legacy-backups"
diff -qr "$CUTOVER/receiver-logs" "$PERSISTENT/data/legacy-receiver-logs"
```

Los `diff` deben terminar sin mostrar diferencias. Los backups importados quedan
archivados y excluidos de la retención automática. Los originales siguen intactos.

Comprueba SQLite y la asignación del proyecto:

```bash
docker run --rm -i --network none \
  --mount "type=bind,src=$PERSISTENT/data,dst=/data,readonly" \
  --entrypoint /usr/bin/python3 "$MIGRATION_IMAGE" -B - <<'PY'
import sqlite3
from contextlib import closing
with closing(sqlite3.connect('file:/data/state.sqlite?mode=ro', uri=True)) as db:
    assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    assert not db.execute("SELECT 1 FROM deployments WHERE project <> 'tickit-pos'").fetchone()
    print('SQLite: OK')
    for row in db.execute('SELECT project,environment,status,reconciled,count(*) FROM deployments GROUP BY project,environment,status,reconciled'):
        print(row)
PY
```

## 9. VPS: crear el volumen que utilizará Coolify

```bash
if docker volume inspect "$NEW_VOLUME" >/dev/null 2>&1; then
  echo 'El volumen ya existe: revisar antes de continuar.'
  exit 1
fi

docker volume create --driver local \
  --opt type=none --opt o=bind \
  --opt "device=$PERSISTENT/data" \
  "$NEW_VOLUME"

docker volume inspect --format '{{json .Options}}' "$NEW_VOLUME"
```

Debe mostrar `device` apuntando a `/srv/deploy-controller/persistent/data`.
**Esa carpeta es ahora almacenamiento permanente. No la borres al terminar.**
El Compose publicado usa este nombre mediante `external: true`, de modo que no
inicializa una cola distinta. [Referencia de Docker sobre volúmenes externos y
volúmenes con directorio del host](https://docs.docker.com/reference/compose-file/volumes/).

## 10. Coolify: crear la aplicación nueva y arrancarla deshabilitada

En Coolify:

1. Crea un proyecto llamado, por ejemplo, **Deploy Controller**.
2. Dentro crea un recurso desde el repositorio GitHub **nuevo** `deploy-controller`.
   Puedes usar la GitHub App de Coolify para acceder al repositorio privado.
3. Selecciona la rama `codex/independent-controller` que has publicado.
4. Build strategy / Build Pack: **Docker Compose**.
5. Base Directory: `/`.
6. Docker Compose Location: `/docker-compose.deploy-controller.yml`.
7. Advanced → Docker compose → Compose deployment: **Raw (deploy file as-is)**.
8. Desactiva Auto Deploy del controller nuevo. No le asignes un dominio directo.

Estos ajustes corresponden a una aplicación Compose basada en Git, no al recurso
“Docker Compose Empty”. [Documentación de Coolify](https://coolify.io/docs/applications/builds/docker-compose).

Añade estas variables en **Environment Variables**, preferiblemente en Normal view.
Todas son **Runtime sí, Build time no y Literal sí**; márcalas privadas.

| Variable en Coolify | Contenido del archivo del VPS |
| --- | --- |
| `DEPLOY_CONTROLLER_CONFIG` | `/srv/deploy-controller/migration/coolify/controller.disabled.json` |
| `DEPLOY_REPOSITORY_KEYS` | `/srv/deploy-controller/migration/coolify/repository-keys.json` |
| `DEPLOY_GITHUB_KNOWN_HOSTS` | `/srv/deploy-controller/migration/coolify/github-known-hosts.txt` |
| `DEPLOY_TELEGRAM_BOT_TOKEN` | `/srv/deploy-controller/migration/coolify/telegram-bot-token.txt` |

Para copiar un valor a **tu panel privado** puedes abrir su archivo con
`nano -v RUTA_DEL_ARCHIVO` en el VPS. No copies el nombre del archivo como valor:
Coolify necesita **su contenido**. No añadas comillas externas al JSON. Para
known_hosts activa el formato multilínea si contiene varias líneas. El JSON
de claves ya contiene los saltos de línea escapados correctamente.

Los secretos deben estar disponibles solo en el contenedor, no durante build.
[Documentación de variables de Coolify](https://coolify.io/docs/applications/configuration/environment-variables).

Pulsa **Deploy** de la aplicación nueva. Deben aparecer saludables `deploy-worker`
y `deploy-api`. Ambos entornos de POS están todavía deshabilitados.

No cambies Cloudflare si el Tunnel ya apunta a `http://127.0.0.1:18081`.
Si utilizaba `18080`, cambia únicamente el origen al puerto `18081`, conservando
dominio y protección Access. No abras ese puerto públicamente.

## 11. VPS: comprobar que lee los datos importados

```bash
docker ps --format 'table {{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.service"}}'
curl --fail --silent --show-error http://127.0.0.1:18081/health
```

El health debe devolver `{"status":"ok"}`. Copia el ID del **nuevo** worker:

```bash
NEW_WORKER=TU_ID_WORKER_NUEVO
test "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$NEW_WORKER")" = deploy-worker
docker exec "$NEW_WORKER" test -f /etc/deploy-controller/controller.json

docker exec -i "$NEW_WORKER" node --input-type=module <<'JS'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/var/lib/deploy-controller/state.sqlite', {readOnly:true});
console.table(db.prepare('SELECT id,project,environment,status,reconciled FROM deployments ORDER BY created_at DESC LIMIT 15').all());
db.close();
JS

docker logs --tail 80 "$NEW_WORKER"
```

Los IDs y estados deben corresponder a los que veías antes, ahora con proyecto
`tickit-pos`. Si aparece una cola vacía cuando antes tenía historial, **no actives**
los entornos: comprueba que el Compose apunta al volumen externo importado.

## 12. Publicar el cliente POS y activar los entornos

El cliente nuevo y el controller antiguo son incompatibles. El worker nuevo ya
debe estar saludable antes de publicar/activar las solicitudes nuevas.

En el **PC / PowerShell**, revisa los cambios preparados en POS:

```powershell
Set-Location 'C:\Users\david\Desktop\CRAFO\chapuzalia\inmobiliaria\chapu\POS'
git status --short
git diff --stat
git branch --show-current
```

Publícalos mediante tu flujo habitual de commit/PR hacia `Staging`, manteniendo
los dos gates privados en `false`. El bloque siguiente supone que estás en la
rama **Staging** y que todo lo pendiente pertenece a esta extracción; si no es
así, prepara primero el commit/PR correspondiente sin mezclar otros cambios:

```powershell
git add -A
git commit -m "refactor: use independent deploy controller"
git push origin Staging
```

### Primero staging, si ya lo tenías configurado

1. En el controller nuevo de Coolify cambia **solo** `DEPLOY_CONTROLLER_CONFIG`
   por el contenido de `controller.staging.json`. Guarda y pulsa **Redeploy**.
2. Espera a que API y worker estén saludables. La producción permanece deshabilitada.
3. En GitHub/POS pon `PRIVATE_DEPLOY_STAGING_ENABLED=true` y
   `STAGING_DEPLOY_ENABLED=true`.
4. Actions → workflow de staging → **Run workflow** → rama **Staging** →
   `mode=deploy`.
5. Debe avanzar por los estados hasta `success`. Si aparece `awaiting_approval`,
   el bot debe mostrar proyecto, migración, motivos y los botones.

Si staging no estaba configurado, no lo actives con valores de ejemplo. Puedes
completar sus recursos primero; el traslado del estado no crea un Supabase nuevo.

### Después producción

1. Integra el cliente ya probado en la rama `main` mediante tu PR habitual,
   **todavía con `PRIVATE_DEPLOY_PRODUCTION_ENABLED=false`**.
2. En Coolify cambia la variable del controller por
   `controller.original-gates.json`. Conserva los entornos y recursos originales.
   Guarda, pulsa **Redeploy** y comprueba los healthchecks. Si producción estaba
   deshabilitada antes, este archivo también la deja deshabilitada: habilítala
   explícitamente solo con una configuración real y revisada.
3. En GitHub/POS pon `PRIVATE_DEPLOY_PRODUCTION_ENABLED=true`.

El siguiente bloque **solicita un despliegue real de producción**. Ejecútalo solo
cuando quieras activarlo, con el cliente nuevo ya integrado en main y sin cambios
locales pendientes. El workflow de producción se dispara por push, no tiene botón
`Run workflow`:

```powershell
Set-Location 'C:\Users\david\Desktop\CRAFO\chapuzalia\inmobiliaria\chapu\POS'
git switch main
git pull --ff-only origin main
git commit --allow-empty -m "chore: verify independent deploy controller"
git push origin main
```

Comprueba en Actions que termina en `success`. Mantén el controller antiguo
detenido y su Auto Deploy desactivado. No borres todavía sus contenedores,
volúmenes ni backups.

## 13. Si algo se queda parado

Recupera el ID actual del worker después de cada Redeploy; Coolify puede recrearlo.

| Estado | Qué comprobar |
| --- | --- |
| `queued` | Otro trabajo activo o fallo no reconciliado del mismo proyecto/entorno |
| `preflight` | Clave Git, known_hosts, SHA y aplicación/rama de Coolify |
| `awaiting_approval` | Telegram, bot admin del grupo, webhook y otros consumidores |
| `failed` / `interrupted` | Log privado y efectos reales antes de reconciliar |

En **VPS / Bash**, con el ID actual de worker y el UUID que sale en Actions:

```bash
NEW_WORKER=TU_ID_WORKER_NUEVO
DEPLOYMENT_ID=TU_UUID_DEL_DEPLOY
docker logs --tail 100 "$NEW_WORKER"
docker exec "$NEW_WORKER" tail -n 120 "/var/lib/deploy-controller/logs/$DEPLOYMENT_ID.log"
docker exec "$NEW_WORKER" ls -lt /var/lib/deploy-controller/projects/tickit-pos/production/receiver-logs
```

El log del trabajo indica el archivo privado del receptor si llegó a ejecutarse.
Con `queued` puede no existir todavía un log. No pegues logs con SQL o secretos
sin revisarlos antes.

Comprobación de Telegram **sin enviar mensajes ni consumir respuestas**; requiere
que al menos un entorno esté habilitado:

```bash
docker exec -i "$NEW_WORKER" python3 - <<'PY'
import importlib.util
import json
from pathlib import Path
files = sorted(Path('/etc/deploy-controller').glob('receiver.tickit-pos.*.json'))
assert files, 'Primero habilita un entorno configurado.'
settings = json.loads(files[0].read_text()).get('telegram')
assert settings, 'No se ha configurado Telegram para este proyecto.'
spec = importlib.util.spec_from_file_location('telegram', '/opt/deploy-controller/scripts/telegram_migration_approval.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
api = module.TelegramClient(settings['bot_token'])
bot = api('getMe', {})
webhook = api('getWebhookInfo', {})
member = api('getChatMember', {'chat_id': settings['chat_id'], 'user_id': bot['id']})
print({'bot': bot.get('username'), 'grupo': settings['chat_id'],
       'bot_es_admin': member.get('status') in ('administrator', 'creator'),
       'tiene_webhook': bool(webhook.get('url'))})
PY
```

Debe mostrar `bot_es_admin: True` y `tiene_webhook: False`. El bot tiene que estar
dedicado a esta instancia y añadido al grupo; sus miembros pueden aprobar.
**Sin migraciones sensibles pendientes no se envía ningún mensaje: es normal.**

Solo tras comprobar y reconciliar los efectos de un fallo real:

```bash
docker exec "$NEW_WORKER" node /opt/deploy-controller/apps/deploy-controller/src/worker.ts reconcile TU_UUID_DEL_FALLO
```

Después envía una solicitud nueva desde GitHub. No marques todos los fallos como
reconciliados ni vacíes las tablas para desbloquear la cola.

## 14. Recuperación si falla antes del primer deploy nuevo

Si el nuevo controller todavía **no ha ejecutado ninguna release**, puedes:

1. Mantener ambos gates privados de GitHub en `false`.
2. Parar la aplicación nueva desde Coolify y comprobar que no sigue su worker.
3. Mantener el cliente nuevo sin enviar solicitudes al controller antiguo.
4. En VPS, arrancar los contenedores antiguos:

```bash
set -euo pipefail
umask 077
source /srv/deploy-controller/migration/session.sh
docker start "$OLD_WORKER"
docker start "$OLD_API"
```

Si cambiaste el puerto del Tunnel, devuelve su origen al puerto anterior.
No habilites CI hasta que el cliente vuelva a corresponder al controller activo.

**Si el controller nuevo ya ejecutó o intentó un deploy, incluso fallido, no
apliques esa receta sin revisar sus efectos.** Puede haber SQL aplicado o Edge
actualizado. No restaures un dump de PostgreSQL: podrían existir ventas posteriores.

## Al terminar

- Nuevo controller saludable en su propio proyecto de Coolify.
- Historial importado y proyecto `tickit-pos` visible.
- Staging/producción activados solo después de verificar sus configuraciones.
- Una solicitud real termina en `success`.
- Controller antiguo detenido, con su estado original conservado.
- `/srv/deploy-controller/persistent/data` preservado y respaldado como datos
  permanentes. No hacer limpiezas de la carpeta `/srv/deploy-controller`.

Esta guía prepara el procedimiento; no acredita una prueba en tu VPS. El arranque
real, conectividad de Coolify/Supabase y entrega de Telegram se verifican al ejecutarla.
