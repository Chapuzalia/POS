# Tickit API — Express

Paquete `@tickit/api` del monorepo POS. Express 5 + TypeScript, Node >=22.18. API v1 de servidor a servidor para Tickit Carta. El POS conserva su aplicación Vite en la raíz; no cambia su URL ni su despliegue. La API se ejecuta como servicio separado.

## Preparar y ejecutar

1. Aplicar las migraciones `20261017234914_tickit_carta_api.sql` y `20261018001409_tickit_carta_table_links_api.sql` mediante el flujo habitual del POS. No modifican los RPC existentes ni exigen retirar clientes anteriores. Los contratos pendientes existentes no se consumen porque este cambio no retira estructura legacy.
2. `pnpm install --frozen-lockfile` desde la raíz del POS.
3. Copiar `apps/api/.env.example` a `apps/api/.env` y configurar el Supabase del mismo entorno que el POS. `SUPABASE_SERVICE_ROLE_KEY` es exclusivamente del servidor. No usar variables `VITE_*`.
4. `pnpm dev:api` para desarrollo o `pnpm start:api` para ejecución sin watcher. `pnpm build:api` verifica tipos; `pnpm build` también incluye esa verificación.

Por defecto escucha en `127.0.0.1:3100`. En producción, publicar detrás de HTTPS y ajustar `HOST` y `TRUST_PROXY_HOPS` al número real de proxies. No registrar cabeceras Authorization, cuerpos de pedidos, credenciales ni enlaces de mesa. No se habilita CORS: el consumidor es el backend de Carta, no su navegador. Los límites en memoria por IP y credencial protegen una instancia; al escalar réplicas, aplicar además límites compartidos en el proxy.

Contenedor opcional, desde la raíz POS:

```sh
docker build -f apps/api/Dockerfile -t tickit-api .
docker run --env-file apps/api/.env -e HOST=0.0.0.0 -p 127.0.0.1:3100:3100 tickit-api
```

El Dockerfile no se ha construido en esta sesión. El workflow actual sigue desplegando el frontend y las migraciones; el alta del nuevo servicio y su dominio es una operación de infraestructura independiente.

## Conectar un restaurante

1. En POS, como propietario, abrir CRM → configuración de locales → desplegar el local → Tickit Carta.
2. Crear la credencial. Copiarla en ese momento, junto al identificador del local. Renovarla invalida la anterior y las sesiones emitidas. Revocar la conexión la bloquea inmediatamente para nuevas operaciones.
3. En el servidor PocketBase central de Carta, configurar **una sola vez por entorno** `TICKIT_API_URL` con la URL HTTPS real de esta API. En desarrollo se permite `http://127.0.0.1:3100`. Aplicar la migración nueva de Carta y cargar sus hooks actualizados. La URL nunca se acepta desde formularios ni desde registros de restaurantes.
4. En Carta → Integraciones, introducir el identificador del local POS y su credencial. El servidor comprueba la versión y el local antes de cambiar el proveedor. Solo owner/admin del ámbito de Carta puede conectar o desconectar. Una misma sede POS solo puede vincularse a una sede Carta.
5. Publicar el perfil de la carta. En **Tickit Carta → Mesas y zonas**, pulsar **QR / NFC** en la fila de la mesa y crear su QR. Carta usa automáticamente la URL de su perfil publicado y permite descargar el PNG o copiar el enlace para NFC. El POS emite el secreto mediante la API; sus pantallas solo gestionan la credencial de conexión. Renovar el QR invalida el soporte anterior y las sesiones de esa mesa; volver a descargar el PNG mostrado conserva el enlace.
6. El personal abre la mesa en el POS con caja abierta. El cliente escanea, elige productos/variantes/modificadores/componentes y confirma. El pedido se añade a la comanda existente. El personal lo envía a producción con el flujo habitual del POS.

## HTTP v1

`GET /health` no requiere credenciales y devuelve salud del proceso, no una comprobación de disponibilidad de Supabase.

Los siguientes endpoints exigen `Authorization: Bearer tk_<64 caracteres hex>`. La credencial se guarda como SHA-256 en el POS y se resuelve a un único tenant/local en cada petición. No hay parámetros de tenant/local elegidos por el consumidor.

