-- Configurable, venue-scoped print templates. Definitions are declarative JSON;
-- no template value is ever evaluated as SQL or executable code.

create table public.print_template_defaults (
  type text primary key,
  name text not null,
  definition jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint print_template_defaults_type_check check (type ~ '^[a-z][a-z0-9_]{1,79}$'),
  constraint print_template_defaults_definition_check check (
    definition ->> 'version' = '1' and jsonb_typeof(definition -> 'blocks') = 'array'
  )
);

create table public.print_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null,
  type text not null,
  name text not null,
  definition jsonb not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, venue_id, type),
  foreign key (venue_id, tenant_id) references public.venues(id, tenant_id) on delete cascade,
  constraint print_templates_type_check check (type ~ '^[a-z][a-z0-9_]{1,79}$'),
  constraint print_templates_definition_check check (
    definition ->> 'version' = '1' and jsonb_typeof(definition -> 'blocks') = 'array'
  )
);

create index print_templates_venue_idx on public.print_templates(tenant_id, venue_id, type)
  where is_active;

insert into public.print_template_defaults(type, name, definition) values
('simplified_invoice', 'Factura simplificada / ticket', $json$
{"version":1,"blocks":[
  {"id":"venue-name","type":"text","value":"{{venue.name}}","align":"center"},
  {"id":"venue-legal","type":"text","value":"{{venue.legal_name}}","align":"center","when":"venue.legal_name"},
  {"id":"venue-tax","type":"text","value":"NIF/CIF {{venue.tax_id}}","align":"center","when":"venue.tax_id"},
  {"id":"venue-address","type":"text","value":"{{venue.address}}","align":"center","when":"venue.address"},
  {"id":"invoice-heading-gap","type":"spacer","when":"document.title"},
  {"id":"invoice-heading","type":"text","value":"{{document.title}}","align":"center","when":"document.title"},
  {"id":"document-label-gap","type":"spacer","when":"document.label"},
  {"id":"document-label","type":"text","value":"{{document.label}}","align":"center","when":"document.label"},
  {"id":"header-gap","type":"spacer"},
  {"id":"number","type":"row","label":"{{document.number_label}}","value":"{{ticket.number}}"},
  {"id":"date","type":"row","label":"{{document.date_label}}","value":"{{ticket.datetime}}"},
  {"id":"register","type":"row","label":"Caja","value":"{{cash_register.name}}","when":"cash_register.name"},
  {"id":"employee","type":"row","label":"Empleado","value":"{{employee.name}}","when":"employee.name"},
  {"id":"customer-gap","type":"spacer","when":"customer.name"},
  {"id":"customer-title","type":"text","value":"CLIENTE","when":"customer.name"},
  {"id":"customer-separator","type":"separator","when":"customer.name"},
  {"id":"customer-name","type":"text","value":"{{customer.name}}","when":"customer.name"},
  {"id":"customer-tax-id","type":"text","value":"{{customer.tax_id}}","when":"customer.tax_id"},
  {"id":"customer-address","type":"text","value":"{{customer.address}}","when":"customer.address"},
  {"id":"customer-city","type":"text","value":"{{customer.postal_city}}","when":"customer.postal_city"},
  {"id":"customer-province","type":"text","value":"{{customer.province}}","when":"customer.province"},
  {"id":"customer-country","type":"text","value":"{{customer.country}}","when":"customer.show_country"},
  {"id":"items-gap","type":"spacer"},
  {"id":"items-title","type":"text","value":"PRODUCTOS"},
  {"id":"items-separator","type":"separator"},
  {"id":"items","type":"repeat","source":"items","blocks":[
    {"id":"item","type":"row","label":"{{quantity}} x {{name}}","value":"{{total}}"},
    {"id":"details","type":"repeat","source":"details","blocks":[{"id":"detail","type":"text","value":"{{text}}"}]}
  ]},
  {"id":"totals-gap","type":"spacer"},
  {"id":"totals-separator","type":"separator"},
  {"id":"totals","type":"repeat","source":"totals.rows","blocks":[{"id":"total","type":"row","label":"{{label}}","value":"{{value}}"}]},
  {"id":"payment-gap","type":"spacer","when":"payment.rows"},
  {"id":"payment-title","type":"text","value":"PAGO","when":"payment.rows"},
  {"id":"payment-separator","type":"separator","when":"payment.rows"},
  {"id":"payments","type":"repeat","source":"payment.rows","blocks":[{"id":"payment","type":"row","label":"{{label}}","value":"{{value}}"}]},
  {"id":"fiscal-gap","type":"spacer","when":"fiscal.title"},
  {"id":"fiscal-title","type":"text","value":"{{fiscal.title}}","when":"fiscal.title"},
  {"id":"fiscal-separator","type":"separator","when":"fiscal.title"},
  {"id":"fiscal-code","type":"text","value":"Código: {{fiscal.external_code}}","when":"fiscal.external_code"},
  {"id":"fiscal-qr","type":"qr","value":"{{fiscal.verification_url}}","when":"fiscal.show_qr"},
  {"id":"fiscal-url","type":"text","value":"{{fiscal.verification_url}}","when":"fiscal.show_url"},
  {"id":"fiscal-unavailable","type":"text","value":"QR no disponible.","when":"fiscal.error"},
  {"id":"fiscal-error","type":"text","value":"Motivo: {{fiscal.error}}","when":"fiscal.error"},
  {"id":"footer-gap","type":"spacer","when":"footer.text"},
  {"id":"footer","type":"text","value":"{{footer.text}}","align":"center","when":"footer.text"},
  {"id":"end","type":"spacer","lines":2}
]}
$json$::jsonb),
('cash_closure', 'Cierre de caja (X/Z)', $json$
{"version":1,"blocks":[
  {"id":"title","type":"text","value":"{{document.title}}","align":"center"},
  {"id":"venue","type":"text","value":"{{venue.name}}","align":"center"},
  {"id":"legal","type":"text","value":"{{venue.legal_name}}","align":"center","when":"venue.legal_name"},
  {"id":"tax","type":"text","value":"NIF/CIF {{venue.tax_id}}","align":"center","when":"venue.tax_id"},
  {"id":"address","type":"text","value":"{{venue.address}}","align":"center","when":"venue.address"},
  {"id":"copy-gap","type":"spacer","when":"document.label"},
  {"id":"copy","type":"text","value":"{{document.label}}","align":"center","when":"document.label"},
  {"id":"gap","type":"spacer"},
  {"id":"register","type":"row","label":"Caja","value":"{{cash_register.name}}"},
  {"id":"session","type":"row","label":"Turno","value":"{{cash_session.number}}"},
  {"id":"date","type":"row","label":"Cierre","value":"{{ticket.datetime}}"},
  {"id":"employee","type":"row","label":"Empleado","value":"{{employee.name}}","when":"employee.name"},
  {"id":"opened","type":"row","label":"Apertura","value":"{{cash_session.opened_at}}","when":"cash_session.show_times"},
  {"id":"closed","type":"row","label":"Cierre","value":"{{cash_session.closed_at}}","when":"cash_session.show_times"},
  {"id":"summary-gap","type":"spacer"},{"id":"summary-title","type":"text","value":"RESUMEN"},{"id":"summary-separator","type":"separator"},
  {"id":"summary","type":"repeat","source":"summary.rows","blocks":[{"id":"summary-row","type":"row","label":"{{label}}","value":"{{value}}"}]},
  {"id":"payments-gap","type":"spacer","when":"payment.rows"},{"id":"payments-title","type":"text","value":"MÉTODOS DE PAGO","when":"payment.rows"},{"id":"payments-separator","type":"separator","when":"payment.rows"},
  {"id":"payments","type":"repeat","source":"payment.rows","blocks":[{"id":"payment-row","type":"row","label":"{{label}}","value":"{{value}}"}]},
  {"id":"cash-gap","type":"spacer"},{"id":"cash-title","type":"text","value":"EFECTIVO"},{"id":"cash-separator","type":"separator"},
  {"id":"cash","type":"repeat","source":"cash.rows","blocks":[{"id":"cash-row","type":"row","label":"{{label}}","value":"{{value}}"}]},
  {"id":"operations-gap","type":"spacer"},{"id":"operations-title","type":"text","value":"OPERATIVA"},{"id":"operations-separator","type":"separator"},
  {"id":"operations","type":"repeat","source":"operations.rows","blocks":[{"id":"operation-row","type":"row","label":"{{label}}","value":"{{value}}"}]},
  {"id":"footer-gap","type":"spacer"},
  {"id":"closure-id","type":"row","label":"ID cierre","value":"{{document.id}}"},
  {"id":"generated","type":"row","label":"Generado","value":"{{document.generated_at}}"},
  {"id":"complete-gap","type":"spacer"},{"id":"complete","type":"text","value":"CIERRE COMPLETADO","align":"center"},{"id":"end","type":"spacer","lines":2}
]}
$json$::jsonb),
('production', 'Comanda de producción', $json$
{"version":1,"blocks":[
  {"id":"top","type":"separator"},
  {"id":"table","type":"text","value":"MESA {{table.name}}","align":"center","bold":true,"size":"large"},
  {"id":"order","type":"text","value":"ENVÍO #{{order.number}}","align":"center","bold":true},
  {"id":"time","type":"text","value":"{{ticket.time}}","align":"center"},
  {"id":"head-separator","type":"separator"},{"id":"gap","type":"spacer"},
  {"id":"destinations","type":"repeat","source":"destinations","blocks":[
    {"id":"destination","type":"text","value":"--- {{name}} ---","align":"center","bold":true},
    {"id":"items","type":"repeat","source":"items","blocks":[
      {"id":"item","type":"text","value":"{{quantity}}x {{name}}","bold":true},
      {"id":"details","type":"repeat","source":"details","blocks":[{"id":"detail","type":"text","value":"{{text}}"}]}
    ]},
    {"id":"destination-gap","type":"spacer"}
  ]},
  {"id":"bottom","type":"separator"}
]}
$json$::jsonb),
('kds', 'KDS', $json$
{"version":1,"blocks":[
  {"id":"order","type":"text","value":"COMANDA #{{order.number}}","bold":true,"size":"large"},
  {"id":"table","type":"text","value":"MESA {{table.name}}","bold":true},
  {"id":"destinations","type":"repeat","source":"destinations","blocks":[
    {"id":"destination","type":"text","value":"{{name}}","bold":true},
    {"id":"items","type":"repeat","source":"items","blocks":[{"id":"item","type":"text","value":"{{quantity}}x {{name}}"}]}
  ]}
]}
$json$::jsonb),
('test', 'Ticket de prueba', $json$
{"version":1,"blocks":[
  {"id":"title","type":"text","value":"ALTEIL LOCAL PRINT AGENT","align":"center","bold":true},
  {"id":"gap-1","type":"spacer"},{"id":"message","type":"text","value":"Impresora detectada correctamente","align":"center"},{"id":"gap-2","type":"spacer"},
  {"id":"ip","type":"row","label":"IP","value":"{{printer.ip}}"},{"id":"port","type":"row","label":"Puerto","value":"{{printer.port}}"},{"id":"date","type":"row","label":"Fecha","value":"{{ticket.datetime}}"},
  {"id":"gap-3","type":"spacer"},{"id":"complete","type":"text","value":"Prueba completada","align":"center","bold":true}
]}
$json$::jsonb);

