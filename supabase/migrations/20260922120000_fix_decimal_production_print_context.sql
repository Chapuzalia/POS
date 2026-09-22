-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

create function public.production_item_lines(p_snapshot jsonb, p_quantity numeric)
returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  lines jsonb := jsonb_build_array(
    p_quantity::text || 'x ' || coalesce(p_snapshot ->> 'productName', 'Producto')
  );
  modifier jsonb;
  note_value text;
begin
  if coalesce(p_snapshot ->> 'variantName', '') <> '' then
    lines := lines || jsonb_build_array('  ' || upper(p_snapshot ->> 'variantName'));
  end if;
  if coalesce(p_snapshot ->> 'parentProductName', '') <> '' then
    lines := lines || jsonb_build_array('  MENÚ: ' || upper(p_snapshot ->> 'parentProductName'));
  end if;
  for modifier in select value from jsonb_array_elements(coalesce(p_snapshot -> 'lineModifiers', '[]'::jsonb)) loop
    lines := lines || jsonb_build_array('  ' || upper(coalesce(modifier ->> 'name', '')));
  end loop;
  for modifier in select value from jsonb_array_elements(coalesce(p_snapshot -> 'componentModifiers', '[]'::jsonb)) loop
    lines := lines || jsonb_build_array('  ' || upper(coalesce(modifier ->> 'name', '')));
  end loop;
  note_value := nullif(btrim(coalesce(p_snapshot ->> 'note', '')), '');
  if note_value is not null then lines := lines || jsonb_build_array('  NOTA: ' || upper(note_value)); end if;
  return lines;
end;
$$;

create function public.production_item_print_context(p_snapshot jsonb, p_quantity numeric)
returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare details jsonb := '[]'::jsonb; modifier jsonb; note_value text;
begin
  if nullif(btrim(coalesce(p_snapshot ->> 'variantName', '')), '') is not null then
    details := details || jsonb_build_array(jsonb_build_object('text', '  ' || upper(p_snapshot ->> 'variantName')));
  end if;
  if nullif(btrim(coalesce(p_snapshot ->> 'parentProductName', '')), '') is not null then
    details := details || jsonb_build_array(jsonb_build_object('text', '  MENÚ: ' || upper(p_snapshot ->> 'parentProductName')));
  end if;
  for modifier in select value from jsonb_array_elements(coalesce(p_snapshot -> 'lineModifiers', '[]'::jsonb)) loop
    details := details || jsonb_build_array(jsonb_build_object('text', '  ' || upper(coalesce(modifier ->> 'name', ''))));
  end loop;
  for modifier in select value from jsonb_array_elements(coalesce(p_snapshot -> 'componentModifiers', '[]'::jsonb)) loop
    details := details || jsonb_build_array(jsonb_build_object('text', '  ' || upper(coalesce(modifier ->> 'name', ''))));
  end loop;
  note_value := nullif(btrim(coalesce(p_snapshot ->> 'note', '')), '');
  if note_value is not null then
    details := details || jsonb_build_array(jsonb_build_object('text', '  NOTA: ' || upper(note_value)));
  end if;
  return jsonb_build_object(
    'quantity', p_quantity,
    'name', coalesce(nullif(btrim(p_snapshot ->> 'productName'), ''), 'Producto'),
    'details', details
  );
end;
$$;

notify pgrst, 'reload schema';