| Método | Ruta | Resultado |
| --- | --- | --- |
| GET | `/v1/capabilities` | `apiVersion: "1"`, `venueId`, capacidades |
| GET | `/v1/catalog` | Catálogo agregado POS activo, imágenes públicas, formatos y mesas privadas del conector |
| POST | `/v1/table-links` | `{tableId}` → `{tableToken, tableName}`; solo mesas activas permanentes del local de la credencial |
| POST | `/v1/sessions` | `{tableToken}` → `{token, occupationId, expiresAt}` |
| POST | `/v1/orders` | Intención de pedido → recibo persistido |

Pedido:

```json
{
  "sessionToken": "<64 caracteres hex>",
  "idempotencyKey": "<UUID nuevo para cada confirmación>",
  "lines": [{
    "productId": "<UUID POS>",
    "variantId": "<UUID POS>",
    "quantityMilli": 1000,
    "modifierOptionIds": [],
    "components": [],
    "note": "Sin hielo"
  }]
}
```

Cada componente admite `id` (opción de selección), `selectionGroupId`, `productId`, `variantId`, `quantity` entera y `modifiers: [{id}]`. Todos los identificadores son UUID POS. No se aceptan precios, nombres, snapshots ni identificadores de empresa del cliente. En Carta los IDs compuestos de opciones visuales se convierten al ID externo explícito; no se confunden con los IDs locales de PocketBase.

`quantityMilli` es entero (1000 = una unidad). Los importes se calculan en céntimos y se redondean por línea en SQL. Límite: 50 líneas por petición, cuerpo de 64 KiB y 500 líneas por comanda. Respuesta: `orderId`, `acceptedAt`, `totalCents` del pedido añadido, `lineIds` y `productionStatus: "saved"`.

Reintentar exige la **misma clave, sesión y cuerpo**. La base bloquea la clave y la comanda, añade todas las líneas en una transacción y conserva el recibo. Un fallo revierte el lote entero. Una respuesta perdida puede recuperarse incluso si luego se cerró la comanda; nunca se vuelve a insertar. Cambiar el cuerpo con la misma clave devuelve `409 IDEMPOTENCY_CONFLICT`.

Errores: 401 credencial ausente/revocada; 403 integración no disponible; 409 sesión cerrada/caducada o conflicto de idempotencia; 422 intención inválida; 429 límite de solicitudes; 503 backend no disponible. Las respuestas no revelan mensajes internos de Postgres.

## Límites operativos

- QR y NFC transportan el mismo enlace con secreto aleatorio en el fragmento, sin token en query strings. No hay verificación criptográfica NTAG 424 DNA: `nfcProof: false`.
- Las sesiones duran dos horas y quedan vinculadas a mesa, comanda y ocupación. Cerrar/mover/liberar la mesa, cerrar caja, iniciar reparto equitativo o revocar acceso bloquea nuevos pedidos. El enlace estable puede emitir una sesión nueva para una ocupación posterior; la sesión antigua no migra.
- Guardar no envía a cocina, cobra, emite factura ni imprime. Producción, pago y fiscalidad permanecen en el flujo del personal.
- En modo integrado se publican los productos con una ubicación activa en pestaña/categoría activa. El POS actual usa `is_active` como disponibilidad. No tiene alérgenos estructurados en su catálogo: Carta no los inventa y mantiene el aviso de consultar al personal.
- No hay réplica de catálogo: las lecturas consultan el POS, sin sustitución automática ante errores. Desconectar es explícito y recupera el catálogo standalone previo sin copiar ni sobrescribir productos.
- Los recibos de idempotencia se conservan; no purgarlos antes de la ventana de recuperación acordada. Las sesiones caducadas pueden limpiarse en mantenimiento. No se ha configurado un cron ni una política de retención automática.
- PocketBase conserva las claves en una colección inaccesible a usuarios y campos ocultos; proteger también disco y backups. Las claves no se incluyen en respuestas, Realtime público ni variables del frontend.

## Verificación

`node --test tests/tickit-api.test.mjs` ejecuta Express contra Postgres embebido PGlite y verifica SQL real, precios, rollback, conservación de líneas, duplicados, aislamiento y revocación. Los helpers de identidad/fiscalidad externos a esta función se sustituyen en el entorno aislado; no valida la instalación remota.

En Carta: `npm test`, `npm run build`, `npm run test:e2e` y `PB_TEST_BINARY=<ruta> npm run test:backend`. La prueba real de PocketBase comprueba sus reglas, migración y puente HTTP con un upstream de prueba separado. Ninguna de estas pruebas aplica cambios a producción.
