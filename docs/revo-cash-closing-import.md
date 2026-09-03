# Importación del historial fiscal de REVO

En CRM → Ventas → Informes Z → Cierres de caja, pulsar **Importar desde REVO**.
Elegir explícitamente el local de destino, seleccionar el CSV fiscal y revisar
las fechas, el número de días y los importes antes de confirmar. La selección
del destino es independiente del local que se está consultando en el informe.

El importador acepta el CSV separado por punto y coma con las columnas
`date;total;tipTotal;paymentMethodRelation.name;`, decimales con coma, BOM,
CRLF, campos entre comillas y la columna vacía final de REVO. Reconoce
`Efectiu`/`Efectivo`/`Cash` y `Targeta`/`Tarjeta`/`Card`, sin distinguir
mayúsculas. Los métodos desconocidos, fechas inválidas o importes mal formados
impiden importar el archivo y muestran la línea que hay que revisar.

Las filas se agrupan por fecha y forma de pago, conservando importes negativos
de devoluciones. `total` se conserva tal como lo exporta REVO; `tipTotal`
se conserva por separado y no se vuelve a sumar al total del informe.
Las fechas se guardan como días, sin inventar horas ni aplicarles el cambio
de día operativo del POS. Límite: 10 MB, 100.000 filas y 10.000 días por archivo.

Los cierres se muestran en la tabla, los filtros y la gráfica de Informes Z,
identificados como REVO. El detalle conserva el nombre del archivo, fecha de
importación, filas de origen y propinas por forma de pago. Los arqueos,
descuadres, fondos, horas y número de tickets no están disponibles en este CSV.
No se crean sesiones de caja, tickets, ventas, movimientos de stock ni documentos
fiscales. El historial operativo de cajas usado para reimpresión sigue mostrando
los cierres generados por el POS.

## Persistencia y despliegue

Aplicar `supabase/migrations/20260903100000_import_revo_cash_closings.sql`
antes de desplegar el frontend. También se incluye en el SQL consolidado
para instalaciones nuevas. La tabla `imported_cash_closings` guarda el histórico
y la RPC `import_revo_cash_closings` importa el archivo completo en una transacción.

El servidor obtiene el tenant a partir del local y exige propietario activo o
gerente activo asignado a ese local. RLS limita las lecturas y prohíbe escrituras
directas al cliente autenticado. Se registra el usuario que importa el archivo.

La clave única es tenant + local + origen + día. Los reintentos y archivos
solapados omiten días con iguales importes. Si un día existente tiene importes
distintos, toda la operación se revierte, incluidos los días nuevos del archivo.
No se sobrescriben ni se suman automáticamente importaciones contradictorias.
Las importaciones simultáneas del mismo local se serializan mediante un bloqueo
transaccional del local. Los informes leen páginas de 500 registros hasta
recuperar el histórico completo, sin el antiguo límite de 1.000 cierres.

## Validación

Ejecutar:

```sh
node --test tests/revo-cash-closing-import.test.mjs tests/revo-cash-closing-sql.test.mjs tests/crm-cash-closing-reports.test.mjs
```

Se comprueban agrupación y céntimos, propinas, fechas, CSV inválidos, filtros y
gráfica combinados, permisos por local, RLS real, reintentos, conflictos con
reversión completa e importación de más de 1.000 días con PostgreSQL/PGlite.
