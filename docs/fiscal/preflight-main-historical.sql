-- Solo consulta: no crea objetos ni ejecuta la reconstrucción.
-- Ejecutar en el editor SQL con acceso a todos los tenants (postgres).
-- Usa únicamente tablas anteriores al nuevo SIF.
-- BLOQUEO: condición que rechaza la migración actual.
-- REVISAR: incoherencia adicional o caso que necesita inspección.
-- La fuente fiscal se elige en el mismo orden que la reconstrucción.
with
target_tickets as materialized (
  select t.*, v.name as venue_name
  from public.tickets t
  left join public.venues v on v.tenant_id=t.tenant_id and v.id=t.venue_id
  where t.status in ('paid','void')
),
sales_check as (
  select t.id as ticket_id, count(s.id) as sale_count,
    bool_or(s.venue_id is distinct from t.venue_id
      or s.cash_register_id is distinct from t.cash_register_id
      or s.total_cents is distinct from t.total_cents) filter (where s.id is not null) as sale_mismatch
  from target_tickets t
  left join public.sales s on s.tenant_id=t.tenant_id and s.ticket_id=t.id
  group by t.id
),
payments_check as (
  select t.id as ticket_id, count(p.id) as payment_count,
    coalesce(sum(p.amount_cents::numeric),0) as paid_cents
  from target_tickets t
  left join public.sales s on s.tenant_id=t.tenant_id and s.ticket_id=t.id
  left join public.sale_payments p on p.tenant_id=t.tenant_id and p.sale_id=s.id
  group by t.id
),
events_check as (
  select t.id as ticket_id, count(e.id) as creation_event_count,
    (jsonb_agg(e.payload order by e.created_at,e.id) filter (where e.id is not null))->0 as offline_payload
  from target_tickets t
  left join public.offline_event_log e on e.tenant_id=t.tenant_id
    and e.event_kind='sale_created'
    and coalesce(e.payload->'ticket'->>'id',e.payload->>'ticketId')=t.id::text
  where t.status='void'
  group by t.id
),
invoices_check as (
  select t.id as ticket_id, count(fi.id) as invoice_count,
    (jsonb_agg(to_jsonb(fi) order by fi.id) filter (where fi.id is not null))->0 as invoice
  from target_tickets t
  left join public.fiscal_invoices fi on fi.tenant_id=t.tenant_id and fi.ticket_id=t.id
  group by t.id
),
lines_check as (
  select t.id as ticket_id, count(l.id) as line_count,
    count(l.id) filter (where l.tax_rate is null or l.tax_rate not in (4,10,21)
      or l.taxable_base_cents is null or l.tax_amount_cents is null or l.net_total_cents is null
      or l.taxable_base_cents::numeric+l.tax_amount_cents::numeric<>l.net_total_cents) as invalid_lines,
    sum(l.taxable_base_cents::numeric+l.tax_amount_cents::numeric) as line_fiscal_total
  from target_tickets t
  left join public.ticket_lines l on l.tenant_id=t.tenant_id and l.ticket_id=t.id
  group by t.id
),
sources as (
  select t.*, s.sale_count,s.sale_mismatch,p.payment_count,p.paid_cents,
    coalesce(e.creation_event_count,0) as creation_event_count,
    coalesce(e.offline_payload,'{}'::jsonb) as offline_payload,
    i.invoice_count,i.invoice,l.line_count,l.invalid_lines,l.line_fiscal_total,
    coalesce(e.offline_payload->'sale'->>'id',e.offline_payload->>'saleId') as void_sale_id,
    case when i.invoice_count>0 then i.invoice->>'invoice_type'='normal'
      else coalesce(t.is_invoice,false) end as complete_invoice,
    coalesce(nullif(i.invoice->'document_data'->'recipient','null'::jsonb),
      nullif(t.customer_snapshot,'null'::jsonb)) as recipient,
    case
      when l.line_count>0 and l.invalid_lines=0 then 'ticket_lines'
      when jsonb_typeof(i.invoice->'document_data'->'taxBreakdown')='array'
        and i.invoice->'document_data'->'taxBreakdown'<>'[]'::jsonb then 'taxBreakdown'
      when jsonb_typeof(i.invoice->'request_payload'->'lineas')='array'
        and i.invoice->'request_payload'->'lineas'<>'[]'::jsonb then 'request_payload.lineas'
      when t.status='void' and jsonb_typeof(e.offline_payload->'lines')='array' then 'offline.lines'
      else 'missing'
    end as fiscal_source
  from target_tickets t
  join sales_check s on s.ticket_id=t.id
  join payments_check p on p.ticket_id=t.id
  join invoices_check i on i.ticket_id=t.id
  join lines_check l on l.ticket_id=t.id
  left join events_check e on e.ticket_id=t.id
),
json_items as (
  select s.id as ticket_id,s.fiscal_source,item,
    case s.fiscal_source
      when 'taxBreakdown' then item->>'rate'
      when 'request_payload.lineas' then coalesce(item->>'tipo_impositivo',item->>'TipoImpositivo')
      else item->'fiscalSnapshot'->>'taxRate' end as rate_text,
    case s.fiscal_source
      when 'taxBreakdown' then item->>'baseCents'
      when 'request_payload.lineas' then coalesce(item->>'base_imponible',item->>'BaseImponibleOimporteNoSujeto')
      else item->'fiscalSnapshot'->>'taxableBaseCents' end as base_text,
    case s.fiscal_source
      when 'taxBreakdown' then item->>'taxCents'
      when 'request_payload.lineas' then coalesce(item->>'cuota_repercutida',item->>'CuotaRepercutida')
      else item->'fiscalSnapshot'->>'taxAmountCents' end as tax_text
  from sources s
  cross join lateral jsonb_array_elements(case s.fiscal_source
    when 'taxBreakdown' then s.invoice->'document_data'->'taxBreakdown'
    when 'request_payload.lineas' then s.invoice->'request_payload'->'lineas'
    when 'offline.lines' then s.offline_payload->'lines'
    else '[]'::jsonb end) item
),
validated_items as (
  select j.*,
    coalesce(rate_text ~ '^(4|10|21)([.]0+)?$',false) as rate_valid,
    coalesce(case when fiscal_source='request_payload.lineas'
      then base_text ~ '^[0-9]{1,12}[.][0-9]{2}$'
      else base_text ~ '^[0-9]{1,19}$' end,false) as base_format_valid,
    coalesce(case when fiscal_source='request_payload.lineas'
      then tax_text ~ '^[0-9]{1,12}[.][0-9]{2}$'
      else tax_text ~ '^[0-9]{1,19}$' end,false) as tax_format_valid
  from json_items j
),
parsed_items as (
  select j.*,
    case when base_format_valid then base_text::numeric *
      case when fiscal_source='request_payload.lineas' then 100 else 1 end end as base_cents,
    case when tax_format_valid then tax_text::numeric *
      case when fiscal_source='request_payload.lineas' then 100 else 1 end end as tax_cents
  from validated_items j
),
json_check as (
  select ticket_id,count(*) as item_count,
    count(*) filter (where not rate_valid or not base_format_valid or not tax_format_valid
      or base_cents>9223372036854775807 or tax_cents>9223372036854775807) as invalid_items,
    sum(base_cents+tax_cents) as json_fiscal_total,
    count(*) filter (where fiscal_source='offline.lines' and
      (item->'fiscalSnapshot' is null or jsonb_typeof(item->'fiscalSnapshot')<>'object')) as missing_snapshots
  from parsed_items group by ticket_id
),
diagnostics as (
  select s.*,coalesce(j.item_count,0) as json_item_count,
    coalesce(j.invalid_items,0) as invalid_json_items,
    case when s.fiscal_source='ticket_lines' then s.line_fiscal_total else j.json_fiscal_total end as fiscal_total,
    array_remove(array[
      case when s.status='paid' and s.sale_count<>1 then 'BLOQUEO_VENTA_AUSENTE_O_MULTIPLE' end,
      case when s.status='paid' and s.sale_count=1 and s.sale_mismatch then 'BLOQUEO_VENTA_LOCAL_CAJA_O_TOTAL_DISTINTO' end,
      case when s.status='paid' and s.payment_count>1 then 'BLOQUEO_MULTIPLES_PAGOS' end,
      case when s.status='paid' and s.sale_count=1 and s.payment_count=0 then 'REVISAR_VENTA_SIN_PAGO' end,
      case when s.status='paid' and s.sale_count=1 and s.payment_count>0
        and s.paid_cents<>s.total_cents then 'REVISAR_PAGOS_NO_CUADRAN' end,
      case when s.status='void' and s.creation_event_count<>1 then 'BLOQUEO_EVENTO_SALE_CREATED_AUSENTE_O_MULTIPLE' end,
      case when s.status='void' and s.creation_event_count=1 and (s.void_sale_id is null
        or s.void_sale_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
        then 'BLOQUEO_SALE_ID_ANULADO_AUSENTE_O_INVALIDO' end,
      case when s.invoice_count>1 then 'BLOQUEO_MULTIPLES_FACTURAS_LEGACY' end,
      case when s.invoice_count>0 and (s.invoice->>'provider') not in ('verifactu','ticketbai')
        then 'BLOQUEO_PROVEEDOR_LEGACY_INVALIDO' end,
      case when s.fiscal_source='missing' then 'BLOQUEO_FUENTE_FISCAL_AUSENTE' end,
      case when s.fiscal_source in ('taxBreakdown','request_payload.lineas') and j.invalid_items>0
        then 'BLOQUEO_DESGLOSE_FISCAL_INVALIDO' end,
      case when s.fiscal_source='offline.lines' and j.missing_snapshots>0 then 'BLOQUEO_SNAPSHOT_OFFLINE_AUSENTE' end,
      case when s.fiscal_source='offline.lines' and (coalesce(j.item_count,0)=0 or j.invalid_items>0)
        then 'REVISAR_SNAPSHOT_OFFLINE_VACIO_O_INVALIDO' end,
      case when (case when s.fiscal_source='ticket_lines' then s.line_fiscal_total else j.json_fiscal_total end)<>s.total_cents
        then 'BLOQUEO_TOTAL_FISCAL_NO_CUADRA' end,
      case when s.fiscal_source<>'missing' and
        (case when s.fiscal_source='ticket_lines' then s.line_fiscal_total else j.json_fiscal_total end) is null
        then 'REVISAR_TOTAL_FISCAL_NULO' end,
      case when s.complete_invoice and (
        coalesce(nullif(btrim(s.recipient->>'legalName'),''),nullif(btrim(s.recipient->>'name'),''),
          nullif(btrim(s.recipient->>'nombre'),'')) is null
        or upper(regexp_replace(coalesce(s.recipient->>'taxId',s.recipient->>'nif',''),
          '[^A-Za-z0-9]','','g')) !~ '^[A-Z0-9]{9}$') then 'BLOQUEO_DESTINATARIO_FACTURA_INVALIDO' end
    ],null) as issues
  from sources s left join json_check j on j.ticket_id=s.id
),
summary as (
  select issue,count(*) as affected_tickets
  from diagnostics d cross join lateral unnest(d.issues) issue
  group by issue
)
select '0_TOTAL' as tipo,'TICKETS_REVISADOS' as motivo,count(*) as cantidad,
  null::uuid as tenant_id,null::uuid as ticket_id,null::text as local,
  null::text as estado,null::jsonb as detalle
from diagnostics
union all
select '1_RESUMEN',issue,affected_tickets,null::uuid,null::uuid,null::text,null::text,null::jsonb
from summary
union all
select '2_TICKET',issue,1,d.tenant_id,d.id,d.venue_name,d.status,
  jsonb_build_object('numeroTicket',d.ticket_number,'fecha',d.local_created_at,
    'ventas',d.sale_count,'pagos',d.payment_count,'totalTicketCents',d.total_cents,
    'totalPagadoCents',d.paid_cents,'eventosSaleCreated',d.creation_event_count,
    'facturasLegacy',d.invoice_count,'fuenteFiscal',d.fiscal_source,
    'lineas',d.line_count,'lineasNoUtilizables',d.invalid_lines,
    'elementosJSON',d.json_item_count,'elementosJSONInvalidos',d.invalid_json_items,
    'totalFiscalCents',d.fiscal_total)
from diagnostics d cross join lateral unnest(d.issues) issue
order by tipo,motivo,tenant_id,ticket_id;
