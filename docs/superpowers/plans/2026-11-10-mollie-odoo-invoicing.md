# Facturación Mollie → Odoo: plan de implementación

> **Para agentes:** SUB-SKILL OBLIGATORIA: usa superpowers:subagent-driven-development (recomendada) o superpowers:executing-plans para implementar este plan tarea por tarea. Los pasos usan casillas (`- [ ]`) para el seguimiento.

**Objetivo:** cada pago de Mollie guardado en `billing_invoices` genera en Odoo una proforma (`sale.order`) mientras está pendiente, una factura validada y pagada al liquidarse y una rectificativa si se devuelve. El propietario descarga los PDF desde Mi Plan.

**Arquitectura:** un cliente JSON-2 de Odoo (`odoo.ts`) y una máquina de estados (`odoo-sync.ts`) que `BillingService.reconcile()` llama dentro de la reclamación de sincronización (`sync_claim`) existente, justo antes de `sync_commit`. Sus errores no se propagan nunca. El estado se guarda en una tabla nueva solo para la service role, `billing_odoo_documents`, y se refleja en las columnas existentes de `billing_invoices`. Una acción nueva de `billing`, `invoice-document`, sirve los PDF desde el servidor.

**Stack:** Edge Functions en Deno (TypeScript, `fetch`), Postgres de Supabase, Vitest + PGlite (`tests/helpers/billing-db.mjs`), React 19 + HeroUI (Mi Plan).

**Spec:** `docs/superpowers/specs/2026-11-10-mollie-odoo-invoicing-design.md`

## Restricciones globales

- El dinero se maneja en céntimos enteros. El único paso de euros (float de Odoo) a céntimos es `Math.round(value * 100)`, y solo se usa para comparar.
- Odoo nunca bloquea la facturación: `reconcile()` devuelve lo mismo y proyecta acceso y deuda igual, aunque Odoo falle, esté caído o no esté configurado.
- Idempotencia: siempre se busca antes de crear. El pedido se busca por `client_order_ref = <tr_…>`, la factura por `invoice_ids` del pedido y la rectificativa por `reversed_entry_id`.
- Solo se avanza: `invoiced` → `refunded` es la única salida de `invoiced`. Una factura validada nunca se cancela.
- Antes de `action_post`, `Math.round(amount_total * 100) === amount_due_cents`. Si no coincide: no se valida, queda `failed`/`ODOO_TOTAL_MISMATCH`.
- Secretos: `ODOO_URL`, `ODOO_DB` y `ODOO_API_KEY`, todos opcionales. Sin ellos, el paso no hace nada. No se registran nunca la clave, los cuerpos de las peticiones, las respuestas, los NIF, los nombres, los tokens ni las URLs de portal.
- Referencias fijas en Odoo: producto `default_code = 'TICKIT-SUB'`, diario de cobro `code = 'MOLL'` (tipo banco) y diario de ventas por defecto (`INV`). Se buscan por estos valores, no por ID.
- La migración empieza exactamente con `-- migration-safety: expand` / `set lock_timeout = '5s';` / `set statement_timeout = '5min';`. No modifica migraciones anteriores ni el CHECK de `fiscal_export_status`.
- Códigos de error: `ODOO_UNAVAILABLE`, `ODOO_AUTH`, `ODOO_REJECTED`, `ODOO_TOTAL_MISMATCH`, `ODOO_PARTNER_INVALID`, `ODOO_SETUP_MISSING`.
- Mi Plan: los controles son táctiles (sin interacciones que dependan del hover) y usan los tokens CRM existentes.
- Gestor de paquetes `pnpm`; comandos `pnpm test`, `pnpm lint` y `pnpm build`.
- No se aplica nada en producción (Odoo, secretos, despliegue) sin el permiso explícito del usuario.

## Puntos de revisión

