# Integración de POS con el controller independiente

El controller se mantiene y despliega desde su propio proyecto `deploy-controller`,
en la carpeta contigua a POS. Tiene package.json, lockfile, tests, imagen y Compose
propios. POS ya no construye ni aloja su runtime.

La guía completa está en `deploy-controller/README.md` del repositorio independiente;
el traslado de la instalación existente está en `IMPORT.md`. La preparación local
no ha aplicado estos pasos a producción ni publicado el repositorio nuevo.

## Cliente de POS

`scripts/request-deployment.mjs` es el cliente autocontenido de GitHub Actions.
Los workflows verifican POS antes de enviar:

```json
{"project":"tickit-pos","environment":"production","commit":"<SHA completo>","request_id":"production-<run>-<attempt>"}
```

La configuración declarada en los workflows es:

| Campo | Producción | Staging |
| --- | --- | --- |
| Proyecto | `tickit-pos` | `tickit-pos` |
| Repositorio | `Chapuzalia/POS` | `Chapuzalia/POS` |
| Rama | `main` | `Staging` |
| Workflow | `production.yml` | `staging.yml` |
| Eventos | `push` | `push`, `workflow_dispatch` |

Se conservan el dominio del controller, los secretos Access por entorno y los
gates `PRIVATE_DEPLOY_PRODUCTION_ENABLED`, `PRIVATE_DEPLOY_STAGING_ENABLED` y
`STAGING_DEPLOY_ENABLED`. GitHub no tiene credenciales de Coolify, SQL ni SSH.
Los encabezados privados del cliente nuevo son `X-Deploy-Client-Id/Secret`;
también se envían los de Cloudflare Access y GitHub OIDC.

## Corte de la instalación actual

El cliente nuevo exige un controller que admita `project`. Antes de publicar
estos cambios de CI, planificar el corte y suspender solicitudes. No actualizar
solo uno de los dos componentes con la cola en marcha.

En el proyecto independiente, `examples/tickit-pos.json` prepara la estructura
de configuración de POS y las reglas de compatibilidad de sus dos migraciones
históricas. Completar los datos privados y comparar los hashes con el historial
existente; no copiar recursos de producción a staging ni reinicializar el ledger.

`IMPORT.md` explica cómo detener el worker anterior, copiar su estado offline,
importarlo explícitamente como `tickit-pos` y conservar operaciones fallidas,
historial SQL, versiones PWA, logs y backups. Primero verificar staging. Los
cambios de Coolify/Tunnel, reinicios y activación de producción requieren permiso
explícito del usuario.

El checker de PRs `scripts/check-migrations.mjs`, sus tests y
`docs/safe-production-migrations.md` siguen en POS porque verifican sus cambios SQL.
El controller mantiene su propia copia independiente del analizador de despliegue.
Mantener la configuración SPA ya establecida en los frontends de POS; el
controller genérico conserva el modo de routing de cada aplicación.
