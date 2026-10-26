# Edge Functions desde GitHub Actions

> Referencia histórica de compatibilidad y recuperación. El pipeline automático actual usa el [controlador privado de despliegues](deployment-controller.md). Las instrucciones SSH, Tailscale, baselines, excepciones y credenciales GitHub de esta guía describen el procedimiento anterior; no se deben activar como un segundo pipeline. Consultar la guía del controlador antes de cualquier instalación o despliegue. No se ha aplicado ningún cambio en producción.

Los workflows `production.yml` (`main`) y `staging.yml` (rama exacta `Staging`)
usan `scripts/send-pos-migrations.sh` y el receptor instalado `deploy-pos.py`.
El paquete de protocolo **4** contiene migraciones, `supabase/functions/`, el
router revisado `scripts/edge-router.ts` y `supabase/config.toml`. Los receptores
anteriores rechazan este paquete antes de aplicar SQL: hay que actualizarlos
en **ambos VPS antes de publicar estos workflows**.

## Destinos inspeccionados el 2026-10-20

| Entorno | Proyecto Compose | Servicio Edge | Imagen |
| --- | --- | --- | --- |
| main | `dbdtluvsdqycxl5tecuwljie` | `supabase-edge-functions` | `supabase/edge-runtime:v1.76.2` |
| staging | `irsdd2liytrh7dttjr5rzj3j` | `supabase-edge-functions` | `supabase/edge-runtime:v1.76.2` |

Los dos montan `/data/coolify/services/<proyecto>/volumes/functions` en
`/home/deno/functions`, además de mounts individuales de `main/index.ts` y
`hello/index.ts`. El comando comprobado es `start --user-worker-request-idle-timeout
150000 --main-service /home/deno/functions/main`. Se validan recurso, servicio,
imagen, comando y mounts; cualquier discrepancia detiene el release antes del SQL.

## Orden y alcance

1. Tests, lint, build y preflight de Coolify existentes.
2. `DEPLOY_OPERATION=check`: valida el paquete, el destino Edge, configuración
   y el historial/dry-run SQL. Solo usa temporales y log privado; no cambia
   funciones, no hace backup, no aplica SQL ni reinicia contenedores. No compila
   las funciones en el runtime ni comprueba sus credenciales externas.
3. `apply`: repite las validaciones, hace el backup SQL y aplica migraciones.
4. Guarda una copia privada completa del directorio de funciones. Detiene
   **solo** el contenedor Edge, copia el código y arranca ese mismo contenedor.
   Conserva los inodos del directorio raíz y `main/index.ts` por sus bind mounts.
5. Exige que `GET /_pos_health` devuelva el SHA esperado por la red Docker
   configurada. Envía `OPTIONS` a cada función del paquete: exige una respuesta
   inferior a 500 marcada por el router con ese SHA. Esto arranca los workers
   y detecta errores de imports/compilación sin enviar POSTs ni claves.
6. Solo entonces despliega el frontend y comprueba su SHA como antes.

Hay una interrupción breve de las peticiones Edge mientras se sustituye el
código y se reinicia el proceso. Se permite hasta 75 segundos para detenerlo.
Si la copia, el arranque o el smoke check fallan, restaura el código anterior
y solicita su arranque, falla el workflow y no publica el frontend. La
recuperación del código no acredita una prueba funcional de todos los servicios.
Las migraciones ya aplicadas permanecen: no hay rollback automático SQL.
Si falla después el build del frontend, permanecen las funciones nuevas; deben
ser compatibles con el cliente anterior. El baseline solo avanza al completar
todo el workflow.

## Configuración y funciones fuera del repositorio

El router traduce únicamente `[functions.<nombre>]` de `config.toml`:
`verify_jwt` (por defecto `true`) e `import_map` (por defecto el `deno.json`
compartido). Rechaza opciones desconocidas para evitar ignorarlas silenciosamente.
Conserva HS256 con `JWT_SECRET` y ES256/RS256 con `SUPABASE_JWKS`; las funciones
con `verify_jwt=false` mantienen su validación propia de usuario, pairing,
firma de webhook o secreto. `OPTIONS` omite el chequeo del router como antes.
El resto de `config.toml` no modifica el stack self-hosted.

El router anterior tenía `VERIFY_JWT=false` global e `importMapPath=null` en
ambos VPS. Las funciones del repositorio pasan a respetar la configuración por
función, incluido el valor por defecto `true` de `manage-pos-users`, cuya
autenticación interna también se mantiene. No se cambia la variable global.

Se conservan las funciones exclusivas del VPS (`verifacti-api`,
`verifacti-webhook`, `hello`) y su configuración anterior; en el primer release
se preserva el booleano global y el import map nulo del router inspeccionado.
En releases posteriores se conserva su configuración de `pos-release.json`.
Se mezclan los helpers `_shared` con los existentes. No se borran automáticamente
funciones retiradas del repo ni helpers antiguos: su retirada requiere una
operación separada y revisada por compatibilidad fiscal y de clientes antiguos.

