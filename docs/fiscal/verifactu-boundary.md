# Frontera fiscal Tickit / Odoo Veri*Factu

## 1. Objetivo

Este documento define la separación de responsabilidades entre **Tickit** y **Odoo 19** para la emisión de facturas y facturas simplificadas mediante Veri*Factu.

El objetivo de la arquitectura es que:

- **Tickit** siga siendo el sistema de gestión y TPV utilizado por el negocio.
- **Odoo** actúe como motor fiscal.
- La lógica específica y compleja de Veri*Factu se mantenga dentro de los módulos oficiales de Odoo.
- Tickit no implemente por su cuenta protocolos, algoritmos o formatos fiscales de AEAT.
- La integración entre ambos sistemas sea lo más pequeña y estable posible.

---

# 2. Arquitectura general

```text
┌────────────────────────────────────────────┐
│                  TICKIT                    │
│                                            │
│ TPV                                        │
│ productos                                  │
│ pedidos                                    │
│ mesas                                      │
│ usuarios                                   │
│ cobros                                     │
│ clientes                                   │
│ stock                                      │
│ impresión térmica                          │
│                                            │
└────────────────────┬───────────────────────┘
                     │
                     │ Venta a fiscalizar
                     │
                     ▼
┌────────────────────────────────────────────┐
│          tickit_odoo_bridge                │
│                                            │
│ Identificación de entidad fiscal           │
│ Idempotencia                               │
│ Mapeo de impuestos                         │
│ Creación de documentos en Odoo             │
│ Consulta del resultado fiscal              │
│                                            │
└────────────────────┬───────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────┐
│                  ODOO 19                   │
│                                            │
│ account                                    │
│ l10n_es                                    │
│ l10n_es_edi_verifactu                      │
│                                            │
│ Facturación                                │
│ Numeración fiscal                          │
│ Cálculo fiscal                             │
│ Veri*Factu                                 │
│ QR                                         │
│ Comunicación AEAT                          │
│                                            │
└────────────────────┬───────────────────────┘
                     │
                     ▼
                    AEAT
```

---

# 3. Principio fundamental

Tickit **no implementará Veri*Factu**.

Tickit enviará a Odoo la información comercial necesaria para expedir el documento fiscal.

A partir de ese momento, Odoo será responsable de transformar esa información en una factura o factura simplificada fiscalmente válida y generar los registros Veri*Factu correspondientes.

La regla general será:

```text
Tickit conoce la venta.

Odoo conoce la factura fiscal.

Odoo Veri*Factu conoce AEAT.
```

---

# 4. Responsabilidades de Tickit

Tickit será responsable de la gestión operativa del negocio.

Esto incluye:

- catálogo de productos;
- categorías;
- precios;
- modificadores;
- combos;
- mesas;
- comandas;
- usuarios;
- empleados;
- permisos;
- clientes;
- stock;
- turnos;
- caja;
- medios de pago;
- integración con Cashlogy;
- integración con terminales de pago;
- gestión del cobro;
- interfaz de usuario;
- almacenamiento de pedidos;
- impresión física del ticket;
- comunicación con Odoo;
- trazabilidad de la integración;
- idempotencia;
- recuperación ante errores de comunicación.

Tickit determinará que existe una venta que debe fiscalizarse y enviará sus datos a Odoo.

---

# 5. Datos que Tickit enviará a Odoo

Tickit enviará exclusivamente información comercial y contextual.

Como mínimo:

```text
external_id
entidad fiscal
fecha/hora de operación
tipo de documento solicitado

líneas:
    descripción
    cantidad
    precio
    descuento
    código de impuesto

total esperado

cliente fiscal
    sólo cuando corresponda
```

Ejemplo:

```json
{
  "external_id": "ticket_01J8Q...",
  "type": "simplified",
  "lines": [
    {
      "description": "Brugal + Coca-Cola",
      "quantity": 2,
      "unit_price": 8.00,
      "tax_code": "IVA10"
    },
    {
      "description": "Estrella Damm",
      "quantity": 1,
      "unit_price": 3.00,
      "tax_code": "IVA10"
    }
  ],
  "expected_total": 19.00
}
```

