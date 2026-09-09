# Arquitectura del sistema de escaneo y aprendizaje de facturas

## 1. Objetivo

Este documento define la arquitectura objetivo del sistema de escaneo de facturas/albaranes del POS.

El objetivo no es únicamente extraer datos de una factura, sino construir un sistema progresivamente más fiable que:

- Use OCR como fuente primaria de evidencia.
- Evite llamar a GPT cuando ya existe conocimiento determinista suficiente.
- Permita al usuario intervenir cuando el proveedor no pueda resolverse.
- Reutilice parsers existentes cuando corresponda.
- Aprenda de correcciones reales del usuario sin contaminar conocimiento válido.
- Distinga entre errores de OCR, errores de parser, nuevos layouts y errores humanos.
- Nunca modifique directamente un parser válido por una única factura.
- Valide cualquier parser nuevo o corregido contra documentos históricos antes de activarlo.
- Permita múltiples layouts válidos para un mismo proveedor.
- Mantenga separado el conocimiento local de un tenant del conocimiento global.

La UX debe mantenerse sencilla:

> subir documento → identificar/seleccionar proveedor si hace falta → extraer → revisar → corregir → confirmar

Toda la complejidad de aprendizaje debe ocurrir por debajo.

---

# 2. Principios fundamentales

## 2.1. OCR es evidencia, no verdad absoluta

El OCR representa lo que el sistema ha sido capaz de leer del documento.

Puede contener:

- texto correcto;
- texto parcial;
- errores de caracteres;
- columnas desalineadas;
- valores ausentes.

Por tanto, antes de corregir un parser debe determinarse si el problema realmente pertenece al parser o al OCR.

Ejemplo:

Documento real:

    FECHA EMISIÓN: 09/09/2026

OCR correcto:

    FECHA EMISIÓN: 09/09/2026

Parser devuelve fecha vacía.

Esto es potencialmente un problema del parser.

Pero si el OCR devuelve:

    FECHA EMISIÓN: 09/09/202G

y el usuario introduce manualmente `09/09/2026`, el sistema no debe intentar enseñar al parser a encontrar un valor que el OCR nunca proporcionó correctamente.

---

## 2.2. Selección manual de proveedor es una hipótesis de routing

Cuando el usuario selecciona un proveedor porque el sistema no ha podido identificarlo, esa acción significa:

> “Intenta procesar esta factura utilizando el conocimiento de este proveedor.”

No significa:

> “Esta factura demuestra que el proveedor es este.”

La selección manual debe tratarse como algo equivalente a:

    supplier_source = manual_hint

Nunca debe utilizarse por sí sola como evidencia suficiente para:

- aprender identidad fiscal;
- modificar conocimiento global;
- reemplazar parsers globales;
- crear asociaciones contradictorias con CIF/NIF;
- publicar automáticamente conocimiento compartido.

---

## 2.3. Un parser activo nunca se modifica directamente

Los parsers deben tratarse como versiones inmutables.

Si existe:

    parser A (ACTIVE)

y aparece una posible mejora, debe generarse:

    parser A.1 (CANDIDATE)

El parser A permanece intacto mientras A.1 se valida.

Esto evita que una factura excepcional, una mala selección de proveedor o una mala propuesta de GPT rompa documentos que ya funcionaban.

---

## 2.4. Un proveedor puede tener múltiples parsers válidos

No debe asumirse una relación:

    1 proveedor = 1 parser

Un mismo proveedor puede:

- cambiar de ERP;
- modificar el diseño;
- tener diferentes centros;
- emitir factura y albarán con formatos distintos;
- mantener layouts antiguos y nuevos simultáneamente.

Por tanto:

    proveedor
      ├── parser layout A
      ├── parser layout B
      └── parser layout C

Los parsers deben seleccionarse según fingerprint/layout y no únicamente según proveedor.

---

## 2.5. Los candidates no procesan producción

Estados conceptuales:

    CANDIDATE
    ACTIVE / VERIFIED
    REJECTED
    DEPRECATED

Solo los parsers `ACTIVE/VERIFIED` pueden participar automáticamente en el procesamiento normal.

`CANDIDATE` significa:

> hipótesis pendiente de validación.

No significa:

> parser probablemente correcto que podemos probar silenciosamente sobre documentos reales.

Los candidates pueden utilizarse en:

