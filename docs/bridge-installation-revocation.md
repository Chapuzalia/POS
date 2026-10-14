# Revocar una instalación desde el bridge

La revocación afecta a la identidad SIF vinculada al bridge. Se retira la misma instalación en Supabase y el TPV exige crear una instalación nueva para continuar. El dispositivo físico sigue autorizado: puede conservar su sesión y caja, activar el sucesor y consultar el historial anterior.

## Uso

1. El administrador del bridge abre **Instalaciones → Revocar dispositivos** y confirma el motivo.
2. El bridge bloquea nuevos leases de inmediato. Si Supabase está disponible, el panel confirma la revocación también en Tickit. Si no, indica que la comunicación está pendiente y la reintenta automáticamente.
3. El TPV abierto y visible comprueba el estado cada 15 segundos, además de al recuperar conexión o foco. Al conocer la revocación, muestra el diálogo obligatorio para crear una nueva instalación. La opción de recuperación de pruebas no permite reutilizar la identidad revocada.
4. El cajero pulsa **Crear nueva instalación** con conexión. Se crea otra identidad, número y cadena, y el bridge la recibe mediante el provisioning habitual.

El historial y los registros pendientes de la instalación anterior se conservan. Los emitidos antes de la revocación pueden sincronizarse sin cambiar sus UUIDs, huellas ni datos fiscales. Los posteriores se rechazan. No borrar el almacenamiento local para sustituir una instalación.

Un TPV totalmente offline conocerá la revocación cuando recupere conexión. Una vez detectada, el marcador permanece en IndexedDB y bloquea nuevas ventas, devoluciones, anulaciones y el uso de leases en caché incluso tras recargar o perder conexión otra vez.

## Contrato técnico

- El bridge registra la revocación y su tarea de comunicación en la misma transacción local. La tarea sobrevive a errores de red y reinicios.
- `fiscal_bridge_revoke_installation(uuid,uuid,text,text,timestamptz)` es exclusivo de `service_role`. Comprueba instalación, dispositivo y origen enrolados; guarda `retired_at`, `bridge_revoked_at` y el motivo. Los reintentos conservan la primera fecha y motivo. No se expone la clave de servidor al TPV.
- `pos_fiscal_installation_revocation(uuid,uuid,uuid,uuid,uuid)` usa `SECURITY INVOKER`, RLS y permisos actuales del dispositivo para consultar únicamente la identidad exacta de la caja.
- La PWA guarda el marcador `pwa-revoked:<UUID>` en el store `bindings` existente. No cambia la versión del ledger ni su cadena. Una identidad sucesora tiene otro UUID y no hereda el bloqueo.
- La validación económica de Supabase rechaza emisiones de identidades retiradas desde la fecha límite. El bridge permite consultar y conciliar registros anteriores confirmados por Supabase, pero bloquea registros nuevos y nuevos leases. El worker conserva y procesa los registros ya almacenados.

## Despliegue y verificación

Aplicar primero `20261011202440_bridge_installation_revocation.sql` en Supabase; después `006_pos_revocations.sql` en el bridge y reiniciar su código actualizado; por último publicar o recargar el TPV actualizado. El cliente tolera que el RPC nuevo aún no exista durante un despliegue gradual, pero la coordinación completa requiere las tres partes actualizadas.

El 11/10/2026 la migración del POS quedó aplicada y registrada en el Supabase enlazado; la del bridge se aplicó en su PostgreSQL local. Se propagó la única revocación antigua pendiente del bridge. No se publicaron aplicaciones remotas ni se realizaron envíos reales a la AEAT.

Las pruebas cubren aislamiento por tenant/dispositivo/origen, permisos del RPC, idempotencia, supervivencia de la tarea tras caída de Supabase y reinicio, bloqueo de emisiones posteriores, conciliación de registros anteriores, marcador local durable y activación de un sucesor en el mismo dispositivo. La comprobación en navegador usa el componente real del diálogo e IndexedDB/Web Locks con respuestas de Supabase simuladas.