insert into public.print_template_defaults(type, name, definition)
select 'invoice', 'Factura completa', definition
from public.print_template_defaults where type = 'simplified_invoice';

create or replace function public.print_template_value(p_context jsonb, p_scope jsonb, p_path text)
returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare value jsonb;
begin
  if p_path is null or p_path !~ '^[A-Za-z0-9_]+([.][A-Za-z0-9_]+)*$'
    or p_path ~ '(^|[.])(__proto__|prototype|constructor)([.]|$)' then return null; end if;
  value := p_scope #> string_to_array(p_path, '.');
  if value is null then value := p_context #> string_to_array(p_path, '.'); end if;
  return value;
end;
$$;

create or replace function public.print_template_truthy(p_value jsonb)
returns boolean
language sql immutable
set search_path = ''
as $$
  select case jsonb_typeof(p_value)
    when 'array' then jsonb_array_length(p_value) > 0
    when 'object' then p_value <> '{}'::jsonb
    when 'string' then length(p_value #>> '{}') > 0
    when 'boolean' then (p_value #>> '{}')::boolean
    when 'number' then (p_value #>> '{}')::numeric <> 0
    else false
  end;
$$;

create or replace function public.print_template_interpolate(p_template text, p_context jsonb, p_scope jsonb)
returns text
language plpgsql immutable
set search_path = ''
as $$
declare rendered text := coalesce(p_template, ''); found text[]; path text; value jsonb; replacement text; iterations integer := 0;
begin
  loop
    found := regexp_match(rendered, '([{][{][[:space:]]*([A-Za-z0-9_.]+)[[:space:]]*[}][}])');
    exit when found is null or iterations >= 200;
    path := found[2];
    value := public.print_template_value(p_context, p_scope, path);
    replacement := case when jsonb_typeof(value) in ('string', 'number', 'boolean') then value #>> '{}' else '' end;
    rendered := replace(rendered, found[1], coalesce(replacement, ''));
    iterations := iterations + 1;
  end loop;
  return regexp_replace(rendered, '[[:cntrl:]]', ' ', 'g');
end;
$$;

create or replace function public.print_wrap_text(p_value text, p_columns integer)
returns setof text
language plpgsql immutable
set search_path = ''
as $$
declare remaining text := coalesce(p_value, ''); width integer := greatest(1, least(coalesce(p_columns, 48), 200));
begin
  if remaining = '' then return next ''; return; end if;
  while length(remaining) > width loop
    return next substring(remaining from 1 for width);
    remaining := substring(remaining from width + 1);
  end loop;
  return next remaining;
end;
$$;

create or replace function public.print_render_template_blocks(
  p_blocks jsonb, p_context jsonb, p_scope jsonb, p_columns integer, p_depth integer default 0
)
returns setof jsonb
language plpgsql stable
set search_path = ''
as $$
declare block jsonb; block_type text; value text; line text; collection jsonb; item jsonb; nested jsonb;
  align_value text; size_value text; visible boolean; spacer_index integer;
begin
  if p_depth > 8 or jsonb_typeof(p_blocks) <> 'array' then return; end if;
  for block in select block_value from jsonb_array_elements(p_blocks) as blocks(block_value) loop
    visible := true;
    if nullif(block ->> 'when', '') is not null then
      visible := public.print_template_truthy(public.print_template_value(p_context, p_scope, block ->> 'when'));
    end if;
    if visible and nullif(block ->> 'unless', '') is not null then
      visible := not public.print_template_truthy(public.print_template_value(p_context, p_scope, block ->> 'unless'));
    end if;
    if not visible then continue; end if;
    block_type := block ->> 'type';
    if block_type = 'repeat' then
      collection := public.print_template_value(p_context, p_scope, block ->> 'source');
      if jsonb_typeof(collection) = 'array' and jsonb_typeof(block -> 'blocks') = 'array' then
        for item in select item_value from jsonb_array_elements(collection) as items(item_value) loop
          for nested in select * from public.print_render_template_blocks(block -> 'blocks', p_context, item, p_columns, p_depth + 1) loop
            return next nested;
          end loop;
        end loop;
      end if;
    elsif block_type = 'separator' then
      value := coalesce(nullif(left(block ->> 'character', 1), ''), '-');
      return next jsonb_build_object('type', 'text', 'value', repeat(value, greatest(1, least(p_columns, 200))));
    elsif block_type = 'spacer' then
      for spacer_index in 1..greatest(1, least(coalesce((block ->> 'lines')::integer, 1), 10)) loop
        return next jsonb_build_object('type', 'text', 'value', '');
      end loop;
    elsif block_type = 'qr' then
      value := public.print_template_interpolate(block ->> 'value', p_context, p_scope);
      if value <> '' then return next jsonb_build_object('type', 'qr', 'data', value, 'size', greatest(1, least(coalesce((block ->> 'qrSize')::integer, 6), 16)), 'errorCorrection', 'M'); end if;
    elsif block_type in ('text', 'row') then
      if block_type = 'row' then
        value := public.print_template_interpolate(block ->> 'label', p_context, p_scope);
        line := public.print_template_interpolate(block ->> 'value', p_context, p_scope);
        value := case when length(value) + length(line) + 1 <= p_columns
          then value || repeat(' ', greatest(1, p_columns - length(value) - length(line))) || line
          else value || ' ' || line end;
      else
        value := public.print_template_interpolate(block ->> 'value', p_context, p_scope);
      end if;
      align_value := case when block ->> 'align' in ('left', 'center', 'right') then block ->> 'align' else null end;
      size_value := case when block ->> 'size' in ('normal', 'large') then block ->> 'size' else null end;
      for line in select * from public.print_wrap_text(value, p_columns) loop
        return next jsonb_strip_nulls(jsonb_build_object(
          'type', 'text', 'value', line, 'align', align_value,
          'bold', case when coalesce((block ->> 'bold')::boolean, false) then true else null end,
          'size', size_value
        ));
      end loop;
    end if;
  end loop;
end;
$$;

create or replace function public.print_render_template(
  p_type text, p_tenant_id uuid, p_venue_id uuid, p_context jsonb, p_columns integer
)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare definition jsonb; fallback_definition jsonb; elements jsonb; lines jsonb;
begin
  if auth.role() <> 'service_role' and not public.user_has_venue_access(p_tenant_id, p_venue_id) then
    raise exception 'Plantilla de impresión no disponible' using errcode = '42501';
  end if;
  select template.definition into definition
  from public.print_templates template
  where template.tenant_id = p_tenant_id and template.venue_id = p_venue_id
    and template.type = p_type and template.is_active;
  select template.definition into fallback_definition
  from public.print_template_defaults template where template.type = p_type;
  definition := coalesce(definition, fallback_definition);
  select coalesce(jsonb_agg(rendered.element), '[]'::jsonb) into elements
  from (select element from public.print_render_template_blocks(definition -> 'blocks', p_context, p_context, p_columns) as output(element) limit 1000) rendered;
  if not exists (
    select 1 from jsonb_array_elements(elements) element
    where element ->> 'type' = 'qr' or btrim(coalesce(element ->> 'value', '')) <> ''
  ) and definition is distinct from fallback_definition then
    select coalesce(jsonb_agg(rendered.element), '[]'::jsonb) into elements
    from (select element from public.print_render_template_blocks(fallback_definition -> 'blocks', p_context, p_context, p_columns) as output(element) limit 1000) rendered;
  end if;
  if jsonb_array_length(elements) = 0 then elements := jsonb_build_array(jsonb_build_object('type', 'text', 'value', 'Documento')); end if;
  select coalesce(jsonb_agg(element ->> 'value'), jsonb_build_array('')) into lines
  from jsonb_array_elements(elements) element where element ->> 'type' = 'text';
  return jsonb_build_object('lines', lines, 'elements', elements);
exception
when insufficient_privilege then
  raise;
when others then
  -- A malformed venue override must never block production printing. Retry with
  -- the persisted default in a nested block so even an unexpected renderer
  -- failure still has a final, non-empty emergency ticket.
  begin
    select template.definition into fallback_definition
    from public.print_template_defaults template where template.type = p_type;
    select coalesce(jsonb_agg(rendered.element), '[]'::jsonb) into elements
    from (
      select element
      from public.print_render_template_blocks(
        fallback_definition -> 'blocks', p_context, p_context, p_columns
      ) as output(element)
      limit 1000
    ) rendered;
    if jsonb_array_length(elements) = 0 then
      elements := jsonb_build_array(jsonb_build_object('type', 'text', 'value', 'Documento'));
    end if;
    select coalesce(jsonb_agg(element ->> 'value'), jsonb_build_array('')) into lines
    from jsonb_array_elements(elements) element where element ->> 'type' = 'text';
    return jsonb_build_object('lines', lines, 'elements', elements);
  exception when others then
    return jsonb_build_object(
      'lines', jsonb_build_array('Documento'),
      'elements', jsonb_build_array(jsonb_build_object('type', 'text', 'value', 'Documento'))
    );
  end;
end;
$$;

alter table public.print_template_defaults enable row level security;
alter table public.print_templates enable row level security;

create policy print_template_defaults_read on public.print_template_defaults
for select to authenticated using (true);
create policy print_templates_venue_read on public.print_templates
for select to authenticated using (public.user_has_venue_access(tenant_id, venue_id));
create policy print_templates_admin_insert on public.print_templates
for insert to authenticated with check (public.user_is_tenant_admin(tenant_id));
create policy print_templates_admin_update on public.print_templates
for update to authenticated using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));
create policy print_templates_admin_delete on public.print_templates
for delete to authenticated using (public.user_is_tenant_admin(tenant_id));

revoke all on public.print_template_defaults, public.print_templates from public, anon;
grant select on public.print_template_defaults to authenticated, service_role;
grant select, insert, update, delete on public.print_templates to authenticated;
grant all on public.print_templates to service_role;

revoke all on function public.print_render_template(text, uuid, uuid, jsonb, integer) from public, anon;
grant execute on function public.print_render_template(text, uuid, uuid, jsonb, integer) to authenticated, service_role;
revoke all on function public.print_template_value(jsonb, jsonb, text) from public, anon;
revoke all on function public.print_template_truthy(jsonb) from public, anon;
revoke all on function public.print_template_interpolate(text, jsonb, jsonb) from public, anon;
revoke all on function public.print_wrap_text(text, integer) from public, anon;
revoke all on function public.print_render_template_blocks(jsonb, jsonb, jsonb, integer, integer) from public, anon;

comment on table public.print_templates is 'Venue-scoped declarative print layout overrides. Definitions contain data paths only and cannot execute code.';
comment on table public.print_template_defaults is 'Versioned safe print layouts used whenever a venue override is absent or invalid.';
