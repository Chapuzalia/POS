# Deploy Controller en Coolify

Se despliega como **una aplicación Docker Compose en Coolify**. Coolify
construye, arranca y actualiza API y worker. No hay instalador, servicio
systemd ni runtime que instalar manualmente en el VPS.

```text
GitHub CI → Cloudflare Access/Tunnel → API → worker → SQL/Edge → Coolify POS
```

La API no tiene secretos, acceso a Docker ni permisos root. Solo el worker
interno tiene los permisos del receptor existente. Se comunican por socket
Unix; SQLite, mirror y logs persisten en el volumen `deploy-data`.

## Crear la aplicación

1. En Coolify: **New resource → Git repository**, elegir `Chapuzalia/POS`
   y la rama que contenga estos archivos.
2. Seleccionar **Docker Compose**:
   - Base Directory: `/`.
   - Docker Compose Location: `/docker-compose.deploy-controller.yml`.
   En Advanced → Docker compose, usar **Raw (deploy file as-is)** para
   conservar la red del worker y los montajes declarados. El Compose ya define
   puertos, dependencias y healthchecks; no necesita rutas del proxy de Coolify.
3. Deshabilitar auto-deploy del controller; sus actualizaciones son manuales,
   independientes de los commits que despliega en POS.
4. Añadir estas tres variables privadas de runtime, sin habilitarlas para build:

   | Variable | Contenido |
   | --- | --- |
   | `DEPLOY_CONTROLLER_CONFIG` | JSON basado en `infra/deploy-controller/controller.example.json` |
   | `DEPLOY_REPOSITORY_KEY` | Clave OpenSSH de una deploy key de solo lectura de `Chapuzalia/POS` |
   | `DEPLOY_GITHUB_KNOWN_HOSTS` | Claves públicas verificadas de `github.com` en formato known_hosts |

   La deploy key del worker es independiente de la conexión Git de Coolify.
5. Revisar los montajes del Compose: el worker reutiliza
   `/data/coolify/services`, `/opt/pos-deploy/backups` y los locks de `/run/lock`.
   Solo él monta Docker socket. La API publica `127.0.0.1:18080` para el Tunnel.
   No asignar un dominio público directo que permita evitar Cloudflare Access.
6. Mantener los dos entornos con `enabled: false` y, con autorización para
   instalarlo, pulsar **Deploy**. API y worker deben aparecer healthy.
   Arrancar así el controller no despliega POS ni ejecuta SQL.

La imagen incluye Node, Python, Git, Docker CLI y Supabase CLI **2.121.0**
verificada por SHA-256. El arranque prepara configuración y mirror
automáticamente, dentro del contenedor. El worker usa la red del host para
alcanzar Supabase y Coolify privados; solo escucha en su socket Unix.

