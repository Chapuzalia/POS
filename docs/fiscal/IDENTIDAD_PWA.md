# Identidad fiscal de la PWA

La caja lógica conserva su código fiscal en `cash_registers.fiscal_code`. Guardar el titular y las cajas en CRM no consume instalaciones. La primera activación de una PWA se confirma desde el POS y asigna el secuencial 1; los reemplazos siguientes consumen 2, 3, etc. Las instalaciones históricas, incluidas las retiradas, también cuentan y nunca se reutilizan sus números.

Las instalaciones nuevas tienen `series_version = 2`, `NumeroInstalacion = LOC-CA-II` y series `LOC-CA-II-AAAA-T`; la identidad completa es `serie/N`. `II` no tiene padding, el año tiene cuatro cifras y `T` es S, F o R. El correlativo de cada nueva serie empieza en 1; la cadena pertenece a la instalación y no se reinicia al cambiar de año o tipo documental. Las instalaciones existentes se marcan como versión 1 sin cambiar números, series, documentos ni hashes.

## Almacenamiento y activación

La identidad y el token de activación se guardan en IndexedDB, en registros con prefijos `pwa-identity:` y `pwa-activation:` dentro de `bindings`. Se mantiene la versión 4 del ledger para no impedir que clientes anteriores accedan a sus colas. Los datos se acotan por tenant, local, caja y dispositivo lógico. El cache legacy en localStorage no autoriza adoptar silenciosamente una instalación. En el primer acceso tras esta actualización se exige una activación explícita si no existe identidad en IndexedDB.

Una lectura correcta sin identidad permite mostrar el diálogo de alta; un error de lectura o una identidad inválida bloquea la emisión. La identidad existente exige un ledger íntegro: binding, cursor de cadena, documentos, estados de entrega, cursores de numeración, huellas AEAT e identidades del antecedente. Los datos incompletos requieren conciliación; no se reinicia la cadena bajo el mismo número.

Antes de llamar al RPC se confirma localmente el token de solicitud y la instalación que el usuario acepta reemplazar. `activate_pwa_fiscal_installation` valida permisos de dispositivo/local/tenant, caja activa y dispositivo habilitado para cobros, serializa el alta y retira la anterior en la misma transacción. El registro permanente de solicitudes devuelve el mismo resultado a los reintentos. Una confirmación desactualizada falla antes de retirar otra instalación; una solicitud cuyo resultado ya fue retirado exige comprobar y confirmar el nuevo estado.

Después del alta se consulta su resultado y la cadena confirmada en Supabase. Se persiste la identidad junto con el binding y cursor local en una transacción de IndexedDB, y solo después se permite emitir. Si falla esta escritura, el token sigue guardado y el reintento recupera el resultado ya creado. Esta garantía cubre reintentos con almacenamiento local conservado; borrar también el token obliga a otra activación explícita.

## Reemplazo y pendientes

El diálogo informa de la retirada, la conservación del historial y la obligación de dejar de utilizar el dispositivo anterior. Un dispositivo offline puede desconocer la retirada. El servidor rechaza los registros con fecha de generación igual o posterior a `retired_at`; los anteriores siguen sujetos a los controles normales de ámbito, idempotencia, cadena y numeración. La sincronización local descubre también las cadenas retiradas y funciona aunque el acceso a emisión esté bloqueado. No se borran los registros rechazados ni sus ventas locales pendientes.

La frontera usa la fecha de generación conservada en el registro. No demuestra el instante físico en un cliente deshonesto o con reloj incorrecto. La exclusión inmediata de un dispositivo offline no es garantizable; las discrepancias de reloj o datos perdidos necesitan conciliación. El puente externo debe aplicar la misma retirada y permitir los pendientes anteriores; este repositorio no implementa dicho servidor.

## Recuperación temporal para pruebas

El botón «Recuperar última instalación válida (pruebas)» solo aparece cuando el titular tiene `aeat_environment = test` y existe instalación activa. El RPC también exige este entorno y el mismo dispositivo lógico: otro navegador/iPad puede simular la misma caja iniciando sesión con esa asignación. La acción conserva el número, la cadena y los correlativos confirmados, sin retirar ni crear instalaciones. No permite recuperar registros que solo existan en otro dispositivo; nunca deben operar ambos a la vez.

Antes del lanzamiento hay que retirar este botón, la opción `recoverForTesting` y la rama `p_recover_for_testing` del RPC mediante una migración posterior. Cambiar a entorno AEAT de producción ya bloquea su uso desde el servidor.

## Migraciones de Staging

Aplicar las migraciones anteriores en orden y después `20261002191101_pwa_fiscal_installation_identity.sql`. Es una expansión: añade metadatos, códigos lógicos, solicitudes idempotentes y rutinas nuevas, y adapta las validaciones instaladas de venta, restaurante, anulación y rectificativa conservando sus firmas. Los clientes antiguos pueden sincronizar instalaciones versión 1; una instalación versión 2 exige el cliente actualizado.

La adaptación histórica de desarrollo `20260930120000_rewrite_historical_fiscal_test_data.sql` crea las instalaciones importadas con versión 2, número `LOC-CA-1` y series `LOC-CA-1-AAAA-T/N`. Reserva los códigos de todas las cajas por local: primero las activas desde C1 (también si no tienen tickets) y después las archivadas. Las instalaciones ya existentes conservan su versión e identidad. Su reconstrucción total sigue siendo exclusivamente de pruebas, con las autorizaciones ya existentes. La expansión nueva no invoca esa reconstrucción ni reescribe facturas emitidas.

El interruptor AEAT del CRM guarda inmediatamente el entorno si la configuración ya existe. El popup consulta el valor confirmado por Supabase, se actualiza al volver a la pestaña y cada 15 segundos mientras falta identidad; una copia offline no habilita la recuperación de pruebas. Para ensayar una modificación de la reconstrucción ya aplicada, restaurar el dump local y aplicar de nuevo las migraciones, cerrando las pestañas y eliminando los datos locales del ensayo anterior.

Se han revisado `docs/safe-production-migrations.md` y `supabase/contracts-pending.yml`. No se consume ningún contract ajeno a este cambio ni se elimina estructura legacy. No aplicar una reconstrucción de datos fiscales reales para adaptar formatos.
