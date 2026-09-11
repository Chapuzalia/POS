# Migraciones seguras para producción

## Regla principal

Cualquier migración desplegada debe seguir siendo compatible con la versión anterior del POS que pueda continuar abierta durante el deploy.

Cada archivo nuevo debe empezar con esta declaración y límites explícitos:

```sql
-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
```

El checker solo analiza archivos añadidos. Si se modifica, renombra o elimina una migración existente, CI falla: la historia aplicada es inmutable y la corrección debe escribirse como otra migración.

Un despliegue no es atómico para todos los dispositivos: una versión anterior del cliente puede seguir creando, leyendo o actualizando datos mientras la nueva versión empieza a usarse. Las migraciones deben permitir que ambas convivan.

## Patrón expand/contract

Divide los cambios incompatibles en releases independientes:

1. **Expandir:** añade la nueva estructura sin retirar ni cambiar la anterior. Despliega un cliente que sea compatible con ambas y, cuando aplique, escriba o lea los dos formatos.
2. **Migrar:** rellena o transforma los datos existentes de forma segura y observa que ya no haya clientes antiguos en uso.
3. **Contraer:** en un release posterior, retira la estructura, RPC o comportamiento anterior.

No combines la expansión y la contracción en la misma migración de producción.

## Cambios generalmente seguros

- `CREATE TABLE`.
- Añadir una columna nullable.
- Añadir una columna con un `DEFAULT` compatible con los clientes anteriores.
- Crear índices nuevos con `CREATE INDEX CONCURRENTLY`.
- Añadir funciones o RPC nuevas, manteniendo las existentes.

Incluso estos cambios deben revisarse si afectan a tablas grandes, bloqueos o permisos.

## Cambios breaking

Los siguientes cambios pueden romper una versión anterior del POS y deben dividirse en varios releases usando expand/contract:

- Cualquier `DROP`.
- `RENAME` de tablas, columnas, funciones o RPC.
- Cambios de tipo incompatibles.
- Hacer obligatorio un campo que el cliente anterior no envía.
- Eliminar o cambiar el contrato de RPC que usan clientes existentes.
- Cambios de RLS que impidan al cliente anterior leer o escribir como antes.

Antes de la fase de contracción, confirma que la versión anterior ya no puede permanecer activa y que los datos y clientes se han migrado.

## Bloqueos y constraints

- Los índices de tablas existentes se crean con `CONCURRENTLY` para no bloquear escrituras.
- Las claves foráneas y constraints `CHECK` se añaden primero como `NOT VALID` y se validan en una migración posterior.
- Una restricción `UNIQUE` o `PRIMARY KEY` sobre una tabla existente se prepara con un índice único concurrente y después se adjunta con `USING INDEX`.
- `lock_timeout` limita cuánto espera una migración por un lock; `statement_timeout` evita que un backfill o validación quede ejecutándose indefinidamente.

## Ventana N-1

El deploy genera `app-version.json` con exactamente dos versiones compatibles: la nueva y el último deploy de producción que terminó correctamente. Por ello, cada migración del release actual debe mantener el contrato de base de datos utilizado por esa versión anterior.

El pipeline calcula el rango desde el último deploy completo correcto hasta el commit actual. Si un deploy intermedio falla, sus migraciones vuelven a analizarse en el siguiente intento y no pueden colarse por usar solamente el último push.

En el primer despliegue protegido, si todavía no existe una ejecución correcta de `production.yml`, la variable de repositorio `PRODUCTION_BASE_SHA` debe contener el SHA completo del commit que está realmente en producción. Después del primer deploy correcto, el historial de ejecuciones pasa a ser la fuente automática y esa variable queda solo como fallback de arranque.
