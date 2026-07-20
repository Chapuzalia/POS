# Plan de integracion de impresion local

## Arquitectura actual

- `src/App.tsx` concentra el estado de sesion del TPV, la venta rapida, el cobro de mesas y la apertura de modales. La integracion se limitara a invocar un servicio de impresion despues de que la venta exista, sin introducir llamadas HTTP del agente en este componente.
- `src/services/posService.ts` construye y sincroniza las ventas rapidas con Supabase. `src/features/tables/service.ts` confirma los cobros de restaurante mediante RPC y devuelve los identificadores definitivos.
- `src/types/domain.ts` contiene `SaleCreatedPayload`, `SessionTicketRecord`, lineas, modificadores, pagos y el contexto de tenant/local/dispositivo. El mapper de impresion consumira estos contratos y generara un payload minimo en centimos.
- `src/lib/offlineStore.ts` encapsula `localStorage` y ya separa la informacion por tenant y dispositivo. Las credenciales del agente se encapsularan dentro de la feature con una clave equivalente por tenant, local y terminal; nunca se enviaran a Supabase.
- `src/components/modals/ConfigModal.tsx` es la pantalla actual de ajustes. Incluira una entrada `Hardware > Impresion` que abre una vista tactil independiente, manteniendo el aspecto de los modales existentes.
- `src/components/layout/AppHeader.tsx` aloja los indicadores globales. Recibira un badge discreto del agente/impresora sin bloquear el TPV.
- `src/components/modals/SessionTicketsModal.tsx` es el historial de la sesion. Incorporara la reimpresion con permiso, etiqueta `COPIA` y cajon desactivado.
- Los permisos actuales son capacidades de dispositivo y roles (`cashier`, `manager`, `admin`, `owner`). Se adaptaran asi: cualquier dispositivo que cobra puede imprimir; `manager`, `admin` y `owner` pueden reimprimir y abrir cajon; `admin` y `owner` pueden configurar hardware. No se inventara una autorizacion remota que el backend actual no expone.
- El feedback global actual combina alertas en `App.tsx` y el `Toaster` de Sileo. La feature devolvera errores de dominio legibles; los flujos de venta usaran Sileo para confirmar impresion o advertir de fallos sin revertir la venta.
- El modo offline conserva ventas en la cola existente. La impresion solo se intentara cuando la venta ya se haya registrado localmente/remotamente; no se creara una cola automatica de impresion diferida.

## Puntos de integracion

1. Crear `src/features/local-printing/` con cliente HTTPS, errores, validacion Zod, normalizacion de URL, persistencia, store Zustand, hooks, mapper, reglas del cajon, polling e interfaz publica.
2. Inicializar el store con `tenantId`, `venueId` y `deviceId` al restaurar el contexto. Cada terminal cargara exclusivamente su configuracion.
3. Integrar el panel de hardware desde `ConfigModal` y el estado resumido desde `AppHeader`.
4. Tras crear una venta rapida, llamar al servicio con el `SaleCreatedPayload` definitivo. El fallo solo actualizara el estado visual local y nunca eliminara la venta.
5. Para cobros de restaurante, imprimir solo cuando el resultado confirmado pueda reconstruirse de forma segura; si el contrato RPC no devuelve las lineas fiscales completas, se mapeara desde la comanda guardada y los identificadores devueltos.
6. Reimprimir desde `SessionTicketsModal` con `print:{saleId}:copy:{n}`, etiqueta `COPIA` y sin abrir cajon.
7. Mantener IDs estables en reintentos. Las mutaciones (imprimir, prueba y cajon) nunca se reintentaran automaticamente; las lecturas si admitiran reintento acotado.

## Compatibilidad y limites

- La aplicacion ya usa TypeScript, por lo que la feature se implementara en `.ts`/`.tsx`.
- Safari/iPadOS no permite ignorar TLS ni distinguir de forma fiable certificado, CORS, DNS o firewall cuando `fetch` devuelve un error opaco. La UI mostrara diagnostico guiado sin afirmar una causa no verificable.
- El descubrimiento usara `fetch` con streaming SSE autenticado cuando el agente lo soporte y caera al endpoint normal. El token permanente nunca ira en query params.
- No se intentara descubrir mDNS ni escanear la LAN desde el navegador.
- El token queda en `localStorage` para este MVP, aislado por terminal y documentado como riesgo; la capa de persistencia permite sustituirlo por almacenamiento nativo seguro mas adelante.
