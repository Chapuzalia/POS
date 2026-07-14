# Accesos por dispositivo

## Despliegue

1. Ejecuta `schema.sql` y las migraciones anteriores del proyecto.
2. Ejecuta `pos-security-hardening-migration.sql`.
3. Ejecuta `device-user-access-migration.sql`.
4. Ejecuta `5.login-lease-inactivity-migration.sql`.
5. Despliega la funcion de administracion:

```bash
supabase functions deploy manage-pos-users
```

Supabase proporciona automaticamente a la funcion `SUPABASE_URL`,
`SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY`. La clave de servicio no debe
configurarse nunca en Vite ni exponerse al navegador.

## Primer administrador

El primer usuario debe existir en Supabase Auth y tener una membresia `owner` o
`admin`. `setup-tenant.sql` permite preparar ese usuario y el negocio inicial.
Solo esos dos roles pueden abrir `/crm` y administrar catalogo, locales,
dispositivos y usuarios TPV.

Los usuarios creados desde **CRM > Accesos** reciben el rol `cashier` y una unica
asignacion activa a un dispositivo. Para iniciar sesion usan unicamente su email y
contrasena. El negocio, local y dispositivo se resuelven desde su membresia y
asignacion, y no se eligen en la pantalla de login.

Cada cuenta debe pertenecer a un solo negocio activo. Si una cuenta tiene varias
membresias, el acceso se rechaza para no seleccionar un negocio de forma arbitraria.

## Sesion unica

`device-user-access-migration.sql` crea una concesion de login exclusiva por
usuario y `5.login-lease-inactivity-migration.sql` anade su caducidad por inactividad.
La aplicacion comprueba la concesion cada 30 segundos, pero solo la renueva cuando
detecta una interaccion real. Tras 30 minutos sin actividad cierra la sesion y libera
la cuenta; un cierre normal la libera inmediatamente. El owner tambien puede ver y
liberar sesiones concretas desde **CRM > Accesos**.

## Catalogo por local

La misma migracion anade `products.venue_id`. Cada producto pertenece a un unico
local, con sus propias variantes, precios y modificadores. El desplegable superior
del CRM selecciona el catalogo y las estadisticas que se consultan. Crear, importar,
editar o eliminar un producto afecta solamente al local seleccionado.

Al ejecutar la migracion, los productos del modelo compartido anterior se duplican
en cada local donde estaban disponibles, incluyendo variantes y modificadores.

## Usuarios existentes

Los usuarios `cashier` anteriores a esta migracion deben asignarse desde el CRM o
insertarse manualmente en `device_user_assignments`. Hasta tener una asignacion
activa no podran entrar al TPV.