1. **Webhook y cron a la vez para el mismo negocio:** no debe crearse un segundo pedido. Se cubre ejecutando `syncOdoo` dentro de la reclamación de `reconcile()`; la Tarea 3 lo prueba lanzando dos `reconcile()` en paralelo y comprobando un solo pedido.
2. **Devolución de un pago que nunca llegó a facturarse** (Odoo estaba caído al liquidarse): debe emitirse la factura y después la rectificativa, no quedarse atascado. Se prueba en la Tarea 3.
3. **Redondeo del IVA:** para toda base neta `n`, `grossCents(netFromGross(grossCents(n))) === grossCents(n)`; si no, el total de Odoo no cuadraría. La Tarea 3 lo prueba con todos los valores de 1 a 200 000.
4. **Odoo lento:** cada llamada tiene un tiempo máximo de 15 s y se procesan como mucho 10 pagos por ejecución, para no retener la reclamación de sincronización. La Tarea 3 lo prueba con un tope de 10.
5. **Propietario de otro negocio pidiendo un PDF:** `invoice-document` responde 403 por pertenencia y además el servicio comprueba `tenant_id`. Se prueba en la Tarea 4.

---

### Tarea 1: Migración `billing_odoo_documents`

**Archivos:**
- Crear: `supabase/migrations/20261110120000_billing_odoo_documents.sql`
- Modificar: `tests/helpers/billing-db.mjs` (cargar la migración nueva después de `20261109200000_…`)
- Test: `tests/functional/billing-odoo-sync.test.ts` (nuevo)

**Interfaces:**
- Produce la columna `billing_accounts.odoo_partner_id bigint` (puede ser nula).
- Produce la tabla `public.billing_odoo_documents(payment_id text pk → billing_invoices.stripe_invoice_id, tenant_id uuid not null → billing_accounts.tenant_id, state text not null check in ('proforma','invoiced','canceled','refunded','failed'), sale_order_id bigint, invoice_id bigint, refund_id bigint, invoice_number text, last_error text, attempts integer not null default 0, updated_at timestamptz not null default now())`, con el índice `billing_odoo_documents_tenant_idx(tenant_id)`, RLS activada y sin políticas ni grants para `anon`/`authenticated`.

- [ ] **Paso 1: escribir el test que falla** `it('keeps Odoo documents private to the service role')`. Inserta un pago con el fixture (`activate()`), fija `set role authenticated` y `test.uid = owner`, y comprueba que `select * from billing_odoo_documents` falla con permiso denegado. Comprueba también que insertar `state = 'bogus'` como superusuario viola el CHECK.
- [ ] **Paso 2:** `pnpm vitest run tests/functional/billing-odoo-sync.test.ts`. Resultado esperado: FALLA (la relación no existe).
- [ ] **Paso 3:** escribir la migración con la cabecera expand. Los `CHECK` y las `FK` de la tabla nueva van en línea, porque la tabla se crea vacía. Añadir `revoke all on public.billing_odoo_documents from anon, authenticated;`. No hace falta tocar la purga: el trigger de `20261101190202` ya impide borrar un negocio que tenga filas en `billing_invoices`, y la FK lo extiende a los documentos.
- [ ] **Paso 4:** cargar la migración en `billing-db.mjs`. Ejecutar el test → PASA. Ejecutar `pnpm vitest run tests/functional/mollie-billing.test.ts` → PASA, sin cambios.
- [ ] **Paso 5: commit** `feat(billing): add billing_odoo_documents table`

### Tarea 2: Cliente JSON-2 de Odoo

**Archivos:**
- Crear: `supabase/functions/_shared/billing/odoo.ts`
- Modificar: `supabase/functions/_shared/billing/env.ts`
- Test: `tests/functional/odoo-gateway.test.ts`

**Interfaces:**
- Produce `export class OdooRequestError extends Error`, con `message` dentro del conjunto de códigos de las restricciones globales y `diagnostic: { status: number }`.
- Produce `export class OdooGateway { constructor(url: string, db: string, key: string, transport: typeof fetch = fetch); call<T>(model: string, method: string, params: Record<string, unknown>): Promise<T>; pdf(path: string): Promise<Uint8Array> }`.
  - `call` hace POST a `${url}/json/2/${model}/${method}` con las cabeceras `Authorization: bearer <key>`, `X-Odoo-Database: <db>` y `Content-Type: application/json`, el cuerpo `JSON.stringify(params)` y `AbortSignal.timeout(15_000)`.
  - `pdf` solo acepta rutas que empiecen por `/my/` y hace GET a `${url}${path}`. Exige `content-type` `application/pdf` y un tamaño máximo de 5 MB.
- Produce `export function odooFromEnv(): OdooGateway | null`, que devuelve null si falta alguna de las tres variables. Además, `billingServiceFromEnv` pasa `odooFromEnv()` como 5.º argumento del constructor (Tarea 3).

