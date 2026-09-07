begin;
-- Match the OCR representations used by the TypeScript metadata extractor.
create or replace function public.supplier_metadata_ocr_texts(p_ocr jsonb)
returns table(content text) language sql immutable set search_path to '' as $$
  select distinct value #>> '{}' from jsonb_path_query(coalesce(p_ocr, '{}'), '$.**.text') value
  union
  select string_agg(cell ->> 'text', ' | ' order by (cell ->> 'columnIndex')::int)
  from jsonb_path_query(coalesce(p_ocr, '{}'), '$.pages[*].tables[*]') table_data,
    lateral jsonb_array_elements(case when jsonb_typeof(table_data -> 'cells') = 'array' then table_data -> 'cells' else '[]'::jsonb end) cell
  group by table_data, cell ->> 'rowIndex'
  union
  select (header.cell ->> 'text') || ' | ' || (below.cell ->> 'text')
  from jsonb_path_query(coalesce(p_ocr, '{}'), '$.pages[*].tables[*]') table_data,
    lateral jsonb_array_elements(table_data -> 'cells') header(cell),
    lateral jsonb_array_elements(table_data -> 'cells') below(cell)
  where (below.cell ->> 'rowIndex')::int = (header.cell ->> 'rowIndex')::int + coalesce((header.cell ->> 'rowSpan')::int, 1)
    and below.cell ->> 'columnIndex' = header.cell ->> 'columnIndex'
    and header.cell ->> 'text' !~ '[0-9]';
$$;

-- Canonicalize OCR whitespace within identifiers, retaining literal evidence separately.
alter function public.normalize_supplier_metadata_value(text, text) rename to normalize_supplier_metadata_value_before_spacing;
revoke all on function public.normalize_supplier_metadata_value_before_spacing(text, text) from public, anon, authenticated;
create function public.normalize_supplier_metadata_value(p_field text, p_value text)
returns text language plpgsql immutable set search_path to '' as $$
begin
  if p_field = 'number' then
    return case when char_length(btrim(p_value)) <= 80 then
      nullif(regexp_replace(btrim(p_value), '[[:space:]]*([/_.-])[[:space:]]*', '\1', 'g'), '') end;
  end if;
  return public.normalize_supplier_metadata_value_before_spacing(p_field, p_value);
end;
$$;
revoke all on function public.normalize_supplier_metadata_value(text, text) from public, anon, authenticated;

-- Corrections are independent evidence when the final value and label can be
-- re-derived unambiguously from OCR. Never reuse a model's discarded citation.
create or replace function public.learn_confirmed_supplier_document_metadata(p_document_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
declare d public.supplier_documents%rowtype; f text; entry jsonb; candidate jsonb; final_value text;
begin
  select * into strict d from public.supplier_documents where id = p_document_id and status = 'confirmed';
  if public.supplier_document_learning_excluded(p_document_id) then
    update public.supplier_documents set extraction_metadata = jsonb_set(extraction_metadata,
      '{metadataExtraction}', coalesce(extraction_metadata -> 'metadataExtraction', '{}') ||
        jsonb_build_object('date', coalesce(extraction_metadata #> '{metadataExtraction,date}', '{}') || jsonb_build_object('learningEligible', false),
          'number', coalesce(extraction_metadata #> '{metadataExtraction,number}', '{}') || jsonb_build_object('learningEligible', false)))
      where id = p_document_id;
    return;
  end if;
  foreach f in array array['date','number'] loop
    entry := d.extraction_metadata #> array['metadataExtraction', f];
    if entry ->> 'userModified' is distinct from 'true' then continue; end if;
    final_value := case f when 'date' then d.document_date::text else d.document_number end;
    candidate := public.supplier_metadata_confirmed_candidate(d.ocr_snapshot, f, final_value);
    if candidate is not null then
      update public.supplier_documents set extraction_metadata = jsonb_set(extraction_metadata,
        array['metadataExtraction', f], entry || candidate || jsonb_build_object('value', final_value,
          'source', 'manual', 'learningEligible', true, 'profileFailed', true))
        where id = p_document_id;
    end if;
  end loop;
  perform public.learn_confirmed_supplier_document_metadata_before_guard(p_document_id);
end;
$$;
create or replace function public.supplier_metadata_candidates(p_ocr jsonb, p_field text)
returns table(value text, evidence text, label text) language plpgsql immutable set search_path to '' as $$
declare v_text text; v_line text; v_match text[]; v_label text; v_pattern text;
begin
  if p_field not in ('date', 'number') then return; end if;
  v_pattern := case when p_field = 'date'
    then '([^0-9|]{2,80})[[:space:]:#|]+([0-9]{4}-[0-9]{1,2}-[0-9]{1,2}|[0-9]{1,2}[./-][0-9]{1,2}[./-][0-9]{4})'
    else '([^0-9|]{2,80})[[:space:]:#|]+([A-Za-z0-9]+([[:blank:]]*[/_.-][[:blank:]]*[A-Za-z0-9]+)*)' end;
  for v_text in select content from public.supplier_metadata_ocr_texts(p_ocr) loop
    for v_line in
      with lines as (select line, lead(line) over(order by ordinal) next_line
        from regexp_split_to_table(v_text, E'\n') with ordinality items(line, ordinal))
      select line from lines union all select line || E'\n' || next_line from lines
        where line !~ '[0-9]' and char_length(line) between 2 and 80
          and next_line ~ '^[[:space:]]*[A-Za-z0-9/_.-]*[0-9][A-Za-z0-9/_.-]*([[:space:]|]|$)'
    loop
      for v_match in select regexp_matches(v_line, v_pattern, 'g') loop
        v_label := btrim(regexp_replace(v_match[1], '^[[:space:]|:#-]+|[[:space:]|:#-]+$', '', 'g'));
        if char_length(v_label) not between 2 and 80 or v_label !~ '[[:alpha:]]' or v_label ~ '[0-9]'
          or public.normalize_supplier_metadata_label(v_label) ~ '\m(VENCIMIENTO|ENTREGA|PEDIDO|PAGO|CADUCIDAD|CLIENTE|CIF|NIF|VAT|TELEFONO|IBAN|TOTAL|IMPORTE|REFERENCIA|RESUM|RESUMEN)\M'
          or public.normalize_supplier_metadata_value(p_field, v_match[2]) is null
          or (p_field = 'number' and (v_match[2] !~ '[0-9]' or public.normalize_supplier_metadata_value('date', v_match[2]) is not null))
          or (p_field = 'number' and public.normalize_supplier_metadata_label(v_label) !~ '\m(FACTURA|ALBARAN|DOCUMENTO|NUMERO|NUM|NRO)\M'
            and v_label !~* 'n[º°.]')
          then continue; end if;
        if char_length(v_line) > 500 then continue; end if;
        value := v_match[2]; label := v_label; evidence := btrim(v_line);
        return next;
      end loop;
    end loop;
  end loop;
end;
$$;



commit;

