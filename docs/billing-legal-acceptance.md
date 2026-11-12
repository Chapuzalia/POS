# Aceptación de la contratación SaaS

Revisión normativa: 12 de noviembre de 2026. Ámbito: contratación B2B de Tickit POS desde activación y Mi plan. Preparación local; no autoriza publicación ni cambios en producción.

| Documento o declaración | Tratamiento en el alta | Fundamento |
| --- | --- | --- |
| Oferta, condiciones particulares y CG SaaS | Aceptación expresa, inicialmente desmarcada | LSSI arts. 23, 24 y 27; LCGC arts. 2, 5 y 7. La oferta identifica alcance, cuota, IVA, periodicidad, renovación, baja y medios de pago. |
| DPA y anexos | Aceptación contractual en casilla independiente | RGPD art. 28.3 y 28.9: contrato vinculante por escrito, incluido soporte electrónico. La casilla separada sigue el mecanismo previsto en los documentos aportados; no es un requisito universal de forma del RGPD. |
| Información art. 13 RGPD | Información visible y enlace, sin aceptación ni consentimiento obligatorio | RGPD arts. 6, 12 y 13; LOPDGDD arts. 11 y 19. La gestión contractual, fiscal y de contactos B2B tiene sus respectivas bases jurídicas; no se convierte en consentimiento mediante una casilla. |
| Aviso legal | Acceso público y gratuito, también desde login; sin casilla | LSSI art. 10. Es una obligación informativa del prestador. |
| Actuación profesional y representación | Declaración expresa integrada en la casilla de oferta/CG, sin otra casilla | Delimita la oferta B2B y las facultades de representación de las CG. La declaración no excluye derechos imperativos de quien realmente sea consumidor. |
| Domiciliación SEPA | Autorización independiente ya existente | La aceptación del contrato no sustituye la autorización de cobro. |
| Cookies y Session Replay | Fuera de este cambio, por indicación expresa del usuario | No se añade consentimiento de Replay al pago y no se registra como concedido. El DPA mantiene su distinción entre autorización de subencargado y consentimiento del usuario. |

## Evidencia y confirmación

El servidor exige las aceptaciones en toda nueva alta, incluidas las de clientes instalados antiguos: si no pueden enviarlas, se solicita actualizar. No se altera la ejecución de suscripciones vigentes ni de pagos que ya estaban en trámite antes del cambio.

La nueva RPC `billing_accept_contract` registra la evidencia y reclama la operación en una sola transacción. Si falla cualquiera, no crea cliente, mandato ni pago en Mollie. La identidad procede de la sesión y se comprueba que sea propietario activo de la empresa. Superadmin no acepta el alta en nombre del cliente.

Se conservan la fecha/hora del servidor, usuario, empresa, operación, declaración B2B, razón social/NIF/contacto del contratante, contrato con plan y extras, resumen económico en céntimos y versiones/rutas/huellas SHA-256 de los cuatro documentos. No se guarda el IBAN. Privacidad y aviso se registran como documentos facilitados, no como consentimientos. La tabla reside en un esquema privado, fuera de la Data API, y permite lectura al propietario de su empresa; el servidor solo tiene permisos de lectura e inserción, sin actualización ni borrado de evidencias.

La respuesta de aceptación entrega el acuse y lo archiva inmediatamente en Mi plan, donde se pueden descargar el justificante y cada documento. El cliente continúa directamente a Mollie, sin una segunda pantalla de confirmación. El acuse acredita aceptación, no pago; la activación conserva la comprobación de pago de Mollie. No se envía correo nuevo.

La interfaz usa dos casillas contractuales independientes (oferta/CG con representación profesional y DPA), además de la autorización SEPA existente. Los enlaces están en cada texto; privacidad y aviso aparecen como enlaces informativos. Un único resumen muestra el cargo inicial, IVA y cuota posterior. Los detalles de contratación se pueden desplegar antes de aceptar.

Los documentos públicos son HTML almacenables, imprimibles y versionados. No se deben editar una vez publicados: futuras revisiones deben usar otra ruta y versión conservando las anteriores. `.gitattributes` fija LF para estabilizar las huellas entre sistemas. El service worker guarda cada documento con su propia clave, sin sustituir el HTML del POS o del CRM.

## Adaptación de los adjuntos

Se parte de las CG v1.2, DPA v1.3.1, cláusula art. 13 v1.3 y aviso v1.2.1 aportados. Los originales del escritorio permanecen intactos y sus notas de coordinación no se interpretan como instrucciones del usuario.

Las ediciones `mollie.1` / `integracion.1` eliminan cabeceras de trabajo y notas editoriales, adaptan Stripe a Mollie, mantienen las condiciones contractuales y la exigencia de consentimiento separado de Replay, y añaden a privacidad la necesidad de aportar datos contractuales/fiscales y la consecuencia de no hacerlo (art. 13.2.e). No se ha añadido aceptación separada de cláusulas de responsabilidad: la ley no impone una casilla universal para cada cláusula sensible.

## Límites a resolver antes de publicar

- Los documentos facilitados eran borradores. La integración no acredita por sí sola la exactitud de datos societarios, ubicaciones, contratos con proveedores o medidas operativas declaradas. No equivale a certificar todo el clausulado ni la operativa como conformes.
- La información de transferencias remite genéricamente a los DPA de Cloudflare/Sentry. Deben verificarse las transferencias efectivas, sus garantías y cómo obtener copia, además de los proveedores reales de facturación (incluido Odoo y su modalidad de alojamiento). No se inventan destinos ni garantías.
- El plazo de seis meses de exportación/eliminación del DPA debe aplicarse respetando la elección de devolución/supresión del responsable y las obligaciones de conservación (art. 28.3.g RGPD). Esta tarea no implementa ese procedimiento ni cambios de impagos, soporte o fiscalidad.
- El DPA excluye Carta, Eventos y Personal. Contratar esos productos exige comprobar su cobertura documental; este paquete no amplía su alcance por añadirlos como extras.
- `src/sentry.ts` ya configura Replay en errores (`replaysOnErrorSampleRate: 1.0`). Se deja intacto por la exclusión expresa de esta tarea. Ni el DPA ni estas casillas sustituyen el consentimiento que se abordará con cookies.
- La migración revisa `supabase/contracts-pending.yml`; sus tres contratos pendientes son ajenos a facturación y no se consumen ni ejecutan aquí. No se han realizado migraciones remotas, despliegues ni escrituras en producción.

## Fuentes oficiales consultadas

- [Ley 34/2002, LSSI, arts. 10, 22.2, 23, 24, 27 y 28](https://www.boe.es/eli/es/l/2002/07/11/34/con).
- [Ley 7/1998, condiciones generales, arts. 2, 5 y 7](https://www.boe.es/eli/es/l/1998/04/13/7/con).
- [RGPD, arts. 6, 12, 13 y 28](https://eur-lex.europa.eu/legal-content/ES/TXT/?uri=CELEX%3A32016R0679).
- [LOPDGDD, arts. 11, 19 y 33](https://www.boe.es/eli/es/lo/2018/12/05/3/con).
- [AEPD, Guía sobre el uso de cookies, mayo de 2024](https://www.aepd.es/guias/guia-cookies.pdf).