Los secretos y variables de proveedores permanecen en Coolify, por entorno.
La action no los copia, configura ni elimina. Los archivos `.env`, enlaces y
artefactos inesperados se rechazan al empaquetar. Los backups y logs son privados
en el VPS; no se publican como artefactos de GitHub.

## Actualizar el receptor instalado

La instalación y cualquier despliegue en producción requieren aprobación
explícita según `AGENTS.md`. La instalación del receptor en ambos VPS fue
autorizada e instalada el 2026-10-20. No se autorizaron ni ejecutaron despliegues,
migraciones o reinicios de servicios durante esta instalación.

En cada VPS, un administrador debe usar una copia revisada de este cambio,
con Actions y despliegues manuales detenidos, y comprobar Python **3.11+**
(`tomllib`), Docker y la CLI Supabase fijada existente. No hacen falta nuevas
claves SSH ni nuevos permisos sudo para `github-deploy`.

1. Conservar una copia privada del receptor `/usr/local/bin/deploy-pos` y de
   `/etc/pos-deploy.json` antes de reemplazarlos.
2. Añadir a la configuración root-owned existente, manteniendo sus otros
   valores: `"edge_image": "supabase/edge-runtime:v1.76.2"`.
   Los ejemplos del repositorio ya contienen ese campo; comprobar el proyecto
   antes de utilizar uno completo para no alterar rutas/configuración local.
3. Instalar **el mismo** `scripts/deploy-pos.py` como `/usr/local/bin/deploy-pos`,
   propietario root, modo 755. Configuración root, modo 600. Mantener los
   directorios padre bajo control de root y los de backup/log en modo 700.
   No sustituir el receptor mientras otro proceso mantiene
   `/var/lock/pos-deploy.lock`; mantener el forced command y sudo sin argumentos.
4. Publicar primero a `Staging` y ejecutar `mode=check`. Con
   `STAGING_DEPLOY_ENABLED=false` también un push verifica sin desplegar.
5. Tras una comprobación correcta, autorizar/habilitar un release de staging
   y comprobar login, pairing/impresión, OCR, webhooks y fiscal con datos de
   prueba. Las peticiones OPTIONS no sustituyen estas pruebas funcionales.
6. Después promover el cambio a `main` con su autorización de producción.

El receptor mantiene compatibilidad con paquetes antiguos de migraciones de
protocolo 2/3. Los paquetes nuevos exigen protocolo 4 completo y fallan si no
está configurado `edge_image`, antes de tocar la base.

### Instalación comprobada el 2026-10-20

Se instaló el mismo receptor en ambos VPS, SHA-256
`6c6758e849ef3eb37f98b45317a490c088fd4e9fac88dc6455f5d5639ffd5896`,
propietario root y modo 755; configuración root y modo 600. Se utilizó el lock
del receptor durante la sustitución y se comprobó que los contenedores y el
router no cambiaron ni se reiniciaron.

- Staging: Python 3.14.4. Se añadió `edge_image` a la configuración existente,
  conservando sus otros valores. Copia anterior en
  `/opt/pos-deploy/receiver-upgrades/20261020T190217_041583Z`.
- Producción: Python 3.13.3. Se sustituyó el receptor de shell antiguo y se
  creó `/etc/pos-deploy.json` con el destino revisado; el archivo
  `/etc/pos-deploy.env` antiguo permanece intacto. Copia anterior en
  `/opt/pos-deploy/receiver-upgrades/20261020T190219_084252Z`, con una marca
  que registra que la configuración JSON no existía.

Se enviaron paquetes de protocolo 4 con `operation=check` al ejecutable
instalado mediante SSH administrativo. Ambos terminaron correctamente: una
migración pendiente en staging y seis en producción para esa copia local de
trabajo, que incluía cambios aún sin commit. El receptor confirmó el historial
sin cambios; no aplicó SQL, creó backups de base ni cambió funciones. Esta
comprobación no ejecutó GitHub Actions ni probó sus credenciales/OIDC.

## Verificación local

```bash
python3 -B -m unittest discover -s tests -p test_deploy_pos.py
node --test tests/edge-deployment.test.mjs tests/deploy-coolify.test.mjs tests/staging-baseline.test.mjs
pnpm lint
pnpm test
bash -n scripts/send-pos-migrations.sh
```

Las pruebas locales simulan Docker para verificar aislamiento de recursos,
montajes, configuración, preservación fiscal y recuperación. El preflight del
receptor instalado ya pasó en ambos VPS. El despliegue y comprobación real de
arranque de las funciones quedan pendientes de autorización para staging.

Referencia: [funciones self-hosted de Supabase](https://supabase.com/docs/guides/self-hosting/self-hosted-functions).
