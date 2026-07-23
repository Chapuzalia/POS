# Integracion de impresion local

## Arquitectura

El navegador nunca abre sockets con la impresora. La PWA publica llama por HTTPS al agente de la LAN y el agente envia ESC/POS por TCP 9100:

```text
PWA Vercel (Safari/iPad) -> HTTPS + Bearer -> agente local -> TCP RAW -> impresora
```

El codigo vive en `src/features/local-printing/`. `api/` contiene el cliente HTTP, `store/` el estado Zustand, `services/` el mapper y las reglas de negocio, `schemas/` la validacion Zod y `components/` la interfaz. El resto del TPV solo usa el hook o los servicios publicos de `index.ts`.

## Configuracion

Valores publicos opcionales:

```env
VITE_PRINT_AGENT_DEFAULT_URL=https://tpv-printer.local:8443
VITE_PRINT_AGENT_DEFAULT_TIMEOUT_MS=5000
VITE_PRINT_AGENT_HEALTH_TIMEOUT_MS=2500
VITE_PRINT_AGENT_ENABLED=true
```

El token no debe estar en ninguna variable `VITE_*`: Vite lo incluiria en el bundle. Se introduce desde Ajustes > Hardware > Impresion y se guarda localmente bajo:

```text
clubpos:v1:print-agent-config:{tenantId}:{venueId}:{deviceId}
```

MESS, LOFT y terminales distintas conservan configuraciones independientes. Para el MVP el token esta en `localStorage`; no se sincroniza con Supabase. `printAgentStorage.ts` encapsula el acceso para migrarlo a almacenamiento nativo seguro.

## Flujo de impresion

1. El TPV valida el cobro y guarda el evento local.
2. En venta rapida envia inmediatamente la impresion y sincroniza con Supabase en segundo plano, sin usar la conectividad a Internet como condicion de impresion local.
3. En mesas espera el resultado exitoso de la RPC porque esta genera los IDs definitivos, construye el ticket con el estado local de la comanda y lo imprime antes de refrescar caja y estadisticas.
4. El mapper crea un contrato minimo, con importes enteros en centimos y sin objetos internos completos.
5. Zod valida el payload.
6. Se envia `POST /api/v1/print` con un `requestId` estable.
7. Si el agente devuelve un trabajo pendiente, el frontend consulta `/api/v1/jobs/:id` hasta un estado final o hasta agotar el tiempo de interfaz.

El fallo de impresion nunca revierte, repite ni elimina la venta. Un timeout despues de enviar se trata como `PRINT_STATUS_UNKNOWN`; primero se consulta el trabajo por `requestId` y no se reenvia automaticamente.

IDs usados:

```text
print:{saleId}:original
print:{saleId}:copy:{copyNumber}
drawer:{terminalId}:{timestamp}
```

Las reimpresiones muestran `COPIA`, no abren el cajon y requieren una decision explicita si el intento anterior tiene estado desconocido.

## Cajon

`shouldOpenCashDrawer` abre automaticamente solo con preferencia activa y algun pago efectivo positivo. No abre con tarjeta, en copias ni reimpresiones. La apertura manual requiere la capacidad existente de gestion de caja, confirmacion y bloqueo mientras la peticion esta activa.

La preferencia `alwaysPrintTicket` esta activa por defecto para conservar el comportamiento anterior. Al desactivarla, una venta con pago en efectivo solo envia la apertura del cajon si la apertura automatica tambien esta habilitada; una venta sin efectivo no envia ninguna orden al agente. Las reimpresiones manuales siguen imprimiendo siempre.

## Red, CORS y TLS

El agente debe servir un certificado valido para el hostname o IP usados y permitir el origen exacto del despliegue Vercel. Debe aceptar `Authorization` y `Content-Type` en el preflight CORS. Nunca se desactiva TLS, se pone el token en la URL ni se envian HTML o comandos ESC/POS.

Las lecturas (`health`, impresoras, configuracion y trabajos) admiten reintento acotado. Imprimir, abrir cajon e imprimir una prueba no se reintentan automaticamente.

## Offline

La cola offline existente sigue siendo la autoridad de ventas. Una venta rapida nueva intenta imprimir y abrir el cajon en el momento del cobro aunque Supabase no sea accesible, siempre que el agente siga disponible en la red local. Al recuperar conectividad se sincroniza la venta, pero no se vuelven a imprimir tickets antiguos automaticamente ni se abre otra vez el cajon. Si el agente local tampoco estaba disponible, la reimpresion se decide manualmente desde el historial.

## Permisos y auditoria

El proyecto actual expone roles y capacidades de dispositivo, no permisos granulares de hardware. La adaptacion usa `canManageCash` (o roles manager/admin/owner) para configurar hardware, reimprimir y abrir cajon. Cuando el backend incorpore permisos granulares, deben mapearse a `hardware.configure`, `hardware.open_cash_drawer`, `hardware.discover_printers` y `sales.reprint_ticket`.

No existe aun un servicio generico de auditoria en el TPV. Las acciones estan encapsuladas y listas para conectar dicho servicio sin incluir el token. No debe registrarse `Authorization`, el token, datos de cliente ni el contenido completo de tickets.

## Contrato esperado del agente

El cliente implementa `/health`, servidor, descubrimiento normal y streaming, impresoras, seleccion, prueba, impresion, cajon, trabajos y configuracion. El streaming usa `fetch` para poder enviar Bearer; no usa `EventSource` ni query params con token. Si no esta disponible, usa el endpoint normal.

La impresion del cierre de caja reutiliza este mismo endpoint y el mismo contrato `ticket` de una venta. Los datos del cierre se adaptan a lineas del ticket sin exigir soporte adicional al agente. Su snapshot, idempotencia y tabla de fuentes reales se documentan en [cash-closing-printing.md](./cash-closing-printing.md).
