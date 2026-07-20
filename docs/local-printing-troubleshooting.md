# Solucion de problemas de impresion local

## No se puede conectar

`TypeError: Failed to fetch` no identifica una causa unica. Revisa, en este orden:

1. El iPad esta en la Wi-Fi del local correcta.
2. El agente esta encendido y escucha en 8443.
3. La URL no contiene rutas y usa el hostname correcto.
4. Safari puede abrir directamente `{url}/health` sin advertencias.
5. La raiz esta instalada y tiene confianza completa en iPadOS.
6. El firewall permite 8443.
7. El punto de acceso no aisla clientes.
8. mDNS resuelve `.local`; si no, configura otro hostname valido.
9. El certificado no esta caducado y cubre el hostname o IP.
10. CORS permite el origen exacto de Vercel, `Authorization`, `Content-Type` y los metodos usados.

La aplicacion muestra diagnostico guiado; no afirma que sea un certificado cuando Safari solo devuelve un error opaco.

## Token no valido

Un 401 se muestra como `UNAUTHORIZED`. Vuelve a introducir el token en el asistente. El token no aparece en el informe tecnico y no debe copiarse a variables Vite, Supabase, analytics o capturas de errores.

## CORS

Un 403 con codigo `ORIGIN_NOT_ALLOWED` se identifica como origen no permitido. Otros errores de preflight pueden aparecer como un fallo de red generico. Comprueba que el agente responde a `OPTIONS` y permite:

```text
Origin: https://<deployment>.vercel.app
Headers: Authorization, Content-Type
Methods: GET, POST, PATCH, OPTIONS
```

No uses `*` con credenciales ni desactives CORS globalmente.

## No aparecen impresoras

- Confirma que el agente, no el iPad, tiene acceso a la VLAN de impresoras.
- Verifica IP, puerto 9100 y que no haya cambiado la reserva DHCP.
- Ejecuta Descubrir impresoras y despues Actualizar.
- Si aparecen varias, selecciona una manualmente.
- Revisa MAC, fabricante, modelo, confianza y ultima deteccion.

## Estado de impresion desconocido

`PRINT_STATUS_UNKNOWN` significa que la peticion pudo llegar al agente pero el frontend perdio la respuesta. No pulses imprimir repetidamente:

1. Comprueba si salio papel.
2. Abre Trabajos recientes.
3. Consulta el trabajo asociado al `requestId`.
4. Solo si decides crear otra copia, usa Reimprimir; se generara un ID de copia nuevo y el cajon permanecera cerrado.

## Venta completada sin ticket

La venta permanece valida. Abre el historial, revisa `printStatus` y usa Reimprimir cuando el agente vuelva a estar disponible. Una venta offline no se imprime automaticamente al recuperar red.

## Informe tecnico

En Ajustes > Hardware > Impresion pulsa Copiar diagnostico. Incluye estado, URL, tiempos, agente, impresora, ultimo error, trabajo y origen frontend. El sanitizador elimina token, Authorization, datos de cliente y contenido de tickets.

## Estados comunes

- `PRINTER_NOT_FOUND`: la impresora configurada ya no se encuentra.
- `PRINTER_CONNECTION_TIMEOUT`: la impresora no responde a tiempo.
- `ORIGIN_NOT_ALLOWED`: el agente rechaza el origen web.
- `CERTIFICATE_EXPIRED`: el agente ha podido indicar que el certificado caduco.
- `PRINT_FAILED`: el agente confirmo el fallo.
- `PRINT_STATUS_UNKNOWN`: no se puede confirmar el resultado; no se reintenta automaticamente.

