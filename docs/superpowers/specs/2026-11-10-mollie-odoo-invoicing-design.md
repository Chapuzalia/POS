# Facturación Mollie → Odoo

Fecha: 2026-11-10 · Estado: diseño aprobado en conversación, pendiente de revisión escrita.

## Objetivo

Cada cobro de la suscripción de Tickit en Mollie (perfil de Alteil Solutions SL) produce sus documentos en el Odoo de Alteil (`invoicing.int.alteilsolutions.com`, base `Alteil`, Odoo 19.0 Community):

- **Proforma pendiente de pago** (pedido de venta) cuando el cobro se inicia.
- **Factura** cuando el cobro se liquida. Odoo es el emisor fiscal: numera la factura y la registra en Veri\*Factu cuando esté activo. Tickit no numera nada.
- El cliente consulta y descarga los dos documentos **solo desde Mi Plan**. Odoo no envía correos.

Se cumple cuando:

- ningún pago se factura dos veces;
- ningún pago liquidado se queda sin factura de forma permanente sin que el error se vea;
- el total de la factura coincide al céntimo con lo cobrado por Mollie;
- un fallo de Odoo nunca altera el acceso, el contrato ni la deuda de un negocio.

## Fuera de alcance

- Que Odoo envíe correos.
- IVA inverso intracomunitario: se mantiene el 21 % para todos los clientes, como hoy.
- Importar pagos anteriores a la integración: en live no hay ninguno.
- El módulo `payment_mollie` de Odoo: es un proveedor de pago para cobrar documentos que ya están en Odoo, no importa pagos de Tickit ni suscripciones. Se queda desactivado.

## Contexto actual

- `BillingService.reconcile()` (`supabase/functions/_shared/billing/service.ts`) relee de Mollie los pagos de cada cliente y hace upsert en `billing_invoices`. Cada fila es un pago (`stripe_invoice_id = tr_…`) con `status`, bruto, base sin IVA, `customer_snapshot` y `fiscal_export_status='pending_review'`. La llaman `billing-webhook`, la acción `reconcile` de `billing` y el cron `billing-reconcile`.
- Mi Plan (`src/features/billing/TenantBillingPanel.tsx`) ya muestra la tabla «Facturas de suscripción» a partir de `billing_invoices`.
- Mollie cobra `recurringCents + round(recurringCents × 21 %)` (`grossCents` en `mollie.ts`).
- En Odoo ya existen el diario de ventas `INV`, el impuesto «21% S» (id 2, sin IVA incluido en el precio) y el módulo `l10n_es_edi_verifactu`, aunque este último está **sin activar**: no es obligatorio, está en entorno de pruebas y no tiene certificado. No hay producto de Tickit, solo existe el diario bancario `BNK1` y no hay ninguna factura emitida.

## Decisiones

| Tema | Decisión |
|---|---|
| Momento de la factura | Al liquidarse el cobro. Antes, una proforma pendiente de pago. |
| Proforma | Pedido de venta de Odoo (`sale.order`) con el PDF «Factura proforma» de Ventas. |
| Entrega al cliente | Solo desde Mi Plan; Odoo no envía nada. |
| Staging | Envía al mismo Odoo mientras esté en pruebas (ver «Paso a actividad real»). |
| Arquitectura | Un paso de sincronización al final de `reconcile()` (enfoque A). Sin función ni cron nuevos. |
| API | JSON-2 de Odoo 19 con `fetch` y clave API, sin SDK. |

## Flujo y estados

Por cada fila de `billing_invoices`:

| Estado del pago en Tickit | Acción en Odoo | Estado Odoo |
|---|---|---|
| `open` / `processing` (Checkout abierto o SEPA en trámite) | Crear el `sale.order` (proforma) | `proforma` |
| `paid` | Confirmar el pedido → generar la factura → comprobar el total → validarla → registrar el cobro en el diario «Mollie» | `invoiced` |
| `void` / `failed` / `expired` sin haberse liquidado | Cancelar el pedido | `canceled` |
| `uncollectible` (devuelto) con la factura ya validada | Emitir la rectificativa (`account.move.reversal`) desde esa factura | `refunded` |
| Error de Odoo en cualquier paso | Ninguna; se reintenta en la siguiente conciliación | `failed` |

Reglas:

