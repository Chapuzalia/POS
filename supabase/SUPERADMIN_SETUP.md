# Configuracion inicial del superadmin

La cuenta superadmin es global y no pertenece a ningun tenant. Puede crear negocios, su primer local y su usuario `owner`; cada `owner` entra despues en `/crm` y crea sus dispositivos y cuentas `cashier`.

## 1. Aplicar la base de datos

En Supabase SQL Editor ejecuta `complete-database.sql` completo. Si la base ya estaba creada, puedes ejecutar solamente `superadmin-migration.sql`.

## 2. Crear la cuenta Auth

En Supabase Dashboard abre **Authentication > Users > Add user** y crea el usuario superadmin con email y contrasena. Confirma el email al crearlo.

## 3. Conceder el privilegio global

En SQL Editor ejecuta, sustituyendo el email:

```sql
insert into public.profiles (id, full_name, is_superadmin)
select id, coalesce(raw_user_meta_data ->> 'full_name', email), true
from auth.users
where lower(email) = lower('superadmin@tu-dominio.com')
on conflict (id) do update
set full_name = excluded.full_name,
    is_superadmin = true;
```

Comprueba que la consulta afecte a una fila. No añadas esta cuenta a `tenant_memberships`.

## 4. Desplegar la Edge Function

Despliega la version actualizada de `manage-pos-users`:

```bash
supabase functions deploy manage-pos-users
```

La funcion usa `SUPABASE_SERVICE_ROLE_KEY` solamente en el servidor. Nunca añadas esa clave a `.env.local` ni a una variable con prefijo `VITE_`.

## 5. Iniciar sesion

Usa el formulario normal de acceso. La aplicacion detectara `is_superadmin` y abrira `/superadmin`. Desde ahi podrás crear el tenant, el primer local y las credenciales iniciales del `owner`.