- [ ] **Paso 1: escribir los tests que fallan**, con un `transport` falso que registra las peticiones:
  - `it('posts JSON-2 calls with bearer key and database header')`: comprueba la URL `https://odoo.test/json/2/res.partner/search_read`, las cabeceras y que el cuerpo se envía sin cambios.
  - `it('maps failures to codes without leaking bodies')`: un fallo de `fetch` → `ODOO_UNAVAILABLE`; 500 → `ODOO_UNAVAILABLE`; 401 y 403 → `ODOO_AUTH`; 400 y 422 → `ODOO_REJECTED`. Comprueba que en el error serializado (`JSON.stringify` + `String`) no aparecen ni la clave ni el texto del cuerpo.
  - `it('only downloads portal PDFs')`: `pdf('/web/x')` lanza `ODOO_REJECTED`; una respuesta `text/html` lanza `ODOO_REJECTED`; un PDF devuelve sus bytes.
  - `it('is disabled without the three env vars')` con `vi.stubGlobal('Deno', { env: { get } })` → `odooFromEnv()` es null.
- [ ] **Paso 2:** `pnpm vitest run tests/functional/odoo-gateway.test.ts` → FALLA.
- [ ] **Paso 3:** implementar `odoo.ts` siguiendo el estilo de `MollieGateway` en `mollie.ts`. Añadir `odooFromEnv` en `env.ts`.
- [ ] **Paso 4:** ejecutar el test → PASA.
- [ ] **Paso 5: commit** `feat(billing): add Odoo JSON-2 gateway`

### Tarea 3: Máquina de estados de la sincronización y conexión con `reconcile()`

**Archivos:**
- Crear: `supabase/functions/_shared/billing/odoo-sync.ts`
- Modificar: `supabase/functions/_shared/billing/service.ts` (constructor y `reconcile()`), `supabase/functions/_shared/billing/env.ts` (`billingServiceFromEnv`), `supabase/functions/_shared/billing/diagnostics.ts`
- Modificar: `tests/helpers/billing-service.mjs` (añadir `FakeOdoo`; `createBillingService` acepta `{ odoo }`)
- Test: `tests/functional/billing-odoo-sync.test.ts`

**Interfaces:**
- Consume `OdooGateway.call` y `OdooRequestError` de la Tarea 2, y la tabla de la Tarea 1.
- Produce `export type OdooState = 'proforma' | 'invoiced' | 'canceled' | 'refunded' | 'failed'`.
- Produce `export function targetOdooState(status: string): 'proforma' | 'invoiced' | 'canceled' | 'refunded' | null`, con esta correspondencia: `open`/`processing` → `proforma`; `paid` → `invoiced`; `uncollectible` → `refunded`; `void`/`failed`/`expired`/`canceled` → `canceled`; cualquier otro → `null` (se omite).
- Produce `export async function syncOdoo(input: { odoo: OdooGateway; db: SupabaseClient; account: Account; payments: MolliePayment[]; mode: 'test' | 'live' }): Promise<{ processed: number; failed: number }>`. Nunca lanza errores.
- `BillingService` pasa a tener el constructor `(db, mollie, appUrl, webhookUrl, odoo: OdooGateway | null = null)`. En `reconcile()`, justo antes de `sync_commit`: `if (this.odoo) await syncOdoo({ odoo: this.odoo, db: this.db, account, payments, mode: this.mollie.mode })`.

**Algoritmo (por fila de `billing_invoices` del negocio, unida con `billing_odoo_documents`, como mucho 10 por ejecución, empezando por las más antiguas):**

```
target = targetOdooState(row.status); doc = documento actual o ninguno
saltar si target es null, o si doc.state === target
saltar si doc.state ∈ {invoiced, refunded} y target ∈ {proforma, canceled}    // solo se avanza
saltar si doc.state === 'canceled' y target ∈ {proforma, canceled}
partner = account.odoo_partner_id ?? buscar o crear res.partner por vat (y guardarlo)
order   = sale.order search_read [['client_order_ref','=',row.id]] ?? create(...)
si target === 'canceled' → sale.order action_cancel si no está cancelado; state canceled
si target ∈ {invoiced, refunded}:
  invoice = invoice_ids del pedido ?? (action_confirm; sale.advance.payment.inv create {advance_payment_method:'delivered', sale_order_ids:[[6,0,[order]]]} → create_invoices)
  si borrador: comprobar total → action_post
  si payment_state no es 'paid'/'in_payment': account.payment.register create (context active_model/active_ids) {journal_id: MOLL, payment_date: paid_at, communication: row.id} → action_create_payments
  invoice_number = name de la factura
si target === 'refunded':
  refund = account.move search_read [['reversed_entry_id','=',invoice]] ?? (account.move.reversal create {journal_id: INV, reason: 'Devolución '+row.id} → refund_moves)
  si la rectificativa está en borrador → action_post
upsert del documento con los IDs, state target, last_error null
actualizar billing_invoices: fiscal_export_status 'exported' (invoiced/refunded) o 'pending_review'; number = invoice_number; fiscal_external_reference 'account.move:<id>' o 'sale.order:<id>'
si hay error: upsert del documento con state 'failed', last_error = código conocido o 'ODOO_REJECTED', attempts + 1; fiscal_export_status 'failed'; seguir con la siguiente fila
```

