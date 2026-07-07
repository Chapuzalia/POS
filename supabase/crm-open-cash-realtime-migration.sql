-- Realtime para el dashboard CRM de cajas abiertas.
-- Ejecutar una vez en Supabase SQL Editor.

do $$
begin
  alter publication supabase_realtime add table public.cash_sessions;
exception
  when duplicate_object or undefined_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.sales;
exception
  when duplicate_object or undefined_object then null;
end $$;
