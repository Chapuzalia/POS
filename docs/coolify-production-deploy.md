# Despliegue de main en Coolify

## Recursos y orden

La inspección del VPS del 2026-10-19 identificó estos recursos de `Tickit TPV / production`:

| Recurso | UUID / proyecto Compose |
| --- | --- |
| Supabase | `dbdtluvsdqycxl5tecuwljie` |
| `tickit-frontend` | `ezpjwb28qiq7uueykidpitdl` |

`production.yml` conserva el baseline de la última ejecución completa correcta y
el checker de [migraciones seguras](safe-production-migrations.md). Comprueba que
el frontend pertenece a `Chapuzalia/POS`, rama `main`, usa Railpack, tiene
auto-deploy desactivado y no tiene otro despliegue activo. Ejecuta pruebas, lint
y build antes de enviar las migraciones por SSH.

La cola se comprueba mediante el historial paginado de la aplicación:
`GET /deployments/applications/<UUID>?skip=0&take=100`, cuya respuesta en
Coolify 4.4.6 contiene `count` y `deployments`. Se inspecciona todo el historial
hasta un máximo de 10.000 registros, sin depender del ID interno que la API
omite. Se rechazan estados desconocidos, páginas incompletas y cambios de
recuento durante la comprobación. Contrato verificado en el
[controlador de v4.4.6](https://github.com/coollabsio/coolify/blob/v4.4.6/app/Http/Controllers/Api/DeployController.php#L686).

El receptor del VPS selecciona exactamente un PostgreSQL activo por etiquetas
Compose de **ese recurso** y servicio `supabase-db`. Selecciona la IP dinámica de
la red configurada, obtiene su contraseña actual y comprueba el historial.
No depende del gateway HTTP ni de puertos PostgreSQL publicados en el host.

Antes de aplicar SQL crea un dump custom completo de la base, conservando sus
propietarios y ACL, comprueba su índice y lo recorre con `pg_restore --file=/dev/null`.
El archivo pasa de `.partial` a `.dump` únicamente cuando esas comprobaciones
terminan. No es una prueba de restauración; tampoco incluye roles globales,
objetos físicos de Storage ni configuración del stack. Mantener además un plan
de backup periódico y restauración independiente.

Mantiene `/var/lock/pos-deploy.lock` desde la recepción hasta la verificación
final. Ejecuta la CLI fijada, primero `db push --dry-run` y después `db push`,
compara todo el conjunto de versiones aplicado con el paquete y envía
`NOTIFY pgrst, 'reload schema'`. La contraseña viaja únicamente en el entorno
del proceso de CLI mediante `PGPASSWORD` y `SUPABASE_DB_PASSWORD`; la URI no
contiene contraseña. Se pasa `--skip-vault` para limitar el despliegue a las
migraciones, sin sincronizar secretos de Vault desde configuración.
Las salidas de herramientas permanecen en el log privado del VPS.

Después fija el SHA en Coolify, configura `APP_VERSION` y
`SUPPORTED_APP_VERSIONS` como variables **de build**, solicita el despliegue y
espera hasta 20 minutos. Exige estado `finished` y el mismo SHA para que el
workflow se considere correcto. La lista de versiones incluye el baseline y
la nueva versión, preservando compatibilidad N-1. El SHA configurado queda
fijado en Coolify; cada release lo actualiza explícitamente.

El build de Coolify ocurre después de las migraciones. Si falla, la base
conserva sus migraciones compatibles y no se avanza el baseline del workflow.
No se ejecuta ningún rollback automático de datos o esquema. Tampoco se
considera el encolado del frontend como un despliegue correcto.

## Activación inicial en el VPS

Completar estos pasos **antes de promover el workflow a main**. La inspección
anterior no pudo comprobar los archivos protegidos de SSH/sudo; requieren un
administrador. No instalar el receptor ejecutando un script recibido por SSH
desde Actions: debe instalarlo un administrador desde una copia revisada.

1. En Coolify, desactivar auto-deploy de `tickit-frontend` y esperar a que no
   quede ningún deployment en cola o en curso. Es obligatorio hacerlo antes
   del primer push: desactivarlo durante la action no evita un deploy que ya
   haya empezado. A partir de entonces, la publicación de main la controla Actions.
   Evitar deploys manuales y cambios de configuración mientras se ejecuta.
2. Comprobar en el VPS que están disponibles Python 3.10+, Docker y
   `/usr/bin/supabase --version`, que debe devolver `2.121.0`, la versión actual
   comunicada por el usuario tras el informe inicial. Confirmar la ruta exacta
   del binario y las ayudas antes de activar el receptor. No actualizar
   implícitamente la CLI en cada release.
3. Revisar `scripts/deploy-pos.py` y `scripts/pos-deploy.production.json`.
   La configuración fija el recurso y red de producción y exige la migración
   ya existente `20261015120000` como comprobación del historial trasladado.
   No contiene contraseñas. No reutilizar la configuración anterior basada en
   un nombre fijo de contenedor o una contraseña antigua.
4. Con ningún despliegue en curso y desde la raíz de esa copia revisada del
   repositorio, ejecutar como administrador:

   ```bash
   # Conservar copia del receptor anterior antes de sustituirlo.
   sudo install -d -m 700 -o root -g root /opt/pos-deploy/receiver-before-coolify
   sudo cp --preserve=mode,ownership,timestamps --no-clobber \
     /usr/local/bin/deploy-pos /opt/pos-deploy/receiver-before-coolify/deploy-pos
   sudo install -m 600 -o root -g root scripts/pos-deploy.production.json /etc/pos-deploy.json
   sudo install -m 755 -o root -g root scripts/deploy-pos.py /usr/local/bin/deploy-pos
   sudo install -d -m 700 -o root -g root /opt/pos-deploy/backups /var/log/pos-deploy
   ```

5. Verificar, sin publicar claves, el usuario efectivo de `PROD_SSH_USER`, su
   `authorized_keys` y `/etc/sudoers.d/github-deploy`. Si la cuenta sigue siendo
   `github-deploy`, el contrato esperado es:

   ```text
   # authorized_keys: mantener la clave pública correcta
   restrict,command="sudo -n -- /usr/local/bin/deploy-pos" ssh-ed25519 <CLAVE_PUBLICA>

   # sudoers: únicamente este ejecutable sin argumentos; validar con visudo
   github-deploy ALL=(root) NOPASSWD: /usr/local/bin/deploy-pos ""
   ```

   Mantener el receptor, configuración y sus directorios padre bajo control
   de root. La cuenta SSH no necesita acceso general a Docker, shell root,
   reenvío de puertos ni permiso sudo para instalar otros archivos.

El archivo `/etc/pos-deploy.env` deja de ser utilizado por el nuevo receptor.
No se modifica ni elimina desde el workflow. El paquete incluye un manifiesto
`deployment.json` con protocolo, recurso y SHA: el receptor anterior lo rechaza
antes de ejecutar su backup/migraciones; el nuevo rechaza paquetes sin manifiesto
o dirigidos a otro recurso. Así, una actualización incompleta falla antes de
conectarse a una base incorrecta.

## Configuración de GitHub

| Tipo | Nombre | Valor |
| --- | --- | --- |
| Variable | `COOLIFY_URL` | `https://tickit-vps.tail723c3c.ts.net`, compartido con staging; sin `/api/v1` |
| Secret | `PROD_COOLIFY_API_TOKEN` | Token del equipo de producción con permisos `read`, `write`, `deploy` |
| Secrets | `PROD_TS_CLIENT_ID`, `PROD_TS_AUDIENCE` | Client ID y Audience de una identidad OIDC de Tailscale exclusiva de main |
| Secrets existentes | `PROD_SSH_HOST`, `PROD_SSH_USER`, `PROD_SSH_PRIVATE_KEY`, `PROD_SSH_KNOWN_HOSTS` | Acceso al VPS y clave restringida del receptor |
| Variable existente | `PRODUCTION_BASE_SHA` | Solo bootstrap: SHA realmente desplegado si no hay un workflow previo correcto |

Los UUID de frontend y Supabase están fijados explícitamente en el workflow
de main. No introducir tokens de Coolify ni contraseñas en variables públicas.
Los secrets `VERCEL_*` ya no se utilizan en esta action.

Coolify es accesible mediante Tailscale Serve en la URL HTTPS privada compartida.
Antes de activar main, crear su identidad OIDC con issuer GitHub, subject exacto
`repo:Chapuzalia/POS:ref:refs/heads/main`, scope `auth_keys` con escritura y
`tag:github-actions-production`. Declarar esa etiqueta con propietario
`autogroup:admin` y permitirle únicamente TCP a `100.118.217.48:443`.
Esta preparación de producción todavía está pendiente; la etiqueta de staging
no autoriza a los runners de main. La acción oficial v4 se fija a un commit y
crea un nodo efímero mediante `id-token: write`, sin client secret.

No cambiar `PRODUCTION_BASE_SHA` ni usar `migration repair` para ocultar
inconsistencias. El historial se conservó durante el traslado y se comprueba
antes y después de aplicar SQL.

## Verificación y recuperación

Pruebas locales sin conexión a producción:

```bash
node --test tests/deploy-coolify.test.mjs
python3 -B -m unittest discover -s tests -p test_deploy_pos.py
pnpm test
```

Antes del primer despliegue, ejecutar `node scripts/deploy-coolify.mjs --check`
con las variables de Coolify, `APP_VERSION` y `PREVIOUS_APP_VERSION` configuradas;
solo realiza consultas. Comprobar asimismo SSH/forced command/sudo y permisos
del receptor con el administrador del VPS. No enviar un paquete real de
migraciones como prueba de conectividad: el receptor lo aplicaría.

En el primer release comprobar el backup validado, el historial completo y el
SHA del deployment. Verificar también en la URL pública `app-version.json`
y un acceso normal al POS. Un deployment `finished` con el SHA correcto no
sustituye esa comprobación funcional. No publicar logs SQL ni backups como
artefactos de Actions.

Si falla el backup o el dry-run, no se aplica SQL. Un fallo durante `db push`
puede dejar migraciones anteriores de ese paquete ya aplicadas: revisar el
historial antes de reintentar y conservar el dump. Si falla la conexión a la API
después de solicitar un deploy, inspeccionar la cola en Coolify: no se repite
automáticamente una petición de escritura cuyo resultado sea incierto. Un
timeout no cancela un deployment que sigue en el servidor. El preflight del
reintento rechaza otro deployment aún activo.

La action mantiene lint/tests/build y el checker del repositorio. La prueba
completa contra el VPS queda pendiente hasta instalar el receptor, configurar
los secrets y desactivar auto-deploy. Esta primera adaptación cubre `main`;
staging necesita su propio VPS, UUID, configuración, credenciales y baseline.

Referencias: [API de actualización](https://coolify.io/docs/api/endpoints/applications/update-application-by-uuid),
[API de deploy](https://coolify.io/docs/api/endpoints/deployments/deploy-by-tag-or-uuid),
[resultado del deployment](https://coolify.io/docs/api/endpoints/deployments/get-deployment-by-uuid),
[auto-deploy](https://coolify.io/docs/applications/deployments/automatic-deployments),
[Supabase CLI](https://supabase.com/docs/reference/cli/supabase-db-push).