Detalles de los documentos:
- **Cliente:** `{ name: account.legal_name, vat, is_company: true, country_id }`. El país se busca en `res.country` por el prefijo de dos letras del NIF, o `ES` si no lo tiene. Sin `legal_name` o sin `tax_id` → `ODOO_PARTNER_INVALID`.
- **Línea del pedido:** `{ product_id: TICKIT-SUB, name: payment.description ?? 'Tickit POS', product_uom_qty: 1, price_unit: netCents / 100 }`, con `netCents = row.paid_excluding_tax_cents || netFromGross(row.amount_due_cents)`.
- **Referencia del pedido:** `client_order_ref = row.id` y `origin = 'Tickit ' + mode`.
- Si falta el producto o el diario → `ODOO_SETUP_MISSING`.
- **Diagnóstico** (`diagnostics.ts`): se añade `export function odooSyncDiagnostic(result)`, que escribe `{ event: 'billing_odoo_sync', processed, failed }` con `console.error` cuando `failed > 0`, sin identificadores.

`FakeOdoo` (en `billing-service.mjs`) implementa `call(model, method, params)` en memoria para los modelos y métodos anteriores. Valida los totales con `round(price_unit * 0.21, 2)`, numera las facturas como `INV/2026/00001`, y ofrece `offline`, `calls` y una opción para forzar el total, `totalOffsetCents`.

- [ ] **Paso 1: escribir los tests que fallan** en `billing-odoo-sync.test.ts`, usando `createBillingService(..., { odoo: fake })` y los ayudantes de `FakeMollie`:
  - `it('creates a proforma while the first card payment is open')`: el pedido existe con `client_order_ref = tr_…` y una línea de 49,00 para 4900 céntimos; el documento queda `proforma`, la fila `pending_review` y `fiscal_external_reference` `sale.order:<id>`.
  - `it('posts and pays the invoice when the payment settles')`: después de `payFirst()` y `reconcile`, la factura queda validada, `amount_total` 59,29, el pago registrado en `MOLL`, `number = 'INV/2026/00001'` y la fila `exported`.
  - `it('invoices a SEPA renewal only after it settles')`: `renew('pending')` → `proforma`; `settle()` → `invoiced`.
  - `it('cancels the proforma when the payment expires')`: `payFirst('expired')` → pedido cancelado y ninguna factura.
  - `it('issues a credit note when a settled payment is charged back')`: `chargeBack()` → rectificativa validada con `reversed_entry_id`; estado `refunded`.
  - `it('invoices then refunds a charge-back that was never invoiced')`: `offline` durante la liquidación y después `chargeBack` → factura y rectificativa.
  - `it('never duplicates documents across retries and concurrent reconciles')`: tres `reconcile()` (dos de ellos con `Promise.allSettled`) → un pedido, una factura y un cobro.
  - `it('refuses to post when Odoo total differs from Mollie')`: `totalOffsetCents = 1` → `failed`/`ODOO_TOTAL_MISMATCH`; la factura sigue en borrador y `number` es nulo.
  - `it('keeps billing access unchanged when Odoo is down or missing')`: con `offline` y con `odoo = null`, `reconcile()` devuelve `{ reconciled: true }`, la cuenta queda `active`/`paid` y la fila `failed` (o sin documento si `odoo = null`).
  - `it('fails without partner data and creates nothing')`: `legal_name` nulo → `ODOO_PARTNER_INVALID` y ninguna llamada `create`.
  - `it('does not overwrite fiscal fields when payments are re-upserted')`: después de `invoiced`, otro `reconcile` mantiene `number` y `fiscal_export_status`.
  - `it('processes at most 10 payments per run')`.
  - `it('round-trips VAT for every net amount')`: para `n` de 1 a 200 000, `grossCents(netFromGross(grossCents(n))) === grossCents(n)`.