Tickit no enviará a AEAT este objeto directamente.

---

# 6. Responsabilidades de `tickit_odoo_bridge`

`tickit_odoo_bridge` será una capa de integración entre Tickit y los modelos estándar de Odoo.

Debe mantenerse deliberadamente pequeña.

Sus responsabilidades serán:

1. recibir una solicitud de fiscalización;
2. comprobar la idempotencia mediante `external_id`;
3. identificar la `res.company` correcta;
4. mapear los códigos de impuestos de Tickit a impuestos configurados en Odoo;
5. crear el documento correspondiente mediante modelos estándar de Odoo;
6. ejecutar el flujo estándar necesario para validar la factura;
7. activar el mecanismo Veri*Factu oficial de Odoo;
8. devolver a Tickit las referencias y resultados generados por Odoo.

---

# 7. Lo que `tickit_odoo_bridge` NO debe hacer

El bridge no debe implementar lógica propia de Veri*Factu.

Queda expresamente fuera de su responsabilidad:

```text
generar registros Veri*Factu
generar XML/SOAP de AEAT
calcular huellas
calcular hashes fiscales
gestionar el encadenamiento Veri*Factu
construir manualmente registros de alta
construir manualmente registros de anulación
generar identificadores fiscales AEAT
implementar protocolos de comunicación AEAT
interpretar directamente especificaciones SOAP de AEAT
implementar reintentos contra los webservices de AEAT
generar manualmente el contenido fiscal del QR
replicar validaciones fiscales internas de Odoo
```

Si alguna de estas operaciones fuera necesaria, deberá utilizarse la implementación oficial disponible en Odoo.

---

# 8. Responsabilidades de Odoo

Odoo será el responsable de la capa de facturación fiscal.

Odoo gestionará:

- empresas fiscales;
- NIF del obligado tributario;
- diarios;
- series y numeración fiscal;
- impuestos;
- facturas completas;
- facturas simplificadas;
- facturas rectificativas;
- devoluciones;
- anulaciones fiscales cuando correspondan;
- estados fiscales.

Los documentos fiscales se representarán principalmente mediante:

```text
account.move
account.move.line
account.tax
res.company
```

Tickit no necesitará utilizar el POS de Odoo.

---

# 9. Responsabilidades exclusivas de los módulos oficiales Veri*Factu de Odoo

Las siguientes responsabilidades deberán permanecer exclusivamente dentro de:

```text
l10n_es
l10n_es_edi_verifactu
```

y sus dependencias oficiales.

Incluyen:

## Generación del registro Veri*Factu

Odoo será responsable de convertir la factura en el registro requerido por Veri*Factu.

## Identificación del tipo de factura

Odoo determinará el tratamiento fiscal correspondiente, incluyendo:

```text
F1
F2
rectificativas
```

según los datos del documento.

## Huella y encadenamiento

Odoo será responsable de:

```text
generación de huella
encadenamiento con registros anteriores
secuencia de registros
integridad de la cadena
```

Tickit no calculará ni almacenará una cadena fiscal paralela.

## Comunicación con AEAT

Odoo será el único componente que se comunique directamente con los servicios Veri*Factu de AEAT.

```text
Tickit ❌ → AEAT

Odoo   ✅ → AEAT
```

## Certificados

Odoo gestionará el certificado utilizado para la comunicación con AEAT.

Tickit no enviará directamente peticiones firmadas a AEAT.

## Generación del QR fiscal

Los datos que forman el QR fiscal serán generados por Odoo a partir del documento Veri*Factu.

Tickit podrá utilizar dicho QR para imprimir el ticket, pero no deberá reconstruir por su cuenta su contenido fiscal.

## Estados de AEAT

Odoo será la fuente de verdad de estados como:

```text
pendiente
accepted
registered_with_errors
rejected
cancelled
```

Tickit podrá mantener una copia de estos estados para mostrar información al usuario.

---

# 10. Numeración fiscal

La numeración fiscal será gestionada por Odoo.