- regresión;
- validación;
- comparación;
- procesos internos de aprendizaje.

---

# 3. Flujo principal de procesamiento

## Paso 1 — Archivo

El usuario sube una factura o albarán.

Se almacena el documento y comienza el OCR.

---

## Paso 2 — OCR

El resultado OCR debe conservarse como snapshot.

Esto es fundamental porque el aprendizaje posterior debe poder reproducirse usando exactamente la evidencia que existía cuando se procesó el documento.

Conceptualmente:

    supplier_document
      └── ocr_snapshot

---

## Paso 3 — Evaluación básica de OCR

Antes de tomar decisiones importantes, el sistema puede determinar si el OCR parece suficientemente utilizable.

Ejemplos de señales:

- cantidad de texto;
- presencia de números;
- posibles importes;
- estructura de tabla;
- calidad de lectura;
- campos fiscales.

Un OCR claramente insuficiente no debe provocar reparaciones de parser.

---

## Paso 4 — Resolución del proveedor

El sistema debe intentar identificar al emisor antes de GPT.

Las señales pueden incluir:

### Evidencia muy fuerte

- CIF/NIF/VAT exacto.

### Evidencia fuerte combinada

- email + nombre;
- teléfono + nombre;
- dirección + nombre;
- dominio de email + razón social;
- aliases previamente confirmados.

### Evidencia débil

- nombre comercial aislado;
- coincidencia textual parcial.

La resolución automática debe producir una confianza y evidencia asociada.

Ejemplo conceptual:

    supplier_resolution:
      supplier_id
      confidence
      source
      evidence[]

---

## Paso 5 — Si proveedor no resuelto, intervención del usuario

Si no existe suficiente confianza, el flujo debe pausarse antes de GPT.

El usuario selecciona el proveedor.

Esa selección se guarda como `manual_hint`.

Después se puede continuar procesando sin convertir esa selección en evidencia de identidad global.

---

# 4. Selección de parser

Cuando existe un proveedor resuelto o seleccionado:

1. Obtener sus parsers `ACTIVE/VERIFIED`.
2. Evaluar fingerprints/layouts.
3. Ejecutar los candidatos compatibles.
4. Validar los resultados.
5. Elegir el mejor resultado válido.

Los parsers `CANDIDATE` no participan.

---

# 5. Diagnóstico estructurado del parser

Actualmente un fallo de parser no debe convertirse simplemente en “no funcionó”.

Cada intento debe poder producir un diagnóstico estructurado.

Ejemplo:

    profileId: ...
    fingerprintMatched: true
    layoutScore: 0.94
    requiredTextsMatched: 4/4
    tableFound: true
    headersMatched: 5/6
    missingRequiredHeader: unitPrice
    parsedLines: 0
    mathValid: false
    failureType: MISSING_REQUIRED_COLUMN

Posibles categorías principales:

### PARSER_APPLIES_BUT_FAILED

El fingerprint/layout indica que probablemente es la misma plantilla, pero una regla concreta ha dejado de funcionar.

Ejemplos:

- cambió un header;
- cambió la etiqueta de fecha;
- apareció una columna opcional;
- pequeña variación de formato.

Este caso puede generar una reparación.

### LAYOUT_INCOMPATIBLE

El parser pertenece al proveedor, pero el documento parece otro layout.

Este caso debe generar, si es necesario, un parser adicional, no una “reparación” del anterior.

### OCR_INSUFFICIENT

No existe evidencia suficiente para concluir que el parser esté mal.

Este caso no debe alimentar aprendizaje de parser.

---

# 6. Fallback a GPT

GPT se utiliza cuando:

- no existe parser activo válido;
- ningún parser aplica;
- el parser aplica pero falla y se necesita análisis;
- se requiere extraer un layout todavía desconocido.

Debe evitarse llamar a GPT si un parser activo puede resolver correctamente la factura.

---

# 7. Reparación de parser con GPT

Cuando un parser parece aplicable pero falla, GPT no debe recibir simplemente el OCR con la instrucción “crea un parser”.

Debe recibir contexto completo:

- OCR;
- parser actual;
- diagnóstico estructurado;
- valores extraídos;
- valores corregidos/confirmados disponibles;
- campo o sección que ha fallado.

Objetivo:

> proponer el cambio mínimo necesario.

Ejemplo:

