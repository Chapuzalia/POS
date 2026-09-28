# Componente fiscal local Tickit — operación y estado

**Revisión: 29/09/2026.** El POS encamina por defecto los cobros a la emisión local de altas VERI*FACTU F1/F2 para ventas compatibles. Si falta configuración o no puede asegurar numeración y cadena, bloquea el cobro fiscal. **El sistema completo aún no está listo para operar legalmente**: faltan el VPS, validación XML completa, pruebas externas con AEAT, revisión fiscal y declaración responsable. Nunca enviar ventas reales a pruebas.

## Cobertura del POS

- Venta rápida: crea número por caja/tipo/ejercicio, registro canónico, huella AEAT, QR, factura congelada, cadena y trabajo de envío en una transacción IndexedDB antes de imprimir. La venta económica queda en la misma base local y se sincroniza a Supabase mediante `sync_local_fiscal_sale_created`. El RPC antiguo queda bloqueado para cajas con instalación fiscal de producción.
- Restaurante: cierre completo, parte igual y selección de líneas pasan por `pay_restaurant_local_fiscal`. La RPC guarda cobro y registro en una transacción PostgreSQL, comprueba serie y cadena y devuelve los UUID económicos. La PWA confirma el guardado local antes de imprimir. Un cobro que requiere confirmar comandas pendientes no emite factura.
- Reimpresión: busca el registro local por ticket y reutiliza serie, número y QR. Una factura nueva sin registro local no se imprime. Ticket térmico y PDF reciben el mismo QR y número. Falta medir y escanear las impresiones físicas de 58/80 mm.
- La cola conserva el registro original. Fallos del puente dejan `LOCAL_PENDING`; el acuse durable del VPS da `VPS_STORED`. La pantalla distingue aceptación, aceptación con errores, rechazo y actuación requerida. Reintenta con la PWA abierta, al volver al primer plano y al recuperar conexión.
- SQL y UI impiden anular, borrar o alterar silenciosamente una factura expedida y su cobro. La cadena no se reinicia con otra sesión ni con un nuevo ejercicio.

## Cobertura fiscal y bloqueos

Solo se admiten altas F1 con destinatario nacional de NIF aceptado por el esquema y F2 sin destinatario, IVA ordinario sujeto/no exento al 4 %, 10 % o 21 %, y desglose histórico completo. La simplificada se limita conservadoramente a 400 € en venta rápida y 3.000 € en restaurante; superar el límite exige cliente y F1. IVA 0 %, exenciones, operaciones no sujetas, regímenes especiales, destinatarios extranjeros y datos incompletos bloquean la emisión. No se imprime un documento que parezca factura al fallar el guardado.

No están implementadas rectificativas R1–R5, sustitutivas F3, anulación fiscal por emisión indebida ni devolución fiscal total/parcial. Esos cambios sobre facturas expedidas quedan bloqueados. No se consolidan varias simplificadas en una completa. Exportaciones y cierre aún no concilian rectificaciones futuras; la barra fiscal muestra pendientes de la sesión. Cobrar en otra caja distinta de aquella a la que pertenece la comanda se rechaza si no coinciden los ámbitos económico y fiscal. **Estos son bloqueos para los casos afectados.**

La PWA valida la representación canónica con esquema local tipado y pruebas de conversión XML; conserva XSD oficiales v1.0 en `docs/fiscal/schemas/`. No ejecuta el XSD completo ni todas las reglas remotas de AEAT antes de cada venta. Un rechazo no altera la factura ni la cadena; falta el flujo de subsanación. Si PostgreSQL confirma un cobro de restaurante y luego falla IndexedDB, el POS intenta reconstruir la cola/cursores desde la copia inmutable del servidor antes del siguiente cobro y al abrir la caja. El cobro anterior puede requerir reimpresión y conciliación manual; no repetir el pago sin comprobar su resultado. La recuperación se ha probado en IndexedDB, no con un VPS/AEAT real.

## Alta y activación de caja

1. Aplicar en orden `20260928120000_prepare_local_verifactu_scope.sql`, `20260928130000_sync_local_verifactu_sale.sql`, `20260928140000_restaurant_local_verifactu_sale.sql`, `20260928150000_guard_issued_local_fiscal_sales.sql` y `20260928160000_fiscal_pos_bridge_settings.sql`, mediante el proceso de migración segura. Revisar `docs/safe-production-migrations.md` y contratos pendientes. No iniciar Supabase local.
2. Crear titular en `fiscal_subjects` e instalación **nueva** por caja en `fiscal_sif_installations`, con tenant, NIF, local, caja, dispositivo, `installation_number` y códigos exclusivos. Nunca reutilizar la identidad al sustituir iPad. `fiscal_integration_settings.enabled` es global al tenant: migrar **todas** sus cajas emisoras en un corte controlado antes de desactivarlo. Una caja sin instalación después de ese corte podría generar ventas sin el proveedor anterior ni el nuevo registro; no activar parcialmente el tenant.
3. En **CRM → Integraciones → SIF local de Tickit y puente VERI*FACTU**, el owner configura por tenant la URL HTTPS del VPS, razón social/NIF del productor, ID de sistema y versión. Son metadatos públicos y quedan congelados en cada factura; solo el owner puede modificarlos. El despliegue usa `production` por defecto (`VITE_VERIFACTU_MODE` permite `disabled` o `test` explícitos). El VPS debe autorizar titular/caja/dispositivo, emitir una concesión exclusiva con fencing token, persistir antes de `VPS_STORED` y procesar AEAT por registro. Certificados AEAT y secretos permanentes residen solo en servidor.
4. Ensayar extremo a extremo con datos ficticios en entorno aislado, incluidos hash, XML, respuesta por registro, QR impreso, red, duplicado y conciliación. Completar revisión fiscal y declaración responsable antes de ventas reales. `test` bloquea cobros reales; `disabled` conserva el flujo anterior.

## Incidencia, cierre y reemplazo

Si el VPS falla **después de obtener una concesión exclusiva válida**, la factura queda `LOCAL_PENDING`. Sin concesión válida, reloj comprobable, IndexedDB o exclusión entre pestañas, se bloquea la emisión para evitar duplicar número/cadena. La PWA cerrada no sincroniza; el VPS debe continuar reintentos de los registros que ya recibió. El cierre puede ocurrir con pendientes, pero exige registrar sus cantidades y antigüedad y asignar seguimiento; no usarlo como rutina de remisión diaria.

Antes de borrar datos, reinstalar o sustituir: detener cobros, abrir la PWA, llegar al menos a `VPS_STORED` en cada registro, comparar instalación/posición/hash/serie/número con el VPS y documentar la conciliación. Si el iPad se pierde antes del acuse durable, no hay copia recuperable garantizada de los registros solo locales. El usuario asumió ese riesgo offline, pero sigue siendo **bloqueo de activación cuando se requiera recuperación garantizada**.

## Especificaciones consultadas

RD 1007/2023 (texto consolidado), Orden HAC/1177/2024, información técnica AEAT consultada el 28/09/2026 y FAQ de desarrolladores sobre arquitecturas. Huella AEAT 0.1.2; QR 0.5.0; `SuministroInformacion.xsd` y `SuministroLR.xsd` 1.0. Las pruebas incluyen vectores oficiales de primer registro, alta encadenada y anulación. AEAT y la norma prevalecen sobre la referencia técnica Odoo 19.0.
