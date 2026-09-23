# DECLARACIÓN RESPONSABLE DEL SISTEMA INFORMÁTICO DE FACTURACIÓN

En cumplimiento de lo dispuesto en el artículo 29.2.j) de la Ley 58/2003, de 17 de diciembre, General Tributaria; en el Real Decreto 1007/2023, de 5 de diciembre; y en la Orden HAC/1177/2024, de 17 de octubre, se emite la presente declaración responsable correspondiente al componente informático **Tickit**, integrado dentro de una arquitectura de Sistema Informático de Facturación en la que la generación, tratamiento y remisión de los registros de facturación conforme a Veri*Factu se realiza mediante **Odoo**.

### a) Nombre del sistema informático a que se refiere esta declaración responsable

**Tickit**

Componente software de punto de venta, gestión comercial e integración con el sistema de facturación Odoo.

### b) Código identificador del sistema informático

**TK**

Código identificador asignado por el productor al componente Tickit.

### c) Identificador completo de la versión concreta del sistema informático

**Versión Tickit:** [VERSIÓN / RELEASE]

**Componente externo de facturación:** Odoo [VERSIÓN ODOO]

La presente declaración es aplicable exclusivamente a la versión de Tickit indicada y a la arquitectura de integración aquí descrita.

Cualquier modificación sustancial que afecte al proceso de facturación, al intercambio de información con Odoo o a las funciones relacionadas con el cumplimiento del Reglamento dará lugar a la revisión de esta declaración y, cuando corresponda, a la emisión de una nueva versión.

### d) Componentes, hardware y software, descripción y principales funcionalidades

Tickit es una aplicación software orientada a la gestión de establecimientos de hostelería y restauración que proporciona, entre otras, funcionalidades de:

- registro de ventas y operaciones de punto de venta;
- gestión de productos, precios, impuestos y descuentos;
- gestión de mesas, comandas y tickets;
- gestión de cobros y medios de pago;
- identificación de clientes y recopilación de datos necesarios para la facturación;
- generación de la información comercial necesaria para la emisión de facturas;
- transmisión de la información de facturación al sistema Odoo mediante mecanismos de integración software;
- consulta y representación al usuario del estado de las operaciones integradas.

Dentro de la arquitectura objeto de esta declaración, **Tickit no implementa por sí mismo la lógica normativa Veri*Factu**.

En particular, Tickit no asume como componente propio las funciones correspondientes a:

- generación definitiva del registro de facturación conforme al formato Veri*Factu;
- generación de la huella o encadenamiento exigidos por la normativa cuando corresponda;
- construcción del XML Veri*Factu;
- gestión de los mecanismos criptográficos o certificados utilizados para Veri*Factu;
- comunicación directa de los registros Veri*Factu con la Agencia Estatal de Administración Tributaria;
- gestión de respuestas, validaciones y protocolos específicos del servicio Veri*Factu de la AEAT.

Estas funciones son realizadas por **Odoo**, mediante su funcionalidad y módulos de localización española compatibles con Veri*Factu.

Por tanto, la arquitectura funcional puede representarse de forma simplificada como:

**Tickit → integración de facturación → Odoo → lógica Veri*Factu → AEAT**

Tickit proporciona a Odoo los datos necesarios de la operación comercial. Odoo actúa como componente encargado de aplicar la lógica de facturación fiscal y Veri*Factu correspondiente.

El funcionamiento conforme al Reglamento debe entenderse referido al **conjunto de componentes que forman el SIF**, y no a Tickit considerado aisladamente.

### e) Indicación de si el sistema informático únicamente puede funcionar como «VERI*FACTU»

**N**

Tickit, considerado como componente individual, no realiza directamente la remisión de los registros de facturación a la AEAT ni implementa de manera autónoma las funciones propias de Veri*Factu.

En la configuración objeto de esta declaración, las operaciones que deban quedar sometidas al sistema Veri*Factu son transferidas a **Odoo**, siendo dicho componente el responsable de generar, procesar y, en su caso, remitir los correspondientes registros de facturación conforme a su propia declaración responsable y configuración.

Tickit no implementa un mecanismo alternativo propio para sustituir la lógica Veri*Factu de Odoo dentro de esta arquitectura.

### f) Indicación de si el sistema informático permite ser usado por varios obligados tributarios

