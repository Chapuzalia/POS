# Runbook de migración del catálogo

La migración no se ha ejecutado contra producción. Debe desplegarse base de datos antes que la aplicación, porque la nueva carga del catálogo consulta las tablas nuevas y no usa errores de tabla inexistente como control de flujo.

## Preparación

1. Congelar temporalmente la edición del catálogo.
2. Hacer backup completo de PostgreSQL/Supabase, incluyendo `auth` y storage.
3. Exportar desde CRM el catálogo de cada local y conservar el ZIP.
4. Registrar el fingerprint de precios ejecutando la última consulta de `supabase/verification/catalog_architecture_verification.sql` antes del cambio.
5. Restaurar el backup en un proyecto de staging aislado.

## Despliegue en staging

1. Ejecutar `supabase/29.catalog-architecture-migration.sql` completo en una transacción.
2. Ejecutar `supabase/verification/catalog_architecture_verification.sql` sin modificarlo.
3. Exigir cero errores. Revisar manualmente las filas `REVIEW`, especialmente variantes sin formato y snapshots históricos aproximados.
4. Comparar conteos y fingerprint de precios. La migración no contiene ningún `UPDATE price_cents`.
5. Corregir datos ambiguos mediante IDs explícitos; no añadir aliases al cliente.
6. Desplegar esta versión de la aplicación en staging.
7. Vaciar únicamente la caché del navegador de un terminal de pruebas; conservar otro terminal con caché antigua para comprobar el adaptador.

## Matriz de aceptación

- Bar clásico: seis pestañas, mismo orden/iconos, Todo, Top, categorías, destacados y precios.
- Cubata: mixer obligatorio, suplemento idéntico al legacy y mismo número de pulsaciones.
- Copa/chupito/botellines/cóctel: variante correcta sin inferencia por nombre.
- Venta rápida: pago en efectivo/tarjeta, descuento, IVA, ticket, reimpresión y cajón.
- Mesas: crear/editar/eliminar/servir línea, guardar/recuperar borrador, unir/dividir, pago completo, por partes y por items.
- Restaurante: Entera/Media, modificador gratuito/de pago y producto directo sin diálogo.
- Menú: mínimos/máximos, incluido/suplemento, rechazo de menú incompleto y ausencia de doble cobro.
- Impresión: componente y modificador aparecen una vez; el mixer no figura como modificador sintético.
- Informes: histórico previo conserva nombres/totales; tickets nuevos agrupan por IDs/snapshots.
- Inventario: no existe en esta versión; verificar la proyección `getSaleLineConsumption` y no activar integración externa sin prueba idempotente.
- Cierre de caja: totales, descuentos, movimientos y documento de cierre sin cambios.
- RLS: usuario de tenant/local A no puede consultar ni modificar datos de B.

## Producción

1. Repetir backup completo y exportación del catálogo.
2. Ejecutar la migración SQL.
3. Ejecutar inmediatamente la verificación.
4. Detener el despliegue si aparece cualquier `ERROR` o diferencia de fingerprint/precios.
5. Resolver y documentar los casos `REVIEW`.
6. Desplegar la aplicación.
7. Realizar una venta controlada directa y otra en mesa por cada método de pago.
8. Verificar impresión, informes y cierre de caja.
9. Reabrir la edición del catálogo.

## Rollback lógico

No borrar las tablas ni revertir el backfill. Si falla la aplicación:

1. Volver a desplegar la versión anterior.
2. Mantener intactas las columnas `kind`, `sale_formats`, `can_sell_standalone`, `can_use_as_mixer` y `mixer_supplement_cents`.
3. Mantener todos los datos nuevos para diagnóstico.
4. Si hace falta, desactivar el catálogo nuevo manteniendo `catalog_profile = 'bar_classic'`; la versión anterior ignorará ese campo.
5. No ejecutar `DROP`, no restaurar parcialmente tickets y no reescribir importes históricos.

## Validación del repositorio

Desde la raíz:

```bash
npm run lint
npm test
npm run build
```

El proyecto usa npm en `package.json`; `pnpm-lock.yaml` también existe, pero los comandos canónicos configurados son los anteriores.

