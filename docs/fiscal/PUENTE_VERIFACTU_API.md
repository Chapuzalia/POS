# Contrato propuesto Tickit PWA ↔ puente VERI*FACTU, v1

**Estado: cliente POS implementado, servicio VPS no desplegado.** Las ventas compatibles invocan el cliente HTTPS en modo `production` y quedan `LOCAL_PENDING` si falla el envío después de emitir con una concesión exclusiva válida. No hay acuses reales del VPS ni respuestas AEAT verificadas. El contrato requiere pruebas de interoperabilidad antes de activar ventas reales.

## Fuentes consultadas el 28/09/2026

- [RD 1007/2023, texto consolidado actualizado el 03/12/2025](https://www.boe.es/buscar/act.php?id=BOE-A-2023-24840).
- [Orden HAC/1177/2024](https://www.boe.es/buscar/act.php?id=BOE-A-2024-22138).
- [Índice técnico AEAT](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/informacion-tecnica.html): diseño de registros, XSD, validaciones y remisión deben fijarse por versión al implementar el conversor XML.
- [XSD oficiales `SuministroLR.xsd` y `SuministroInformacion.xsd`, ruta `tikeV1.0`](https://www.agenciatributaria.es/AEAT.desarrolladores/Desarrolladores/_menu_/Documentacion/Sistemas_Informaticos_de_Facturacion_y_Sistemas_VERI_FACTU/Esquemas_de_los_servicios_web/Esquemas_de_los_servicios_web.html), consultados el 28/09/2026. El validador local actual implementa solo el subconjunto declarado en `ESTADO_Y_OPERACION.md`; no es un validador XSD completo.
- [Huella AEAT v0.1.2, 27/08/2024](https://www.agenciatributaria.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/Veri-Factu_especificaciones_huella_hash_registros.pdf) y [QR AEAT v0.5.0, 10/12/2025](https://www.agenciatributaria.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/DetalleEspecificacTecnCodigoQRfactura.pdf).
- [FAQ desarrolladores AEAT, 04/12/2025, «Arquitecturas de los SIF»](https://sede.agenciatributaria.gob.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/FAQs-Desarrolladores.pdf): la factura, el registro y el QR deben nacer juntos; el componente posterior no puede reprocesar el registro.
- [Odoo 19.0, `verifactu_document.py`](https://github.com/odoo/odoo/blob/19.0/addons/l10n_es_edi_verifactu/models/verifactu_document.py) y [módulo POS](https://github.com/odoo/odoo/tree/19.0/addons/l10n_es_edi_verifactu_pos), solo referencia comparativa. Se ha comprobado en particular su distinción entre alta y anulación, cadena que incluye rechazados y cola; el contrato se rige por AEAT.

## Límites y propiedad de datos

Un **SIF independiente** sería una caja física que expide facturas con una instalación inmutable, para un titular fiscal/NIF. La cadena incorpora altas y anulaciones por orden de generación, sin reinicio por sesión, serie ni año. Una caja tiene series exclusivas por tipo documental y ejercicio, pero una sola cadena para ese titular. Una misma instalación no puede operar en dos iPads: el puente debe verificar una concesión exclusiva entre dispositivos. El bloqueo de pestañas con Web Locks no basta. Mientras no exista una garantía verificable, la emisión offline entre dispositivos queda bloqueada.

El JSON `canonicalRecord` **debe** ser una representación 1:1 del elemento oficial `RegistroAlta` o `RegistroAnulacion` del XSD AEAT fijado. No se admiten campos fiscales faltantes que el puente complete después. Antes de expedir, la PWA debe validar el registro con un conversor y validador local, versionados y disponibles offline, que reproduzcan el XSD y reglas de AEAT. `canonical.ts` convierte sin pérdida un **subconjunto restringido** F1/F2/anulación a XML en orden XSD y lo valida estructuralmente; **no reproduce aún todas las reglas/XSD oficiales**. `aeat-registro-v1` no debe usarse para facturas reales. El puente solo puede construir cabecera SOAP, agrupación, certificado y metadatos de transporte como `RefRequerimiento` o incidencia de remisión cuando proceda. No cambia registro, hash, referencia anterior, factura ni URL QR.

El registro fiscal inmutable y la instantánea de factura deben quedar persistidos en la PWA antes de imprimir. El puente almacena los mismos bytes o una representación semánticamente idéntica verificada por digest de contenido; se requiere definir serialización canónica y digest independiente del hash AEAT. La huella AEAT no es un digest del JSON. La respuesta del puente vive en metadatos separados. Una respuesta rechazada nunca borra ni reescribe un registro encadenado.

## Transporte y autorización

Base HTTPS configurada por el owner en el CRM y leída por tenant bajo RLS; TLS válido. `Authorization: Bearer <access token temporal del dispositivo>`; el VPS valida firma, expiración, revocación, tenant, titular fiscal, local, caja e instalación en cada petición. Se requiere atar el token a una concesión exclusiva de instalación y proteger contra reproducción. No se almacena certificado AEAT, clave privada ni secreto permanente de VPS en la PWA. CORS limitado al origen del POS. El puente no confía en los IDs enviados sin cotejarlos con su autorización y nunca permite leer registros de otro tenant o titular.

`POST /v1/installations/{installationId}/lease` recibe `{"contract":"tickit-verifactu-bridge","version":1,"deviceId":"..."}` y devuelve `{"contract":"tickit-verifactu-bridge","version":1,"leaseId":"...","installationId":"...","deviceId":"...","fencingToken":7,"expiresAt":"2026-09-28T15:00:00Z","serverUtcAt":"2026-09-28T14:00:00Z"}`. El VPS debe concederlo de forma serializable a una sola identidad física, aumentar el token de cercado al transferir la instalación y conservar historial. El POS comprueba identidad, vencimiento y reloj contra tiempo monotónico; tras reiniciar la PWA sin referencia monotónica, exige renovación online antes de emitir. Una concesión revocada que aún pueda utilizarse offline exige esperar su vencimiento antes de transferir la caja. **Este endpoint y su garantía remota aún no existen**; la comprobación local no sustituye la exclusión entre iPads.

`POST /v1/records`: lote de 1 a 100, solo de **una** instalación/titular, en `chainPosition` ascendente, sin huecos frente al último registro conocido por el VPS. Un lote es una unidad de transporte, con resultado individual por registro. La PWA conserva orden y reintenta el mismo `idempotencyKey`. El puente serializa envíos por cadena, pero puede ejecutar cadenas distintas en paralelo. Debe respetar el tiempo de espera variable y límites de AEAT y comunicar `retryAfterSeconds` cuando corresponda; la PWA no debe acumular voluntariamente toda una jornada para enviar al cierre. Timeout HTTP recomendado: 20 s para recepción durable; la espera AEAT ocurre de forma asíncrona.

### Petición completa

```json
{
  "contract": "tickit-verifactu-bridge",
  "version": 1,
  "records": [{
    "idempotencyKey": "2b1ed94d-03ec-4cc5-a07d-7cfac246302b",
    "environment": "test",
    "tenantId": "00000000-0000-4000-8000-000000000001",
    "fiscalSubjectId": "00000000-0000-4000-8000-000000000002",
    "issuerNif": "89890001K",
    "venueId": "00000000-0000-4000-8000-000000000003",
    "cashRegisterId": "00000000-0000-4000-8000-000000000004",
    "deviceId": "00000000-0000-4000-8000-000000000005",
    "installationId": "00000000-0000-4000-8000-000000000006",
    "invoiceId": "00000000-0000-4000-8000-000000000007",
    "invoice": {"issuerName":"Emisor ficticio","issuerNif":"89890001K","issuerAddress":"Calle Ficticia 1","series":"L1-C1-I1-2024-F","number":1,"issuedAt":"2024-01-01T19:20:30+01:00","qrUrl":"https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=L1-C1-I1-2024-F%2F1&fecha=01-01-2024&importe=12.10","ticketId":"00000000-0000-4000-8000-000000000008","saleId":"00000000-0000-4000-8000-000000000009","paymentId":"00000000-0000-4000-8000-00000000000a","lines":[{"description":"Servicio ficticio","grossCents":1210,"discountCents":0,"baseCents":1000,"taxCents":210,"taxRate":"21.00"}],"recipient":{"name":"Cliente ficticio","nif":"89890002E"},"totalCents":1210,"taxCents":210},
    "lease": {"leaseId":"concesion-ficticia","fencingToken":7},
    "chainPosition": 1,
    "previous": null,
    "hash": "3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60",
    "generatedAt": "2024-01-01T19:20:30+01:00",
    "canonicalSchema": "aeat-registro-v1",
    "canonicalRecord": {"RegistroAlta": {"IDVersion": "1.0", "IDFactura": {"IDEmisorFactura": "89890001K", "NumSerieFactura": "L1-C1-I1-2024-F/1", "FechaExpedicionFactura": "01-01-2024"}, "TipoFactura": "F1", "CuotaTotal": "2.10", "ImporteTotal": "12.10", "Encadenamiento": {"PrimerRegistro": "S"}, "FechaHoraHusoGenRegistro": "2024-01-01T19:20:30+01:00", "Huella": "3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60"}}
  }]
}
```

El objeto `canonicalRecord` de ejemplo **es deliberadamente parcial y ficticio**; no es una plantilla válida para emitir. El diseño completo debe incluir emisor, destinatario cuando proceda, tipo y referencias de rectificación o sustitución, desglose fiscal, importe, `SistemaInformatico`, encadenamiento, tipo de huella y todos los campos oficiales exigidos. `invoice` es una instantánea inmutable: el VPS verifica que emisor, serie/número, fecha, destinatario, totales y URL QR concuerdan con el registro antes de almacenarlo; conserva las líneas y el vínculo técnico con ticket/venta/cobro, aunque el XML no transmita cada línea. Ni el VPS ni una respuesta AEAT pueden completar o modificar esta instantánea. El mismo `invoiceId` interno no sustituye serie y número fiscales.

Para una **anulación** se envía otro `idempotencyKey`, `chainPosition` siguiente y `canonicalRecord.RegistroAnulacion`, con `previous` apuntando al registro inmediatamente anterior de la cadena. Para una devolución comercial o corrección se determina primero el tratamiento fiscal; no se infiere anulación. Una factura completa que sustituye a una simplificada debe referenciar expresamente la simplificada y el libro contable no puede duplicar la venta. No se admiten sustituciones de varias simplificadas en una sola completa hasta resolver cada antecedente.

### Respuesta individual y consulta

`POST /v1/records` devuelve HTTP 200/207 con `{"contract":"tickit-verifactu-bridge","version":1,"results":[...]}`. Cada elemento:

```json
{"idempotencyKey":"2b1ed94d-03ec-4cc5-a07d-7cfac246302b","state":"VPS_STORED","code":null,"description":null,"csv":null,"responseRef":null,"vpsStoredAt":"2024-01-01T18:20:33Z","aeatRespondedAt":null,"retryAfterSeconds":60}
```

`GET /v1/records/{idempotencyKey}` devuelve el mismo objeto con el estado más reciente, o HTTP 404 **solo cuando el VPS no posee esa clave**. La PWA reenvía después de 404; ante 401/403, 409, 429, 5xx, timeout o una respuesta mal formada conserva `LOCAL_PENDING` y señala el problema, sin inferir ausencia del registro. `GET /v1/records/{idempotencyKey}/responses` devuelve `{ "idempotencyKey": "...", "events": [{"at":"...","state":"AEAT_ACCEPTED_WITH_ERRORS","code":"...","description":"...","csv":"...","responseRef":"..."}] }`; puede incluir respuesta AEAT saneada y referencia a la respuesta íntegra recuperable con autorización. Ambas consultas exigen el mismo alcance del dispositivo. Todo error del lote se devuelve por registro; si ni siquiera se almacenó, HTTP 4xx/5xx sin `VPS_STORED` y la PWA mantiene `LOCAL_PENDING`.

Estados: `LOCAL_PENDING` (solo iPad), `VPS_STORED` (acuse tras commit durable en VPS, AEAT pendiente), `AEAT_ACCEPTED`, `AEAT_ACCEPTED_WITH_ERRORS`, `AEAT_REJECTED`, `REQUIRES_ACTION` (intervención fiscal/técnica necesaria). `REQUIRES_ACTION` no borra el último estado AEAT, que debe conservarse en eventos. Los códigos, descripciones y CSV son **por registro**, no solo por lote. El VPS debe conservar el original, respuesta íntegra, histórico de estados y auditoría; emitir alertas por antigüedad, rechazo, hueco de cadena y diferencias de conciliación.

Toda respuesta de `environment: "test"` debe mostrarse como **prueba** y jamás como aceptación de una factura real. El cliente impide mezclar un registro `production` con una conexión en modo `test`; la procedencia de datos ficticios también deberá garantizarla el flujo de alta de pruebas antes de conectarlo.

Idempotencia: clave única por registro; misma clave y contenido idéntico devuelve el estado existente; misma clave con contenido distinto → HTTP 409 y alarma. Un timeout de `POST` deja resultado desconocido: consultar `GET`, luego reintentar la misma clave y bytes. Si AEAT informa duplicado, inspeccionar identidad, huella y estado que devuelve AEAT antes de clasificarlo; nunca asumir éxito o fracaso por el código de duplicado aislado. Los rechazos se corrigen con el procedimiento fiscal aplicable y un registro **nuevo**, sin reescribir ni sacar el original de la cadena.

Ejemplos ficticios de resultado: alta `VPS_STORED → AEAT_ACCEPTED`; anulación `VPS_STORED → AEAT_ACCEPTED`; respuesta perdida `POST timeout → GET VPS_STORED`; duplicado AEAT `REQUIRES_ACTION` hasta conciliar identidad; aceptación con errores `AEAT_ACCEPTED_WITH_ERRORS` con código, descripción y CSV. Ninguna de esas secuencias es una simulación ejecutada por el POS.

```sh
curl -X POST 'https://puente.example.invalid/v1/records' -H 'Authorization: Bearer TOKEN_TEMPORAL' -H 'Content-Type: application/json' --data-binary @lote-ficticio.json
curl 'https://puente.example.invalid/v1/records/2b1ed94d-03ec-4cc5-a07d-7cfac246302b' -H 'Authorization: Bearer TOKEN_TEMPORAL'
curl 'https://puente.example.invalid/v1/records/2b1ed94d-03ec-4cc5-a07d-7cfac246302b/responses' -H 'Authorization: Bearer TOKEN_TEMPORAL'
```

Cambios incompatibles requieren `/v2` y nueva `canonicalSchema`. El VPS debe aceptar v1 durante una ventana N-1 de PWA instaladas. Ninguna actualización puede reinterpretar registros ya emitidos; el conversor usado se conserva por versión. Se fijarán versiones exactas de XSD, diseño y validaciones antes de crear `aeat-registro-v1` real.

## Endpoints que consume el POS

| Método | Ruta | Finalidad |
| --- | --- | --- |
| `POST` | `/v1/installations/{installationId}/lease` | Concesión exclusiva de la instalación, `fencingToken` y referencia horaria del VPS. |
| `POST` | `/v1/records` | Recepción durable e idempotente de un lote ordenado de 1 a 100 altas o anulaciones. |
| `GET` | `/v1/records/{idempotencyKey}` | Consulta del estado vigente tras timeout, reintento o sincronización diferida. |
| `GET` | `/v1/records/{idempotencyKey}/responses` | Histórico saneado de respuestas VPS/AEAT del registro. |

Todas las rutas usan `Authorization: Bearer <token temporal del dispositivo>`, `Content-Type: application/json` cuando hay cuerpo y el contrato `tickit-verifactu-bridge` versión `1`. El POS no consume ningún endpoint de Verifacti, TicketBAI ni Odoo.

## Trabajo pendiente en el VPS

Certificados cualificados o representación autorizada; SOAP/XML oficial y cabeceras; separación de pruebas/producción por NIF; validación oficial de cada registro; flujo, tamaño de lote y espera variable de AEAT; reintentos propios para registros que ya estén en VPS aunque la PWA cierre; respuesta individual, duplicados y CSV; alertas, conciliación, retención y recuperación; instalación exclusiva y revocación; auditoría, seguridad y declaración responsable de la arquitectura completa.