Tickit mantendrá su propio identificador interno de venta:

```text
ticket_01J8Q...
```

Odoo asignará el número fiscal correspondiente:

```text
FV/2026/001842
```

Por tanto:

```text
Tickit external_id
        │
        ▼
ticket_01J8Q...
        │
        │ 1:1
        ▼
Odoo invoice
FV/2026/001842
```

Tickit no reutilizará números fiscales ni intentará generar una segunda numeración fiscal paralela.

---

# 11. Cálculo de impuestos

Tickit puede realizar cálculos de impuestos con fines operativos y de presentación.

Sin embargo, antes de considerar fiscalizada una venta, deberá comparar sus importes con los calculados por Odoo.

Ejemplo:

```text
Tickit total esperado: 19,00 €
Odoo total:            19,00 €

OK
```

Si existe una discrepancia:

```text
Tickit total esperado: 19,00 €
Odoo total:            18,99 €

ERROR
```

la operación debe marcarse como incidencia y no tratarse silenciosamente como válida.

A efectos del documento fiscal, los valores generados por Odoo serán los valores de referencia.

---

# 12. Impresión del ticket

Tickit continuará siendo responsable de la impresión física en impresoras térmicas.

Odoo proporcionará como mínimo:

```text
número fiscal
tipo de factura
fecha fiscal
totales definitivos
QR Veri*Factu
estado fiscal
```

Tickit podrá utilizar estos valores para construir su formato térmico.

Ejemplo:

```text
          BAR PEPE

2 × Brugal + Coca-Cola     16,00 €
1 × Estrella Damm           3,00 €

--------------------------------
TOTAL                      19,00 €


Factura simplificada
FV/2026/001842


       [ QR VERI*FACTU ]


         VERI*FACTU
```

Tickit no modificará el contenido fiscal proporcionado por Odoo.

---

# 13. Identificación de la empresa fiscal

Cada venta deberá pertenecer a una única entidad fiscal.

La resolución se realizará dentro del backend de Tickit:

```text
ticket
  ↓
venue
  ↓
fiscal_entity
  ↓
odoo_company_id
  ↓
res.company
```

El frontend nunca podrá seleccionar directamente una `res.company` arbitraria.

La empresa fiscal deberá obtenerse siempre de información almacenada y validada en el backend.

---

# 14. Separación multiempresa

Cada NIF estará representado mediante su propia:

```text
res.company
```

Ejemplo:

```text
Odoo
│
├── res.company
│   Bar Pepe SL
│   B11111111
│
├── res.company
│   Restaurante Juan SL
│   B22222222
│
└── res.company
    Discoteca Tres SL
    B33333333
```

Los registros fiscales de diferentes empresas nunca deberán mezclarse.

Toda operación realizada desde el bridge deberá ejecutarse explícitamente en el contexto de la empresa correspondiente.

---

# 15. Idempotencia

Cada venta de Tickit tendrá un identificador global único.

Ejemplo:

```text
external_id =
01J8QQFTS3P4JX...
```

Antes de crear cualquier documento fiscal, Odoo deberá comprobar si dicho `external_id` ya ha sido procesado.

Debe cumplirse:

```text
1 venta Tickit
=
1 documento fiscal
```

Un timeout, doble clic o reintento de red nunca debe generar una segunda factura.

---

# 16. Modificación de documentos fiscalizados

Una vez generado un documento fiscal:

```text
NO modificar importe
NO modificar IVA
NO modificar líneas
NO eliminar documento
```

Las correcciones deberán realizarse mediante los mecanismos fiscales correspondientes proporcionados por Odoo:

```text
rectificación
devolución
anulación cuando corresponda
```

Tickit nunca modificará directamente un registro fiscal ya generado.

---

# 17. Errores y reintentos

Se distinguirán dos tipos principales de error.

## Error antes de generar el documento fiscal

Ejemplos:

```text
IVA desconocido
empresa mal configurada
total inconsistente
datos obligatorios ausentes
```

En estos casos no deberá considerarse fiscalizada la operación.

## Error de comunicación con AEAT