- [ ] **Paso 2:** `pnpm vitest run tests/functional/billing-odoo-sync.test.ts` → FALLA.
- [ ] **Paso 3:** implementar `odoo-sync.ts`, la conexión con el constructor y `reconcile()`, `billingServiceFromEnv` y el diagnóstico.
- [ ] **Paso 4:** ejecutar el test → PASA. Ejecutar `pnpm vitest run tests/functional/mollie-billing.test.ts tests/functional/billing-*.test.ts` → PASA, sin cambios.
- [ ] **Paso 5: commit** `feat(billing): sync Mollie payments to Odoo proformas and invoices`

### Tarea 4: Acción `invoice-document` y documentos en `detail()`

**Archivos:**
- Modificar: `supabase/functions/_shared/billing/schemas.ts`, `supabase/functions/billing/index.ts`, `supabase/functions/_shared/billing/service.ts`, `supabase/functions/_shared/billing/errors.ts`
- Test: `tests/functional/billing-odoo-sync.test.ts`, `tests/functional/billing-endpoint.test.ts`

**Interfaces:**
- Consume `OdooGateway.call` y `OdooGateway.pdf`, y la tabla `billing_odoo_documents`.
- Produce el esquema `z.object({ action: z.literal('invoice-document'), tenantId: z.uuid(), paymentId: z.string().regex(/^tr_[A-Za-z0-9]{4,40}$/), document: z.enum(['main', 'refund']) }).strict()` dentro de `requestSchema`.
- Produce `BillingService.invoiceDocument(tenantId: string, paymentId: string, document: 'main' | 'refund'): Promise<{ filename: string; contentType: 'application/pdf'; base64: string }>`. Toma `billing_odoo_documents` filtrando por `payment_id` **y** `tenant_id`, y si no lo encuentra lanza `BILLING_DOCUMENT_UNAVAILABLE`. `main` = factura si existe, si no el pedido; `refund` = `refund_id`. Pide `get_portal_url` con `{ ids: [id], report_type: 'pdf', download: true }` y después usa `odoo.pdf(path)`. El `filename` es `<número o 'Proforma-' + paymentId>.pdf`.
- Produce en `detail()`: cada fila de `invoices` incluye `odoo_state: OdooState | null` y `has_refund: boolean`, leídos de `billing_odoo_documents` para el negocio.
- Produce el mensaje de usuario `BILLING_DOCUMENT_UNAVAILABLE`: «El documento todavía no está disponible.»
- Produce en `overview()` (solo superadmin) el campo `odoo: { enabled: boolean; failed: number }`, con `enabled = this.odoo !== null` y `failed` igual al número de filas `state = 'failed'`.

- [ ] **Paso 1: escribir los tests que fallan:**
  - `it('serves the invoice PDF of the own tenant only')`: `invoiceDocument(ids.tenant, tr, 'main')` devuelve un `base64` que se decodifica como `%PDF`; `invoiceDocument(ids.other, tr, 'main')` lanza `BILLING_DOCUMENT_UNAVAILABLE`.
  - `it('serves the proforma before settlement and the refund after charge-back')`.
  - `it('exposes odoo_state and has_refund in detail')`.
  - `it('reports Odoo status and failed documents in overview')`: sin Odoo → `{ enabled: false, failed: 0 }`; con una fila `failed` → `failed: 1`.
  - En `billing-endpoint.test.ts`, siguiendo el patrón actual: la acción `invoice-document` de un propietario de otro negocio → 403, y un `paymentId` con formato inválido → 400.
- [ ] **Paso 2:** ejecutar los dos archivos → FALLA.
- [ ] **Paso 3:** implementar el esquema, `case 'invoice-document': return reply(await service.invoiceDocument(body.tenantId, body.paymentId, body.document))`, el método y el mensaje.
- [ ] **Paso 4:** ejecutar los dos archivos → PASA.
- [ ] **Paso 5: commit** `feat(billing): serve Odoo invoice PDFs to tenant owners`

### Tarea 5: Mi Plan

