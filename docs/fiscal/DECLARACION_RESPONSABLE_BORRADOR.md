# Declaración responsable — BORRADOR, no publicable

**No constituye una declaración responsable emitida ni una homologación de la AEAT. No acredita conformidad del producto.** Fecha de revisión del borrador: 28/09/2026.

## Identificación pendiente de completar

Productor: **[razón social, NIF, domicilio y representante por completar]**. Producto: Tickit POS PWA, versión **[release y hash de build por fijar]**. Componente A: React 19/Vite 8/TypeScript, instalado como PWA en cada caja; introduce y muestra datos, debe emitir la factura y su registro, calcular huella/QR, conservar la cola y remitir al puente. Componente B: puente fiscal VPS, **no desarrollado**; recibirá registros originales, los conservará y remitirá por SOAP/XML a AEAT. Supabase Cloud gestiona tenant, usuarios y configuración; las tablas preparatorias se crean por migración `20260928120000_prepare_local_verifactu_scope.sql`.

Modalidad prevista: exclusivamente **VERI*FACTU** para el nuevo componente. `disabled` es el estado inicial. `test` se reserva a datos ficticios. `production` existe en el POS para las ventas F1/F2 compatibles, pero su activación real queda pendiente del puente, pruebas AEAT, revisión fiscal y esta declaración final. La integración antigua con Verifacti/TicketBAI no forma parte del nuevo componente; debe desactivarse para los titulares/cajas migrados, sin alterar facturas anteriores.

## Alcance y responsabilidades por verificar

- La PWA emite altas F1/F2 compatibles en las ventas rápidas y de restaurante, congela instantánea, serie/número, registro, huella y QR, coordina pestañas y exige concesión exclusiva de instalación. El validador local cubre un subconjunto; faltan validación XSD completa en navegador, rectificativas, sustitución, subsanación y recuperación automática tras fallo entre la transacción del restaurante en PostgreSQL y el guardado del iPad.
- El VPS deberá comprobar autorización y cadena, almacenar cada registro sin alteración antes del acuse, construir solo el transporte XML/SOAP, autenticar ante AEAT, procesar respuestas por registro, reintentar, conciliar y alertar. Actualmente **no existe**.
- La decisión sobre un único producto con componentes A+B y una declaración común, o componentes con ciclo de versiones y declaraciones separadas, depende del productor final y de la arquitectura y responsabilidades contractuales reales. Debe resolverse según la FAQ AEAT «Arquitecturas de los SIF» antes de firmar.

La declaración final debe incluir la identificación completa del productor, denominación y versión del sistema y componentes, características funcionales verificadas, compromiso expreso exigido por RD 1007/2023 y Orden HAC/1177/2024, fecha, lugar y firma, siguiendo el modelo oficial vigente. Se requiere revisión jurídica/fiscal y ensayos de interoperabilidad de extremos a extremo con AEAT. **No firmar, distribuir ni exhibir este borrador como prueba de conformidad.**
