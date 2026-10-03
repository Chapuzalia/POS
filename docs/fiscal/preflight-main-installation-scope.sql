-- Solo consulta. Ejecutar como postgres sobre main antes del merge.
-- Cero filas significa que no se detecta ninguno de estos conflictos.
-- La instalación exige una asociación unívoca caja/dispositivo y el local actual.
with historical_scope as materialized (
  select tenant_id, venue_id, cash_register_id, device_id, count(*) as tickets
  from public.tickets
  where status in ('paid','void')
  group by tenant_id, venue_id, cash_register_id, device_id
),
conflicts as (
  select 'CAJA_CON_VARIOS_DISPOSITIVOS'::text as motivo,
    tenant_id,venue_id,cash_register_id,null::uuid as device_id,
    sum(tickets) as tickets,
    jsonb_build_object('dispositivos',jsonb_agg(device_id order by device_id)) as detalle
  from historical_scope
  group by tenant_id,venue_id,cash_register_id
  having count(distinct device_id)>1
  union all
  select 'DISPOSITIVO_CON_VARIAS_CAJAS_O_LOCALES',
    tenant_id,null::uuid,null::uuid,device_id,sum(tickets),
    jsonb_build_object('asociaciones',jsonb_agg(jsonb_build_object(
      'localId',venue_id,'cajaId',cash_register_id) order by venue_id,cash_register_id))
  from historical_scope
  group by tenant_id,device_id
  having count(distinct (venue_id,cash_register_id))>1
  union all
  select 'DISPOSITIVO_FUERA_DEL_LOCAL_O_TENANT',
    h.tenant_id,h.venue_id,h.cash_register_id,h.device_id,h.tickets,
    jsonb_build_object('localActualDispositivo',d.venue_id,'tenantActualDispositivo',d.tenant_id)
  from historical_scope h left join public.devices d on d.id=h.device_id
  where d.id is null or d.tenant_id is distinct from h.tenant_id or d.venue_id is distinct from h.venue_id
  union all
  select 'CAJA_FUERA_DEL_LOCAL_O_TENANT',
    h.tenant_id,h.venue_id,h.cash_register_id,h.device_id,h.tickets,
    jsonb_build_object('localActualCaja',r.venue_id,'tenantActualCaja',r.tenant_id)
  from historical_scope h left join public.cash_registers r on r.id=h.cash_register_id
  where r.id is null or r.tenant_id is distinct from h.tenant_id or r.venue_id is distinct from h.venue_id
)
select c.motivo,c.tenant_id,c.venue_id,v.name as local,c.cash_register_id,
  c.device_id,c.tickets,c.detalle
from conflicts c left join public.venues v on v.tenant_id=c.tenant_id and v.id=c.venue_id
order by c.motivo,c.tenant_id,c.venue_id,c.cash_register_id,c.device_id;
