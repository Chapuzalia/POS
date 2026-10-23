# Cuentas demo de staging

La seed `scripts/seed-staging-demos.mjs` crea exclusivamente estos tenants:

| Tenant / propietario CRM | Escenario |
| --- | --- |
| `demo-staging-bar` / `demo.bar@example.com` | Bar La Esquina: sin mesas, 12 productos y un TPV de barra. |
| `demo-staging-restaurante` / `demo.restaurante@example.com` | El Olivo: salón y terraza, 12 mesas, 16 productos, modificadores, reservas, TPV, comandero y cocina KDS. |
| `demo-staging-grupo` / `demo.grupo@example.com` | Horizonte Centro, Puerto y Terraza: 12 mesas y 16 productos por local, TPV, comandero, KDS, inventario, consumos directos, proveedores, promociones y módulos avanzados. Un manager asignado a Centro. |

Los trece dispositivos tienen su propia cuenta con rol `cashier`, como en el flujo
normal de alta. Los propietarios acceden al CRM. El manager es
`demo.grupo.manager@example.com`; las cuentas de dispositivo tienen el patrón
`demo.<bar|restaurante|grupo>.<número de local>.<checkout|hybrid|satellite|kds>@example.com`.

**Cashlogy y Verifactu no se activan en ninguna cuenta.** No se configuran
conexiones fiscales, AEAT, Stripe, impresoras físicas ni agentes de hardware.
Los datos son ficticios. La seed base no genera ventas ni cierres; el histórico
opcional descrito más abajo añade actividad para estadísticas. No se generan documentos fiscales.
Los módulos de OCR y Assist del grupo están disponibles; Assist empieza apagado
por local y no se lanzan trabajos externos durante la seed. Las cajas se crean mediante los triggers existentes
al asignar sus usuarios; empiezan cerradas. El inventario incluye movimientos de
apertura de 100 unidades de cuatro artículos por local y sus rutas/consumos.

## Destino fijo y ejecución

La herramienta utiliza SSH `vps2` y comprueba los contenedores exactos del
proyecto Compose `irsdd2liytrh7dttjr5rzj3j` y su API externa
`https://pre-api-tpv.alteilsolutions.com`. No utiliza `.env.local`, la base
enlazada de la CLI ni variables con destinos arbitrarios. Necesita SSH y el
acceso administrativo Docker existente en staging. Lee las claves solo en
memoria en el servidor, sin copiarlas a archivos locales ni imprimirlas.

```powershell
node scripts/seed-staging-demos.mjs --check irsdd2liytrh7dttjr5rzj3j
node scripts/seed-staging-demos.mjs --apply irsdd2liytrh7dttjr5rzj3j
node scripts/seed-staging-demos.mjs --verify irsdd2liytrh7dttjr5rzj3j
```

`--check` solo lee y muestra el plan. `--apply` guarda contraseñas aleatorias
independientes en `backups/staging-demos/credentials.local.json` (ignorado por
Git), crea usuarios mediante Auth Admin, valida la carga completa con rollback
y aplica los datos de negocio en una transacción. Los usuarios Auth quedan
creados si falla el SQL; repetir el comando permite continuar, sin borrar datos.
Conservar el archivo privado para reanudar y acceder a las cuentas. No se envían
correos ni se restablecen contraseñas de usuarios existentes.

La carga usa UUID estables y no reemplaza los otros tenants ni reinicia los
precios, mesas, existencias, ventas o configuración modificados durante las
demos. Ajusta la lista de módulos de estos tres tenants al escenario definido
y mantiene Cashlogy desactivado. Se detiene si encuentra colisiones de identidad
o configuración fiscal existente. Las escrituras SQL llevan bloqueo de seed y
timeouts; no modifica esquema, RLS, migraciones ni despliegues.