Parser actual:

    metadata.date.aliases = ["Fecha factura"]

Factura:

    Fecha emisión: 09/09/2026

Usuario confirma:

    09/09/2026

GPT puede proponer:

    metadata.date.aliases = [
      "Fecha factura",
      "Fecha emisión"
    ]

El resultado es un parser `CANDIDATE`, nunca una modificación directa del parser activo.

---

# 8. Reparaciones por campo

El parser debe concebirse como varias áreas lógicas.

Ejemplo:

    parser
      ├── identity/fingerprint
      ├── metadata
      │    ├── invoiceNumber
      │    ├── invoiceDate
      │    ├── dueDate
      │    └── totals
      └── lines
           ├── table detection
           ├── quantity
           ├── unit price
           ├── discounts
           └── line total

Si falla únicamente `invoiceDate`, no debe regenerarse el parser completo.

Debe intentarse modificar únicamente la regla relacionada con `invoiceDate`.

Esto reduce el riesgo de regresiones.

---

# 9. Correcciones del usuario

Al confirmar un documento debe compararse:

    extracción original

contra:

    versión finalmente confirmada

Ejemplo:

Original:

    invoiceDate = null
    invoiceNumber = "A-18392"
    total = 287.42

Confirmado:

    invoiceDate = "2026-09-08"
    invoiceNumber = "A-18392"
    total = 287.42

Diferencia:

    field = invoiceDate
    before = null
    after = 2026-09-08

Estas diferencias son la entrada del sistema de aprendizaje.

---

# 10. Correction Analyzer

Después de confirmar la factura, un componente lógico debe clasificar cada diferencia.

Categorías recomendadas:

    parser_metadata
    parser_lines
    ocr_failure
    supplier_identity
    product_mapping
    user_override
    unknown

GPT puede ayudar a interpretar casos complejos, pero no debe decidir libremente qué conocimiento global modificar.

El backend controla qué tipos de cambios están autorizados a modificar qué tipos de conocimiento.

---

# 11. Evidence check

Antes de convertir una corrección manual en aprendizaje debe existir evidencia suficiente.

## Metadata

Para una fecha, número o total:

- ¿el valor confirmado aparece en OCR?
- ¿está situado cerca de una etiqueta semánticamente compatible?
- ¿existen otros valores similares que puedan causar ambigüedad?
- ¿el nuevo patrón puede confundirse con vencimiento, entrega, subtotal, etc.?

Si no existe evidencia suficiente:

    guardar corrección en documento = sí
    aprender del cambio = no

---

## Líneas

Para cantidades, precios o descuentos:

- ¿aparece la descripción?
- ¿aparece la cantidad?
- ¿aparece el precio?
- ¿cuadra el cálculo?
- ¿la línea parece realmente un producto?
- ¿no se ha capturado un subtotal/impuesto/título?

---

## Proveedor

Una selección manual no es evidencia.

Para aprender identidad global debe existir evidencia independiente suficientemente fuerte.

---

# 12. Error OCR vs error parser

Este punto debe ser explícito.

Si el usuario corrige un dato y el dato correcto está presente en OCR:

    posible error de parser

Si el dato correcto no está presente porque OCR lo ha leído mal:

    error de OCR

No debe “repararse” el parser para compensar valores inexistentes o corruptos en OCR.

---

# 13. Nuevo layout vs parser roto

Cuando un parser falla, el sistema debe decidir:

### Caso A — Misma plantilla

Fingerprint/layout muy compatible.

Ejemplo:

- mismos textos principales;
- misma tabla;
- mismas columnas;
- cambió `Fecha factura` por `Fecha emisión`.

Resultado:

    repair candidate

### Caso B — Plantilla diferente

Fingerprint/layout claramente distinto.

Resultado:

    new parser candidate

El parser anterior permanece activo.

---

# 14. Aprendizaje de metadata

Campos especialmente adecuados para aprendizaje progresivo:

- fecha de factura;
- fecha de vencimiento;
- número de factura;
- número de albarán;
- total;
- base imponible;
- impuestos.

Las correcciones pequeñas pueden convertirse en patches candidatos muy limitados.

Ejemplo:

    añadir alias "Fecha emisión"

puede ser mucho más seguro que regenerar la lógica completa del documento.

---

# 15. Aprendizaje de líneas

Las correcciones de líneas son de mayor riesgo.

