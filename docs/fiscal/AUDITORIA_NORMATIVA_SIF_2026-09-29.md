# Auditoría normativa del componente SIF local

**Fecha de contraste:** 29/09/2026. **Resultado:** el hash y el encadenamiento del subconjunto implementado son coherentes con la especificación oficial, pero el sistema completo todavía no debe declararse conforme ni activarse como SIF VERI*FACTU de producción sin el puente y los controles pendientes.

## Fuentes oficiales aplicadas

- [RD 1007/2023, texto consolidado](https://www.boe.es/buscar/act.php?id=BOE-A-2023-24840): artículos 8 a 17 y disposición final cuarta.
- [Orden HAC/1177/2024, texto consolidado](https://www.boe.es/buscar/act.php?id=BOE-A-2024-22138): huella, encadenamiento, fecha/hora, QR, firma, eventos, conservación y remisión.
- [Información técnica AEAT](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/informacion-tecnica.html), consultada el 29/09/2026: XSD 1.0, huella 0.1.2 y QR 0.5.0.
- [FAQ AEAT sobre huella](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/huella-hash.html), actualizada a 21/07/2026.
- [FAQ AEAT sobre QR y leyenda](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/posibilidad-remision-informacion-factura-parte-receptor.html), actualizada a 21/07/2026.
- [FAQ AEAT sobre firma](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/firma.html), actualizada a 21/07/2026.
- [FAQ para desarrolladores, versión 1.3 de 04/12/2025](https://sede.agenciatributaria.gob.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/FAQs-Desarrolladores.pdf), especialmente arquitecturas de SIF y TPV.

## Qué significa el hash

Todos los registros de facturación de alta y anulación deben llevar huella SHA-256 y encadenarse con el registro anterior. La huella se calcula sobre el subconjunto y orden exactos publicados por AEAT; no sobre el JSON o XML completo. La huella **no forma parte del QR tributario** y la normativa no exige imprimirla como texto en la factura. Tickit la conserva dentro del registro fiscal inmutable y el siguiente registro referencia esa huella.

`src/features/fiscal/local/verifactu.ts` usa los nombres, orden, formato, UTF-8, SHA-256 y hexadecimal en mayúsculas de la especificación 0.1.2. `tests/verifactu-hash.test.mjs` comprueba el primer alta, un alta encadenada y una anulación encadenada contra los vectores oficiales. El QR contiene únicamente NIF, serie/número, fecha e importe.

## Resultado por obligación

| Obligación | Estado comprobado en Tickit |
| --- | --- |
| Generar el registro simultáneamente o antes de expedir | Implementado en los cobros F1/F2 soportados; IndexedDB confirma factura, número, cadena, registro y cola antes de imprimir. |
| Numeración y cadena | Implementadas por titular e instalación; las series cambian por caja, tipo y ejercicio, mientras la cadena no se reinicia por serie, año o sesión. |
| Huella de alta y anulación | Implementada y contrastada con vectores AEAT 0.1.2. La anulación existe a nivel de dominio/almacenamiento, pero no está integrada como flujo completo de negocio. |
| Inalterabilidad | Los originales locales y de Supabase son append-only; respuestas y reintentos modifican metadatos de transporte, no el registro fiscal. |
| QR | Contenido oficial y nivel de corrección `M`. La plantilla segura lo coloca como primer contenido y una personalización fiscal incompleta cae a la plantilla segura. Falta certificar físicamente 30–40 mm y lectura real en cada combinación de impresora/papel 58 y 80 mm. |
| Leyenda `VERI*FACTU` | Solo se imprime cuando el registro está marcado para remisión mediante puente. No se imprime en el modo preparatorio solo local. |
| Remisión VERI*FACTU | **Pendiente.** Sin puente no hay remisión efectiva continuada, automática, consecutiva, instantánea y fehaciente a AEAT; por tanto no es todavía un SIF VERI*FACTU operativo. |
| Modalidad no VERI*FACTU | **No implementada.** Faltan firma XAdES de registros, registro de eventos, comprobación de huellas/firmas/cadena, alarmas y exportación reglamentaria. El modo `local-only` no debe presentarse como esta modalidad. |
| Registro completo y validación AEAT | El esquema canónico cubre únicamente altas F1/F2 nacionales, régimen 01, operación S1 e IVA 4/10/21. Falta validar el XML final contra XSD y reglas AEAT completas antes de expedir. |
| Rectificación, sustitución, devolución y anulación indebida | Clasificadas conceptualmente y bloqueadas donde no existe flujo seguro; faltan R1–R5, F3, subsanación y la integración completa de anulaciones. |
| Identidad del SIF y exclusión | Se fija titular, sistema, instalación, local, caja y dispositivo. Web Locks coordina pestañas. Sin puente, una identidad duplicada en dos dispositivos no queda coordinada de forma verificable. |
| Conservación y recuperación | Hay cola IndexedDB y copia inmutable en Supabase para ventas sincronizadas. Un registro que solo exista en el iPad puede perderse; la PWA cerrada no remite. |
| Declaración responsable | Existe únicamente un borrador. Faltan datos del productor, versión/release, arquitectura final, verificación integral, firma y exposición junto al producto. |

## Conclusión de activación

El flujo local genera una identidad fiscal, un registro y una huella correctos para el subconjunto soportado, pero **eso por sí solo no acredita legalidad del SIF**. Hay dos vías reglamentarias completas:

1. VERI*FACTU: terminar y activar el puente, remitir efectivamente todos los registros, probar el circuito completo con AEAT y conservar/conciliar sus respuestas.
2. No VERI*FACTU: implementar firma, eventos y todas las funciones adicionales de seguridad y exportación. Esta vía queda fuera del diseño elegido para Tickit.

Antes del plazo aplicable puede mantenerse un sistema anterior no adaptado durante el periodo de pruebas según las FAQ AEAT. Si se presenta Tickit como sistema adaptado o se activa la modalidad elegida, debe cumplirla entera. Los plazos vigentes son 01/01/2027 para contribuyentes del Impuesto sobre Sociedades y 01/07/2027 para el resto de obligados incluidos, salvo cambio normativo posterior.

## Bloqueos antes de producción

1. Puente VPS terminado, autenticado, con almacenamiento durable, XML/SOAP oficial, certificado/representación, estados individuales, reintentos, duplicados y conciliación.
2. Validación completa contra XSD y reglas vigentes de AEAT y pruebas en su entorno habilitado.
3. Flujos fiscales que necesita el negocio: anulaciones, rectificativas, devoluciones, F3 y subsanaciones.
4. Ensayo físico y escaneo del QR, acreditando posición, unicidad, nivel `M` y tamaño 30–40 mm en cada impresora soportada.
5. Prueba integral de todas las rutas de cobro, reimpresión, cierre, recuperación y sustitución de dispositivo.
6. Revisión fiscal/jurídica y declaración responsable final del producto y de su arquitectura de componentes.