1. **Solo se avanza.** `invoiced` nunca vuelve a `proforma`. Una factura validada solo se anula con una rectificativa. Un pago que llega a `paid` sin proforma (por ejemplo, porque Odoo estaba caído) crea el pedido y la factura en el mismo paso.
2. **Comprobación del total.** Antes de validar, `amount_total` de la factura en borrador tiene que ser igual al bruto de Mollie (`amount_due_cents`). Si no coincide, la factura no se valida, el estado pasa a `failed`/`ODOO_TOTAL_MISMATCH` y se registra una alerta.
3. **Idempotencia.** Antes de crear, siempre se busca lo que ya existe: el pedido por `client_order_ref = <tr_…>`, la factura por las facturas del pedido (`invoice_ids`) y la rectificativa por `reversed_entry_id`. Además se guardan los IDs en `billing_odoo_documents`. Repetir el webhook o el cron no cambia el resultado.
4. **Aislamiento del fallo.** `syncOdoo` se ejecuta después de la conciliación de Mollie, dentro de su propio `try`, y no relanza errores. Cada pago se procesa por separado. Sin secretos de Odoo configurados, el paso no hace nada e informa `odoo: disabled` en el diagnóstico.
5. **Modo.** La referencia interna del pedido incluye el modo de Mollie (`test`/`live`) para poder distinguir los documentos de staging.

## Documentos en Odoo

- **Cliente (`res.partner`, empresa):** se busca por `vat` (NIF normalizado) y, si no existe, se crea con `name = legal_name`, `vat`, `country_id` y la dirección fiscal disponible. Su ID se guarda en `billing_accounts.odoo_partner_id`. Sin NIF o sin razón social, el resultado es `failed`/`ODOO_PARTNER_INVALID` y no se crea nada.
- **Pedido:** cliente, `client_order_ref = tr_…`, una línea del producto «Suscripción Tickit POS» (servicio, impuesto «21% S»), `price_unit` igual a la base sin IVA (`paid_excluding_tax_cents`, o `netFromGross(amount_due_cents)` mientras está pendiente), y como descripción la del pago en Mollie (plan y periodo).
- **Factura:** se genera desde el pedido y usa el diario `INV`.
- **Cobro:** `account.payment.register` en el diario bancario «Mollie», con fecha `paid_at` y referencia `tr_…`.

## Datos (migración expand nueva)

El checker de migraciones no permite ampliar el CHECK de `billing_invoices.fiscal_export_status`. El estado detallado va en una tabla nueva; las columnas existentes se rellenan sin cambiar su contrato. `supabase/contracts-pending.yml` no contiene contratos de facturación que haya que aplicar.

`supabase/migrations/20261110xxxxxx_billing_odoo_documents.sql`, con la cabecera `-- migration-safety: expand` y los timeouts del manual:

- `alter table public.billing_accounts add column odoo_partner_id bigint;`
- `create table public.billing_odoo_documents`:
  - `payment_id text primary key references public.billing_invoices(stripe_invoice_id)`;
  - `tenant_id uuid not null references public.billing_accounts(tenant_id)`, con índice;
  - `state text not null check (state in ('proforma','invoiced','canceled','refunded','failed'))`;
  - `sale_order_id bigint`, `invoice_id bigint`, `refund_id bigint`, `invoice_number text`;
  - `last_error text` (solo un código, sin datos personales), `attempts int not null default 0`, `updated_at timestamptz not null default now()`.
- RLS activada **sin políticas** y sin grants para `authenticated`/`anon`: solo accede la service role, desde las Edge Functions.
- La purga de negocios (`platform-tenant-deletion.ts` y el trigger de limpieza de facturación) tiene en cuenta la tabla nueva. Los documentos de Odoo se conservan: son fiscales.

Correspondencia con las columnas existentes de `billing_invoices` (compatibilidad N-1):

| Estado Odoo | `fiscal_export_status` | `number` | `fiscal_external_reference` |
|---|---|---|---|
| proforma / canceled | `pending_review` | nulo | `sale.order:<id>` |
| invoiced | `exported` | número de la factura | `account.move:<id>` |
| refunded | `exported` | número de la factura original | `account.move:<id>` |
| failed | `failed` | se mantiene | se mantiene |

`reconcile()` no debe sobrescribir `fiscal_export_status`, `number` ni `fiscal_external_reference` cuando hace el upsert de pagos: hoy no los envía, y debe seguir así.

## Componentes