Ejemplos:

- cantidad incorrecta;
- precio unitario incorrecto;
- descuento no detectado;
- total de línea desplazado;
- columna nueva.

Cualquier reparación debe mantener coherencia matemática.

Ejemplo:

    cantidad × precio × descuento = importe

Las reglas nuevas deben evitar:

- capturar subtotales como productos;
- capturar impuestos;
- capturar encabezados;
- duplicar líneas;
- perder líneas históricamente válidas.

---

# 16. Mapping de productos separado del parser

El parser responde:

> ¿Qué datos aparecen en la factura?

El mapping responde:

> ¿A qué producto interno corresponde esta descripción?

Ejemplo OCR:

    COCA COLA Z 330X24

Producto interno:

    Coca-Cola Zero lata 33cl

Esta asociación no debe formar parte del parser del documento.

Debe aprenderse en una capa independiente de mapping de productos.

---

# 17. Conocimiento local vs global

Debe existir una separación conceptual fuerte.

## Conocimiento global

Compartible entre tenants y proveedores equivalentes.

Requiere identidad suficientemente verificada.

Idealmente basada en:

- CIF/VAT;
- identificadores fiscales;
- evidencia fuerte previamente confirmada.

## Conocimiento local

Puede utilizarse cuando:

- el usuario seleccionó manualmente proveedor;
- la identidad global no está suficientemente demostrada;
- existe una variante específica de un tenant.

Una selección manual puede permitir:

- reutilizar parsers existentes en modo lectura;
- confirmar la factura;
- crear hipótesis/candidates locales;
- aprender mappings locales.

Pero no debería por sí sola:

- modificar parsers globales;
- publicar identidad global;
- reemplazar conocimiento compartido.

---

# 18. Ciclo de vida de un candidate

Un parser nuevo o reparado comienza como:

    CANDIDATE

Después se ejecuta una regresión.

Posibles resultados:

### PASS

El candidate:

- resuelve la factura nueva;
- mantiene correctamente los históricos;
- conserva coherencia;
- no introduce capturas erróneas.

Resultado:

    ACTIVE / VERIFIED

### FAIL

Mejora el caso actual pero rompe documentos anteriores.

Resultado:

    REJECTED

### NEW_LAYOUT

No sustituye al parser anterior porque representa una plantilla distinta.

Resultado:

    ACTIVE como parser adicional

---

# 19. Regresión histórica

Un candidate debe ejecutarse sobre documentos históricos confirmados del proveedor.

Siempre debe incluir:

- el documento que originó el cambio;
- documentos históricos asociados al parser anterior;
- idealmente diferentes variantes temporales del mismo layout.

Comparar:

## Metadata

- fecha;
- número;
- total;
- impuestos;
- otros campos relevantes.

## Líneas

- número de líneas;
- descripción;
- cantidad;
- precio;
- descuentos;
- cargos;
- total por línea.

## Validaciones

- coherencia matemática;
- fingerprint/layout;
- ausencia de nuevas falsas líneas;
- ausencia de regresiones.

Una reparación pequeña de metadata puede tener criterios de promoción más simples que una reparación estructural de líneas.

---

# 20. Correcciones humanas incorrectas

El usuario tiene autoridad para corregir su documento, pero no automáticamente para alterar el conocimiento del sistema.

Ejemplo:

OCR:

    TOTAL 123,45

Extracción:

    123.45

Usuario introduce accidentalmente:

    132.45

La factura puede almacenar el valor confirmado por el usuario si así funciona la UX, pero el sistema no debe aprender esa modificación porque no está respaldada por OCR/evidencia.

Regla general:

    corrección válida para documento
    ≠
    evidencia válida para aprendizaje

---

# 21. Proveedor manual incorrecto

Ejemplo:

La factura es de Coca-Cola.

El usuario selecciona por error Pepsi.

Flujo esperado:

1. Se pueden probar los parsers activos de Pepsi en modo lectura.
2. Si fingerprints/layouts no corresponden, se rechazan.
3. No se modifica ningún parser de Pepsi.
4. GPT puede extraer los datos de la factura si es necesario.
5. La selección manual no crea evidencia global.
6. Cualquier candidate derivado debe quedar aislado/local hasta que la identidad pueda demostrarse independientemente.

Una mala selección humana nunca debe tener capacidad de degradar un parser global que ya funciona.