**[N / S SEGÚN CONFIGURACIÓN COMERCIAL DEFINITIVA]**

Si cada instalación o cuenta Tickit está asociada a un único obligado tributario, deberá consignarse:

**N**

Si una misma instancia de Tickit permite gestionar de forma efectiva la facturación correspondiente a varios obligados tributarios distintos, deberá consignarse:

**S**

En cualquiera de los casos, Tickit transmite a Odoo la identificación del obligado tributario correspondiente a cada operación de acuerdo con la configuración del establecimiento y de la integración.

### g) Tipos de firma utilizados para firmar los registros de facturación y de evento cuando no se utiliza como «VERI*FACTU»

**No aplicable al componente Tickit.**

Tickit no genera ni firma directamente los registros de facturación o de evento regulados por el Real Decreto 1007/2023.

Las funciones relativas a generación, firma, encadenamiento, conservación y/o remisión de dichos registros corresponden al componente Odoo cuando resulten aplicables, conforme a su configuración y a su correspondiente declaración responsable.

### h) Persona o entidad productora del sistema informático

**[RAZÓN SOCIAL DE ALTEIL / EMPRESA TITULAR DE TICKIT]**

En calidad de productora y responsable del desarrollo del componente software Tickit y de su integración con Odoo.

### i) Número de identificación fiscal de la persona o entidad productora

**NIF: [NIF EMPRESA]**

### j) Dirección postal completa de contacto de la persona o entidad productora

**[DIRECCIÓN SOCIAL COMPLETA]**

[CÓDIGO POSTAL] – [LOCALIDAD] – [PROVINCIA] – España

### k) Declaración de cumplimiento

La entidad productora declara, bajo su responsabilidad, que el componente informático **Tickit**, en la versión identificada en el apartado c) y **dentro del ámbito funcional descrito en la presente declaración**, ha sido diseñado y desarrollado de forma que su integración en el Sistema Informático de Facturación descrito no menoscabe el cumplimiento de lo dispuesto en el artículo 29.2.j) de la Ley 58/2003, de 17 de diciembre, General Tributaria; en el Reglamento aprobado por el Real Decreto 1007/2023, de 5 de diciembre; en la Orden HAC/1177/2024, de 17 de octubre; y en las especificaciones técnicas publicadas por la Agencia Estatal de Administración Tributaria que resulten de aplicación.

El cumplimiento del conjunto del Sistema Informático de Facturación objeto de esta arquitectura está condicionado al uso conjunto de Tickit con una **versión compatible y correctamente configurada de Odoo que disponga de su correspondiente declaración responsable para las funcionalidades Veri*Factu utilizadas**.

La presente declaración correspondiente a Tickit **no sustituye, absorbe ni extiende la declaración responsable emitida por el productor de Odoo**, ni atribuye a Tickit las funciones de generación y remisión de registros Veri*Factu realizadas por dicho software.

Tickit asume la responsabilidad correspondiente a las funciones desarrolladas por su propio componente y, especialmente, a que su integración:

- transmita a Odoo de forma correcta los datos de las operaciones necesarios para la facturación;
- no permita modificar desde Tickit los registros fiscales ya generados por Odoo mediante mecanismos que vulneren las garantías exigidas por la normativa;
- no sustituya ni eluda los mecanismos de integridad, trazabilidad, conservación o remisión implementados por Odoo;
- mantenga una correspondencia trazable entre la operación comercial registrada en Tickit y la operación remitida al componente de facturación;
- trate adecuadamente las respuestas y estados recibidos de Odoo para evitar la emisión consciente de información contradictoria o duplicada.

### l) Fecha y lugar de suscripción

En **[LOCALIDAD], España**, a **[DÍA] de [MES] de [AÑO]**.

**Por [RAZÓN SOCIAL]**

Nombre y apellidos: [NOMBRE DEL REPRESENTANTE]

Cargo: [CARGO]

Firma:

____________________________


# ANEXO I — ARQUITECTURA Y DISTRIBUCIÓN DE RESPONSABILIDADES

## 1. Arquitectura del Sistema Informático de Facturación

El sistema utilizado se encuentra compuesto por diferentes componentes software que cooperan para realizar el proceso completo de venta y facturación.

### Tickit

Tickit actúa como interfaz operativa de punto de venta y componente de gestión comercial.

