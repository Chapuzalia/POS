# Impresion del cierre de caja

## Fuentes de datos

El informe se guarda como JSON estructurado en `cash_sessions.print_snapshot` dentro de la misma transaccion que cambia el turno a `closed`. Una reimpresion nunca consulta ventas actuales.

| Linea del informe | Fuente real |
| --- | --- |
| Informe / turno | ID corto estable de `cash_sessions.id`; no existe correlativo en el modelo actual |
| Empresa | `venues.name` |
| Caja | `cash_registers.name` mediante `cash_sessions.cash_register_id` |
| Fecha | `cash_sessions.closed_at`, convertida con `venues.timezone` |
| Total | Suma de `sales.total_cents` cuyos tickets siguen en estado `paid` y pertenecen al cierre |
| Ventas | Numero de esas filas de `sales`; movimientos manuales y tickets anulados no cuentan |
| Media | Total / ventas, redondeado a centimos enteros; cero si no hay ventas |
| Pagos | `sale_payments.amount_cents`, agrupado dinamicamente por `method` y limitado a tickets `paid` |
| Entradas / salidas | `cash_movements.amount_cents`, agrupado por `direction` durante el turno |
| Fondo inicial | `cash_sessions.opening_float_cents` |
| Fondo final | `cash_sessions.final_cash_fund_cents`, introducido expresamente en el arqueo |
| Diferencia efectivo | `counted_cash_cents - expected_cash_cents`, persistida en el snapshot |
| Diferencia tarjeta | `counted_card_cents - expected_card_cents`, persistida en el snapshot |
| Usuarios | `profiles.full_name` para `opened_by` y `closed_by` |

El total sigue el criterio vigente del TPV: `sales.total_cents` es el total neto cobrado despues de descuentos, con impuestos incluidos. Los pagos mixtos se agregan desde sus filas reales en `sale_payments`, no desde el total de la venta.

## Archivos

- `supabase/0.Complete_Database_24-07-26.sql`: snapshot, movimientos, fondo final, estado, reclamacion idempotente y auditoria.
- `src/features/cash-registers/service.ts`: lectura del cierre/historico y registro protegido del resultado.
- `src/features/cash-registers/hooks/useCashSession.ts`: guarda primero, imprime despues y mantiene el cierre ante cualquier fallo del agente.
- `src/features/local-printing/services/cashClosingPrintMapper.ts`: adapta el snapshot al mismo contrato `ticket` que usa una venta; no envia objetos de Supabase ni del store.
- `src/features/local-printing/schemas/printSchemas.ts`: valida el cierre con el mismo `printRequestSchema` de las ventas.
- `src/features/local-printing/services/cashClosingReceiptRenderer.ts`: convierte el detalle del cierre en lineas de texto para 58/80 mm. Esas lineas viajan como `additions` de un item normal del ticket; la web no envia ESC/POS.
- `src/components/modals/CashClosingResultModal.tsx` y `CashClosingsHistoryModal.tsx`: impresion original, reintento e historial.

## Contrato del agente

Se reutiliza `POST /api/v1/print` sin requerir ningun tipo de documento ni endpoint especifico en el agente. El cierre envia exactamente el mismo contrato que una venta:

```json
{
  "requestId": "cash-closing:{closingId}:original",
  "printerId": "...",
  "ticket": {
    "establishmentName": "...",
    "ticketNumber": "Informe ...",
    "date": "...",
    "items": [{
      "name": "Cierre · Caja principal",
      "quantity": 1,
      "unitPriceCents": 100000,
      "totalCents": 100000,
      "additions": ["CAJA ...", "RESUMEN", "Total ..."]
    }],
    "subtotalCents": 100000,
    "totalCents": 100000,
    "deferredLabel": "CIERRE DE CAJA",
    "footer": "CIERRE COMPLETADO"
  },
  "options": { "cut": true, "openCashDrawer": false, "copies": 1 }
}
```

El agente procesa el cierre como cualquier ticket de venta. El item principal representa el total vendido y sus `additions` contienen las filas ya formateadas del resumen, pagos, movimientos, fondos, diferencias y campos opcionales. `openCashDrawer` siempre es `false`; el corte y el numero de copias usan las preferencias locales.

Los intentos originales usan siempre `cash-closing:{id}:original`; los reintentos de un fallo confirmado conservan el ID. Las copias usan `cash-closing:{id}:copy:{n}`. El RPC rechaza una segunda reclamacion original pendiente, impresa o desconocida. Un estado desconocido se bloquea en la interfaz y requiere comprobar fisicamente la impresora.

## Despliegue

1. Aplicar la migracion 27 antes de publicar el frontend.
2. Comprobar que el agente instalado imprime correctamente el contrato de tickets de venta.
3. Configurar impresora y preferencias por local/terminal en Ajustes > Hardware > Impresion.
4. Probar un cierre sin ventas y otro con efectivo/tarjeta antes de activar la impresion automatica en produccion.