Ambos modos `--apply` y `--verify` verifican las 17 contraseñas mediante Auth,
consultan la Data API con las sesiones reales y comprueban aislamiento de
tenant, local y dispositivo, incluyendo consultas explícitas a otro tenant.
Cierran las sesiones de verificación y guardan el resultado sin contraseñas en
`backups/staging-demos/verification.local.json`.

Pruebas locales: `node --test tests/staging-demos.test.mjs`.

## Cambiar las contraseñas de las demos

`--rotate-passwords` recibe una nueva contraseña común de 8 a 128 caracteres por
stdin (nunca por argumentos). Comprueba los IDs, las marcas de seed de Auth y que
ninguna cuenta pertenezca a otros tenants antes de cambiar las 17 contraseñas por
Auth Admin. Guarda el manifiesto previsto en
`backups/staging-demos/password-rotation.local.json` antes de empezar, actualiza
el archivo habitual al terminar y verifica de nuevo todos los accesos. Si se
interrumpe, repetir con la misma contraseña permite completar la operación.

## Histórico para estadísticas

`scripts/seed-staging-demo-history.mjs` añade 90 días de ventas ficticias a los
cinco locales ya creados, incluyendo actividad parcial del día de ejecución.
Utiliza el mismo destino fijo y las mismas comprobaciones de contenedores/API.
No requiere migraciones ni modifica permisos o reglas de negocio.

```powershell
node scripts/seed-staging-demo-history.mjs --check irsdd2liytrh7dttjr5rzj3j
node scripts/seed-staging-demo-history.mjs --apply irsdd2liytrh7dttjr5rzj3j
node scripts/seed-staging-demo-history.mjs --verify irsdd2liytrh7dttjr5rzj3j
```

El plan se congela en `backups/staging-demos/history-plan.local.json`, sin
contraseñas. Conserva las fechas, IDs y snapshots de catálogo/precios de esa
ejecución. Volver a aplicar el mismo plan no duplica datos ni recalcula ventas
ya creadas. Se detiene ante colisiones o si un local tiene configuración fiscal.

La carga valida primero una jornada de cada local con rollback y después usa
transacciones independientes por jornada. Si se interrumpe, las jornadas ya
cerradas se conservan y el comando puede continuar. Un turno real abierto en una
caja impide insertar una jornada histórica en esa caja; la herramienta no cierra
turnos ajenos ni deja abiertos los turnos ficticios.

Las ventas pasan por `sync_sale_created_v2` con el usuario real de cada caja y
los cierres por `close_cash_register_session`. Se conservan los controles de
tenant, local, dispositivo, importes, IVA, descuentos y numeración. No se omiten
triggers ni se usa el bypass fiscal. Al crear los cierres ficticios, su fecha y
la del snapshot de cierre se fijan al día simulado dentro de la misma transacción.

El conjunto incluye efectivo y tarjeta, cambios en efectivo, más actividad en
fin de semana, crecimiento moderado entre meses, diferencias entre locales,
descuentos en el grupo, modificadores de hamburguesa y retiradas de efectivo
con pequeños descuadres de arqueo ocasionales. Los consumos de inventario los
generan los triggers normales. Se registran reposiciones ficticias de 150
unidades cuando hace falta; las existencias iniciales de la seed se sitúan antes
del primer día para ordenar el historial. No se inventan costes conocidos sin
documentos de compra: los márgenes pueden mostrar costes pendientes.

Se comprueba la correspondencia entre tickets, líneas, pagos y cajas; los
snapshots de categorías e IVA; el saldo de existencias frente a sus movimientos;
y que no haya identidades Cashlogy ni registros fiscales. La verificación final
inicia sesión como cada propietario y consulta las mismas RPC de estadísticas
que usa el CRM para los 90 días, el mes actual, el anterior y la actividad diaria.
También comprueba que consultar un local de otro tenant devuelve cero datos.
El resultado queda en `backups/staging-demos/history-verification.local.json`.

Pruebas enfocadas: `node --test tests/staging-demo-history.test.mjs tests/staging-demos.test.mjs`.