Si Odoo ya ha generado correctamente el registro pero AEAT no está temporalmente disponible, será Odoo quien mantenga y gestione el registro pendiente.

Tickit no realizará directamente reintentos contra AEAT.

---

# 18. Actualizaciones regulatorias

El código oficial de:

```text
l10n_es
l10n_es_edi_verifactu
```

no será modificado directamente por Tickit.

Queda prohibido mantener forks propios de la lógica Veri*Factu salvo decisión expresa y revisión previa.

Las actualizaciones regulatorias se incorporarán mediante actualizaciones oficiales de Odoo.

Antes de actualizar producción:

```text
actualización Odoo
       ↓
staging
       ↓
tests Veri*Factu
       ↓
validación
       ↓
producción
```

---

# 19. Declaración responsable de Tickit

Tickit dispondrá de su propia declaración responsable como componente/integrador del sistema.

La declaración deberá reflejar la arquitectura real.

En particular deberá quedar indicado que:

- Tickit gestiona la operativa del TPV.
- Tickit comunica las ventas a Odoo.
- Tickit controla la idempotencia y trazabilidad de la integración.
- Tickit puede componer e imprimir el documento térmico.
- Odoo gestiona la facturación fiscal.
- Los módulos oficiales de Odoo generan los registros Veri*Factu.
- Los módulos oficiales de Odoo gestionan huella y encadenamiento.
- Odoo genera los datos fiscales del QR.
- Odoo realiza la comunicación con AEAT.
- Tickit no implementa directamente el protocolo Veri*Factu de AEAT.

La declaración responsable definitiva deberá revisarse cuando la implementación esté terminada para asegurar que describe exactamente el comportamiento del sistema en producción.

---

# 20. Regla de desarrollo

Cualquier nueva funcionalidad fiscal deberá hacerse primero esta pregunta:

> ¿Esta lógica ya está implementada por Odoo o por `l10n_es_edi_verifactu`?

Si la respuesta es sí:

```text
usar Odoo
```

No:

```text
replicar la lógica en Tickit
```

Si para implementar una funcionalidad fuera necesario interpretar directamente documentación técnica de Veri*Factu de AEAT, deberá revisarse primero si estamos trasladando accidentalmente lógica fiscal desde Odoo hacia Tickit.

---

# 21. Resumen de responsabilidades

| Función | Tickit | Odoo |
|---|:---:|:---:|
| Productos | ✅ | ❌ |
| Mesas | ✅ | ❌ |
| Pedidos | ✅ | ❌ |
| Cobros | ✅ | ❌ |
| Stock | ✅ | ❌ |
| Usuarios | ✅ | ❌ |
| Entidad fiscal del local | ✅ | ✅ |
| Documento fiscal | ❌ | ✅ |
| Numeración fiscal | ❌ | ✅ |
| Cálculo fiscal definitivo | ❌ | ✅ |
| F1 / F2 | ❌ | ✅ |
| Rectificativas | Orquesta | ✅ |
| Registro Veri*Factu | ❌ | ✅ |
| Hash / huella | ❌ | ✅ |
| Encadenamiento | ❌ | ✅ |
| QR fiscal | Imprime | ✅ Genera |
| Comunicación AEAT | ❌ | ✅ |
| Reintentos AEAT | ❌ | ✅ |
| Respuestas AEAT | Consulta | ✅ |
| Impresión térmica | ✅ | ❌ |
| Idempotencia integración | ✅ | ✅ |
| Auditoría integración | ✅ | ✅ |

---

# 22. Regla final de arquitectura

La separación que debe mantenerse durante todo el proyecto es:

```text
Tickit
    │
    │ "esta venta debe convertirse en factura"
    ▼
Odoo
    │
    │ "esta es la factura fiscal"
    ▼
Veri*Factu
    │
    │ "este es el registro fiscal"
    ▼
AEAT
```

Tickit debe evitar convertirse en una segunda implementación de Veri*Factu.

**Odoo será el núcleo fiscal del sistema. Tickit será el TPV y la capa de integración alrededor de ese núcleo.**