Recoge y gestiona los datos de las operaciones realizadas por el establecimiento y transmite al componente de facturación la información necesaria para la emisión de los documentos fiscales correspondientes.

### Odoo

Odoo actúa como componente encargado de las funcionalidades fiscales relacionadas con Veri*Factu.

En particular, cuando la funcionalidad Veri*Factu se encuentra habilitada y correctamente configurada, corresponde a Odoo ejecutar las operaciones propias de dicha funcionalidad de acuerdo con su versión, módulos instalados, configuración y declaración responsable.

La compatibilidad de una versión concreta de Odoo con Veri*Factu deberá acreditarse mediante la **declaración responsable publicada por el productor de Odoo aplicable a dicha versión**.

## 2. Dependencia funcional

Tickit **depende expresamente de Odoo para la implementación de la lógica Veri*Factu**.

La conexión entre ambos componentes forma parte de la arquitectura del SIF.

Por ello, la utilización de Tickit de forma aislada, sin el componente Odoo previsto en esta declaración, **no debe considerarse una implementación autónoma de Veri*Factu ni queda amparada como tal por esta declaración**.

Una instalación será considerada conforme a la arquitectura aquí declarada cuando, como mínimo:

1. utilice una versión de Tickit cubierta por la presente declaración;
2. utilice una versión compatible de Odoo;
3. disponga de la declaración responsable correspondiente a dicha versión/configuración de Odoo;
4. tenga habilitados los componentes de localización española y Veri*Factu necesarios;
5. mantenga operativa la integración Tickit–Odoo prevista por el productor;
6. no hayan sido introducidas modificaciones de terceros que alteren las funciones relevantes para el cumplimiento normativo sin su correspondiente declaración responsable.

## 3. Generación de la factura y del registro fiscal

Los datos comerciales pueden originarse en Tickit.

No obstante, a efectos de la arquitectura declarada, la lógica normativa necesaria para generar y gestionar el correspondiente registro de facturación Veri*Factu corresponde a Odoo.

La existencia de una venta o ticket interno en Tickit no debe interpretarse, por sí sola, como generación autónoma por Tickit del registro fiscal Veri*Factu.

## 4. Modificaciones y anulaciones

Cualquier modificación, rectificación o anulación con trascendencia fiscal deberá ejecutarse respetando el flujo de integración con Odoo y las reglas previstas en el componente encargado de Veri*Factu.

Tickit no deberá implementar operaciones destinadas a modificar directamente registros fiscales previamente generados por Odoo al margen de los mecanismos de rectificación o anulación legalmente previstos.

## 5. Conservación de las declaraciones responsables

Deberán conservarse y ponerse a disposición del usuario, cuando resulte aplicable:

- la presente declaración responsable de Tickit correspondiente a la versión instalada;
- la declaración responsable de Odoo correspondiente a la versión utilizada;
- las declaraciones responsables de cualquier otro componente o ampliación de terceros que tenga incidencia en el cumplimiento del Reglamento.

## 6. Accesibilidad

La declaración responsable de Tickit deberá mantenerse accesible para el usuario de forma rápida, fácil e intuitiva desde la propia aplicación, además de encontrarse disponible en formato electrónico de uso común.

Se recomienda incorporarla en una ubicación estable como:

**Configuración → Información legal → Sistema Informático de Facturación → Declaración responsable**

La pantalla deberá identificar, como mínimo:

- versión de Tickit;
- fecha de la declaración;
- productor;
- declaración responsable descargable;
- componente externo utilizado para Veri*Factu;
- versión de Odoo o compatibilidad requerida;
- acceso o referencia a la declaración responsable correspondiente de Odoo.


# ANEXO II — DELIMITACIÓN DE RESPONSABILIDAD DEL COMPONENTE TICKIT

La presente declaración certifica las características y comportamiento del software producido por el desarrollador de Tickit dentro del ámbito descrito.

No constituye una certificación independiente del software Odoo ni de modificaciones realizadas sobre este por terceros.

La conformidad del SIF completo depende de la correcta interacción de los componentes que lo integran y de que cada componente sujeto a declaración responsable disponga de la declaración correspondiente a la versión efectivamente utilizada.

Cualquier modificación no autorizada de la integración, sustitución del componente de facturación, manipulación de los flujos de datos fiscales o alteración de la configuración Veri*Factu de Odoo podrá situar la instalación fuera del alcance de esta declaración.