- `supabase/functions/_shared/billing/odoo.ts`: cliente JSON-2 (`POST /json/2/<modelo>/<método>`, `Authorization: bearer`, `X-Odoo-Database`), con tiempo máximo y errores reducidos a códigos (`ODOO_UNAVAILABLE`, `ODOO_AUTH`, `ODOO_TOTAL_MISMATCH`, `ODOO_PARTNER_INVALID`, `ODOO_REJECTED`). No registra la clave, los cuerpos de las peticiones ni las respuestas.
- `_shared/billing/env.ts`: lee `ODOO_URL`, `ODOO_DB` y `ODOO_API_KEY`, que son opcionales.
- `service.ts`:
  - `syncOdoo(tenantId)`, llamado al final de `reconcile()`, avanza cada pago con la tabla de estados;
  - acción `invoice-document`.
- `billing/index.ts`: enruta `invoice-document`, solo para el propietario del negocio o el superadmin, con la misma comprobación de pertenencia que el resto de acciones.
- `diagnostics.ts`: muestra el estado de Odoo (activo o desactivado) y los pagos en `failed`, con su código y número de intentos.
- Mi Plan (`TenantBillingPanel.tsx`, `service.ts` y `types.ts` de `src/features/billing`):
  - columna «Factura» con el número de Odoo, o «Proforma» mientras no está validada;
  - estado fiscal;
  - botón táctil «Descargar PDF», que llama a `invoice-document`.

## PDF

`invoice-document({ tenantId, paymentId })`:

1. comprueba que `billing_invoices.tenant_id = tenantId` y el rol del usuario;
2. elige el documento: la factura si existe; si no, el pedido proforma;
3. obtiene la URL de portal con su `access_token` (módulo `portal`, ya instalado) y descarga el PDF desde el servidor (`report_type=pdf&download=true`);
4. devuelve el PDF. El token del portal no llega al navegador.

Una rectificativa se ofrece como un segundo documento de la misma fila.

## Seguridad y privacidad

- La clave de Odoo solo existe como secreto de las Edge Functions, de un usuario técnico con permisos de Facturación y Ventas. Nunca llega al cliente.
- No se envían a Sentry NIF, razón social, PDF, tokens ni URLs de portal.
- Aislamiento por negocio: todo pasa por `tenant_id`, y `invoice-document` rechaza un pago que no pertenece al negocio.

## Configuración de Odoo (producción; requiere permiso explícito)

Lo preparo yo, pero no lo ejecuto sin tu aprobación:

1. Producto de servicio «Suscripción Tickit POS» con el impuesto «21% S» y facturación según cantidad pedida.
2. Activar la opción «Factura proforma» en Ventas → Ajustes.
3. Diario bancario «Mollie».
4. Usuario técnico con su clave API, y los secretos `ODOO_*` en las Edge Functions de staging y producción.

## Paso a actividad real

- Reiniciar Odoo: numeración, clientes y documentos de prueba.
- Configurar Veri\*Factu en real (certificado, obligatorio y fuera del entorno de pruebas).
- Desde ese momento, staging no debe apuntar al Odoo real: los `ODOO_*` de staging se retiran o apuntan a una copia.

## Pruebas

Vitest en `tests/functional/`, con un Odoo falso en el límite de `fetch`, igual que el Mollie falso de `tests/helpers/billing-service.mjs`:

- pendiente → proforma; liquidado → factura validada y pagada;
- liquidado sin proforma previa → pedido y factura en un solo paso;
- caducado o fallido → proforma cancelada; no hay factura;
- devuelto después de facturar → rectificativa;
- repetir la conciliación → ningún documento duplicado;
- total distinto → no se valida, queda `failed`;
- Odoo caído o sin configurar → `reconcile()` termina igual (acceso y deuda sin cambios) y la fila queda `failed`/no hace nada;
- falta el NIF → `ODOO_PARTNER_INVALID`, sin documentos;
- `invoice-document` con un pago de otro negocio → rechazado;
- el upsert de pagos no sobrescribe los campos fiscales.

Verificación: `pnpm lint`, `pnpm test`, `pnpm build`. Una prueba completa en staging contra Odoo (alta, renovación SEPA y devolución) antes de producción.

## Riesgos

- **Redondeo:** con una sola línea, `round(base × 21 %)` en Odoo coincide con `grossCents`. La comprobación del total cubre cualquier diferencia.
- **Disponibilidad de Odoo:** si Odoo está caído, la factura se retrasa hasta la siguiente conciliación (el cron es diario como mínimo), sin pérdidas.
- **Odoo compartido con staging** mientras esté en pruebas: aceptado; se resuelve con el reinicio antes de la actividad real.