**Archivos:**
- Modificar: `src/features/billing/types.ts` (`BillingInvoice` + `odoo_state: 'proforma' | 'invoiced' | 'canceled' | 'refunded' | 'failed' | null; has_refund: boolean`), `src/features/billing/service.ts`, `src/features/billing/TenantBillingPanel.tsx`, `src/features/billing/presentation.ts`
- Test: el test funcional de Mi Plan que ya existe y renderiza `TenantBillingPanel` (`tests/functional/billing-onboarding.test.ts` o `billing-admin.test.ts`; usa el que ya monta el panel del propietario)

**Interfaces:**
- Consume la acción `invoice-document` de la Tarea 4.
- Produce `export async function downloadBillingDocument(tenantId: string, paymentId: string, document: 'main' | 'refund'): Promise<void>` en `src/features/billing/service.ts`. Usa `billingRequest`, convierte el `base64` en un `Blob` `application/pdf` y lo descarga con un `<a download>` temporal y `URL.revokeObjectURL`.
- Produce `export const odooDocumentLabel = (state: BillingInvoice['odoo_state']) => …` en `presentation.ts`: `proforma` → «Proforma», `invoiced` → «Emitida», `refunded` → «Rectificada», `canceled` → «Anulada», `failed` → «Pendiente de emisión», `null` → «—».

- [ ] **Paso 1: escribir el test que falla** `it('shows Odoo number, fiscal state and downloads the PDF')`: una fila `invoiced` muestra `INV/2026/00001`, «Emitida» y un botón «Descargar PDF», que llama a `billing` con `{ action: 'invoice-document', document: 'main' }`. Una fila `refunded` muestra además «Descargar rectificativa». Una fila `proforma` muestra «Proforma» y su botón.
- [ ] **Paso 2:** ejecutar ese test → FALLA.
- [ ] **Paso 3:** en la tabla «Facturas de suscripción» (`TenantBillingPanel.tsx:257`), la columna «Factura» muestra `number ?? 'Proforma'`; se añade la columna «Estado fiscal» con `odooDocumentLabel`, y en «Documento» van los botones de HeroUI que ya se usan en el panel (con objetivo táctil y estado de carga), visibles cuando `odoo_state ∈ {proforma, invoiced, refunded}`. Los errores se muestran con el patrón de `UserFacingError` del panel. En `BillingAdmin.tsx`, el resumen muestra «Odoo desactivado» o «Odoo: N documentos pendientes de emisión» a partir de `overview.odoo`, y el test de `billing-admin.test.ts` cubre los dos textos.
- [ ] **Paso 4:** ejecutar el test → PASA.
- [ ] **Paso 5: commit** `feat(billing): show Odoo invoices in Mi Plan`

### Tarea 6: Documentación, guía de configuración de Odoo y verificación completa

**Archivos:**
- Modificar: `docs/mollie-billing.md` (sustituir la sección «Facturas» y la parte de «emisión automática de facturas» de «Pendiente»)

- [ ] **Paso 1:** documentar el flujo, las variables `ODOO_*`, los valores fijos `TICKIT-SUB`/`MOLL`, los estados, la descarga desde Mi Plan y el «Paso a actividad real» de la spec.
- [ ] **Paso 2:** documentar la configuración de Odoo que **requiere permiso explícito** antes de ejecutarse en el Odoo de producción:
  1. producto de servicio `TICKIT-SUB` «Suscripción Tickit POS», con el impuesto «21% S» (id 2) y facturación según cantidad pedida;
  2. diario bancario `MOLL` «Mollie»;
  3. la opción «Factura proforma» de Ventas;
  4. usuario técnico con permisos de Facturación y Ventas, y su clave API;
  5. secretos `ODOO_*` en las Edge Functions de staging y producción, y redespliegue de `billing`, `billing-webhook` y `billing-reconcile`.
- [ ] **Paso 3:** `pnpm lint` → sin errores.
- [ ] **Paso 4:** `pnpm test` → todo PASA.
- [ ] **Paso 5:** `pnpm build` → correcto.
- [ ] **Paso 6:** revisar `git diff e4359b9..HEAD` en busca de cambios no relacionados. **Commit** `docs(billing): document Odoo invoicing`.
- [ ] **Paso 7 (fuera del código, con permiso):** pedir permiso al usuario para los pasos 1–5 del Paso 2 y para una prueba completa en staging contra Odoo (alta, renovación SEPA y devolución).