---

# 22. Flujo completo objetivo

    Archivo
      ↓
    OCR
      ↓
    Evaluar calidad
      ↓
    Resolver proveedor
      ├── suficiente confianza
      │       ↓
      │   proveedor resuelto
      │
      └── sin confianza
              ↓
         usuario selecciona
              ↓
          manual_hint
              ↓
    Parsers ACTIVE/VERIFIED del proveedor
      ↓
    Evaluar fingerprint/layout
      ↓
    ┌─────────────────────────────────┐
    │                                 │
    ▼                                 ▼
    Parser funciona              Parser no funciona
    │                                 │
    ▼                                 ▼
    Extracción                 Diagnóstico estructurado
                                      │
                        ┌─────────────┴─────────────┐
                        ▼                           ▼
                Parece mismo layout          Layout distinto
                        │                           │
                        ▼                           ▼
                GPT repair mínimo          GPT extracción /
                        │                   parser nuevo
                        ▼                           ▼
                    CANDIDATE                   CANDIDATE
                        │                           │
                        └─────────────┬─────────────┘
                                      ↓
                                   REVIEW
                                      ↓
                              Usuario corrige
                                      ↓
                                  CONFIRMA
                                      ↓
                             Correction Analyzer
                                      ↓
                       Evidence / clasificación
                                      ↓
                            proposals adicionales
                                      ↓
                             Regression histórica
                              ┌───────┴────────┐
                              ▼                ▼
                            PASS              FAIL
                              │                │
                              ▼                ▼
                         ACTIVE/VERIFIED    REJECTED

---

# 23. Qué debe evitarse

No implementar:

- actualización directa de parsers activos;
- aprendizaje global desde una simple selección manual;
- ejecución automática de candidates;
- regeneración completa del parser por un fallo pequeño;
- aprendizaje de parser cuando el error proviene del OCR;
- asociación de mapping de productos dentro del parser;
- sustitución automática de un parser cuando el documento puede representar otro layout;
- `catch {}` que oculten por qué un parser ha fallado;
- promover conocimiento porque una única factura “parece funcionar”;
- usar confirmación de factura como sinónimo de confirmación de identidad del proveedor.

---

# 24. Bloques de implementación previstos

## Bloque 1 — Routing de proveedor

- Pausar antes de GPT si no se identifica proveedor.
- Selección manual como `manual_hint`.
- Mejorar resolución por múltiples señales.
- Probar primero parsers activos.

## Bloque 2 — Estados de parsers

- Candidates fuera de producción.
- Parsers inmutables/versionados.
- Múltiples layouts por proveedor.

## Bloque 3 — Diagnóstico

- Eliminar fallos silenciosos.
- Diagnóstico estructurado.
- Clasificar parser roto, layout distinto u OCR insuficiente.

## Bloque 4 — Reparación GPT

- OCR + parser actual + diagnóstico + corrección.
- Cambio mínimo.
- Candidate nuevo.
- Nuevo parser si es nuevo layout.

## Bloque 5 — Aprendizaje desde correcciones

- Comparar original vs confirmado.
- Correction Analyzer.
- Evidence checks.
- Separar mappings y proveedor.

## Bloque 6 — Validación/promoción

- Regression histórica.
- PASS → active.
- FAIL → rejected.
- New layout → parser adicional.

## Bloque 7 — Tests

Los tests se abordarán de manera independiente una vez implementados los seis bloques anteriores.

---

# 25. Regla de diseño final

El objetivo del sistema no es que GPT “aprenda parsers”.

El objetivo es construir un pipeline determinista y supervisado donde:

1. OCR aporta evidencia.
2. El routing decide qué conocimiento probar.
3. Los parsers resuelven lo conocido.
4. GPT ayuda únicamente cuando falta conocimiento o hay que proponer una reparación.
5. El usuario corrige la realidad del documento.
6. El backend decide qué correcciones pueden convertirse en conocimiento.
7. Toda mejora entra como candidate.
8. La regresión decide si ese conocimiento puede activarse.

La regla más importante de toda la arquitectura es:

> **Una factura confirmada demuestra que los datos de esa factura son aceptables; no demuestra automáticamente que un parser, un proveedor o una regla global sean correctos.**

Ese principio debe mantenerse en cualquier futura ampliación del sistema.