Referencias: [Compose en Coolify](https://coolify.io/docs/applications/builds/docker-compose),
[claves SSH públicas de GitHub](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints).

## El JSON de configuración

Usar `controller.example.json` y sustituir los campos del entorno que se vaya
a habilitar. El otro puede permanecer desactivado:

- `repositoryId`: ID numérico inmutable de `Chapuzalia/POS`.
- `audience`: `https://deploy.alteilsolutions.com`.
- Cada entorno tiene su propio `enabled`, Access Client ID y digest SHA-256
  del Client Secret, `healthUrl` y configuración `coolify`.
- `coolify` contiene URL privada, UUID y token de la aplicación **POS**;
  `SUPPORTED_APP_VERSIONS` enumera los SHAs compatibles separados por comas.
- `healthUrl` es el `/app-version.json` HTTPS del frontend del entorno.
- `receiver` contiene proyecto Supabase, red Docker, migración de guarda
  existente y aprobaciones SQL. Verificar esos recursos antes de habilitarlo.

Los ejecutables y rutas de trabajo son fijos en la imagen. No hay que crear
archivos de configuración en el host. Las aprobaciones se administran en
`receiver` dentro de la variable privada de Coolify, nunca en el checkout
descargado ni en una petición HTTP.

Calcular el digest Access sin imprimir el secreto:

```bash
python3 -c 'import getpass,hashlib; print(hashlib.sha256(getpass.getpass("Access secret: ").encode()).hexdigest())'
```

## Cloudflare y GitHub

1. Crear o reutilizar un Cloudflare Tunnel.
2. Añadir `deploy.alteilsolutions.com` con origen `http://127.0.0.1:18080`
   si el conector corre en el host. Si es otro contenedor, conectarlo a la
   red de la API y usar su nombre de servicio con puerto `8080`;
   `127.0.0.1` dentro de ese conector no es el VPS.
3. Crear una aplicación Access self-hosted para **todo** el hostname,
   incluidas las rutas de estado y `/health`.
4. Crear dos Service Tokens y políticas **Service Auth**, uno por entorno.
   No crear políticas Bypass.
5. Configurar estos GitHub Secrets y los ID/digest equivalentes en Coolify:

   | Producción | Staging |
   | --- | --- |
   | `PROD_DEPLOY_CF_ACCESS_CLIENT_ID` | `STAGING_DEPLOY_CF_ACCESS_CLIENT_ID` |
   | `PROD_DEPLOY_CF_ACCESS_CLIENT_SECRET` | `STAGING_DEPLOY_CF_ACCESS_CLIENT_SECRET` |

6. Access usa `CF-Access-Client-Id` y `CF-Access-Client-Secret`.
   En cada POST y consulta de estado, `scripts/request-deployment.mjs` envía
   también `X-Tickit-Deploy-Client-Id` y `X-Tickit-Deploy-Client-Secret` con
   los mismos valores, siempre por HTTPS. Esta segunda pareja permite al
   worker validar las credenciales aunque Access consuma o modifique las
   cabeceras originales. El gateway reenvía al worker por socket Unix solo
   la pareja `X-Tickit-Deploy-*` y `Authorization`, además de las cabeceras
   de contenido necesarias; no reenvía la pareja `CF-Access-*`.
   El worker exige el Client ID del entorno y compara en tiempo constante
   el SHA-256 del secreto con el digest configurado, sin registrar credenciales
   ni incluirlas en respuestas. No se necesitan secretos nuevos.
   `Authorization: Bearer …` queda reservado para GitHub OIDC, que sigue
   siendo obligatorio: el Service Token por sí solo no autoriza despliegues.
7. Probar `/health`: sin credenciales Access no debe devolver 200; con Access
   válido debe devolver 200. Un POST con la pareja propia válida pero sin
   OIDC devuelve 401; sin esa pareja o con valores incorrectos devuelve 403.
8. Confirmar que Coolify sigue accesible solo por Tailscale y que PostgreSQL
   y SSH no tienen nuevas rutas públicas.

El worker verifica firma, issuer, audience, repositorio/ID, workflow, rama,
evento, SHA, ejecución y caducidad. Staging no autoriza producción. GitHub no recibe
credenciales PostgreSQL, SSH del VPS ni tokens de Coolify.

Referencia: [Access Service Tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

## Activar staging y después producción

1. Esperar a que termine cualquier despliegue anterior y desactivar la ruta
   automática SSH. Mantener deshabilitado auto-deploy de la aplicación POS.
2. Completar recursos y revisión del historial de staging. Habilitar solo
   `environments.staging.enabled` en el JSON de Coolify y redeplegar el
   controller con la cola vacía.
3. En GitHub Variables establecer `STAGING_DEPLOY_ENABLED=true` y
   `PRIVATE_DEPLOY_STAGING_ENABLED=true`.
4. Ejecutar `staging.yml` desde `Staging`, con `mode=deploy`.
5. Verificar SQL pendiente, backup si procede, Edge, SHA efectivo de Coolify y
   `/app-version.json`. Repetir el mismo SHA: debe crear otra operación sin
   reaplicar SQL registrado.
6. Probar fallos y recuperación antes de solicitar permiso para producción.
   Sus gates `environments.production.enabled` y
   `PRIVATE_DEPLOY_PRODUCTION_ENABLED` permanecen desactivados por defecto.

Cada ejecución/intento de GitHub crea un request_id nuevo. Reintentar HTTP
con el mismo ID deduplica durante 24 horas. Ninguno necesita un SHA anterior.

## Migraciones y PWA

PostgreSQL es la autoridad para pendientes. El receptor rechaza commits que
omitan migraciones aplicadas y comprueba sus hashes. Con pendientes valida
seguridad, verifica backup, hace dry-run, aplica y comprueba el ledger final.
Sin pendientes omite backup y push; Edge y frontend siguen ejecutándose.
No hay downgrade ni restauración SQL automática.

La primera incorporación de una base existente necesita revisar el contenido
aplicado y autorizar `receiver.migration_history_bootstrap`, con entorno,
caducidad UTC y fingerprint. Se calcula sobre SQL preparado y el conjunto
real de versiones aplicadas:

```bash
node /opt/tickit/scripts/pending-migration-safety.mjs --history-hash < revision.json
```

`revision.json` contiene `directory` de SQL preparado y `applied`, array de
versiones reales. Ejecutar en el terminal del worker sobre fuentes revisadas.
No aprobar automáticamente la primera petición. Retirar la autorización tras
inicializar el registro persistente. SQL destructivo y bloques DO requieren
aprobación exacta por archivo, contenido, entorno y caducidad. Ver
[migraciones seguras](safe-production-migrations.md).

Las versiones PWA admitidas persisten en SQLite. No se retiran por desplegar
otro commit. Para retirarlas, revisar compatibilidad y declarar
`retiredAppVersions` en el JSON del entorno.

## Operación desde Coolify

- **Logs:** Runtime Logs del worker, `/var/lib/tickit-deploy/logs/<id>.log`
  y `/var/log/pos-deploy`. No publicar salidas completas.
- **Actualizar:** con la cola vacía y autorización, editar variables o elegir
  otra revisión y pulsar Deploy. Conservar los volúmenes.
- **Interrupciones:** los trabajos activos quedan `interrupted` tras reinicio.
  Los fallidos/interrumpidos bloquean su entorno hasta revisión.
- **Reconciliar:** comprobar ledger, Edge, backups y cola/SHA de Coolify.
  Después de autorizarlo, ejecutar en el terminal del worker:
  `node /opt/tickit/apps/deploy-controller/src/worker.ts reconcile UUID`.
  Enviar una nueva solicitud para continuar la cola.
- **Backups:** se conserva la carpeta existente del VPS. La retención está
  deshabilitada por defecto. `deploy-backup-retention.py` muestra un plan;
  `--apply` requiere autorización de borrado. Copias externas y objetos de
  Supabase Storage requieren su propia estrategia de backup/restauración.
- **Recuperar:** Edge conserva snapshots. Un fallo de frontend no restaura
  la base. Usar una migración correctiva o un commit compatible que conserve
  todo el historial aplicado.

## Verificación local

El Compose exige las tres variables incluso al validarlo; para `config
--quiet` pueden usarse valores ficticios. Las pruebas no usan producción.

```bash
docker compose -f docker-compose.deploy-controller.yml config --quiet
pnpm run build:deploy-controller
python3 -B -m unittest discover -s tests -p 'test_*.py'
pnpm test
pnpm lint
```

El build real de imágenes y la conectividad Docker/Tailscale deben verificarse
en Coolify staging: el daemon Docker local no estaba disponible. Estos cambios
no han instalado ni activado el controller en el VPS.
