# Configuracion de impresion en iPad

## Requisitos previos

- iPad y agente en la misma red Wi-Fi, sin aislamiento entre clientes.
- Agente iniciado en Windows, Linux o Raspberry Pi y puerto 8443 permitido por el firewall.
- Hostname `.local` resoluble por mDNS, por ejemplo `tpv-printer.local`.
- Certificado valido para ese hostname. Si se usa una IP, el SAN del certificado debe incluir exactamente esa IP.
- Agente configurado para permitir el origen HTTPS de la PWA en Vercel.

## Instalar y confiar en el certificado

1. Recibe el certificado raiz del responsable del agente mediante un canal de confianza.
2. Instala el perfil en el iPad.
3. Abre Ajustes > General > Informacion > Ajustes de confianza de certificados.
4. Activa la confianza completa para la raiz instalada.
5. En Safari abre `https://tpv-printer.local:8443/health`.
6. Comprueba que no aparece ninguna advertencia y que la respuesta indica `ok: true`.

JavaScript no puede ignorar ni corregir un certificado no confiable. Visitar el endpoint ayuda a Safari a mostrar el problema real que `fetch` suele ocultar.

## Configurar la terminal

1. Abre la PWA y entra en Ajustes > Hardware > Impresion.
2. Pulsa Configurar.
3. Introduce el hostname del agente y prueba la conexion.
4. Introduce el token local.
5. Comprueba autenticacion.
6. Descubre las impresoras.
7. Selecciona explicitamente la impresora de esa terminal.
8. Imprime una prueba.
9. Si tienes permiso, confirma una prueba de cajon.
10. Finaliza el asistente.

No compartas el token entre establecimientos salvo que el agente se haya diseñado expresamente para ello. Cada combinacion local/terminal conserva su propia credencial.

## PWA instalada

La configuracion local pertenece al almacenamiento de la PWA instalada. Borrar datos de Safari, eliminar la PWA o usar otra combinacion de navegador/origen puede eliminarla. Conserva el hostname y el procedimiento de provisionamiento para repetir la configuracion.

iPadOS puede suspender la PWA al cambiar de aplicacion o bloquear la pantalla. Si ocurre durante una impresion, el resultado puede quedar desconocido. Comprueba fisicamente la impresora y revisa el trabajo antes de ordenar otra copia.

No se depende de Bonjour desde JavaScript, ICMP, WebSockets, sockets TCP ni APIs nativas no disponibles en Safari.

