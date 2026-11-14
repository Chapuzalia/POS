# Tickit POS: Condiciones Generales, aviso legal y SEPA Core

13 de noviembre de 2026. Cambios preparados localmente; sin despliegues, configuración de producción, nuevos cobros, correos reales, devoluciones ni cancelaciones reales. Se conservan las ediciones anteriores y el trabajo de Data Act, DPA y privacidad.

## Documentos y decisiones comerciales

La edición activa del manifiesto pasa a `2026-11-13.4`:

- `public/legal/2026-11-13-saas/condiciones-saas.html`, `1.4-saas.1`.
- `public/legal/2026-11-13-saas/aviso-legal.html`, `1.3-lssi.1`.
- `public/legal/2026-11-13-saas/privacidad.html`, `1.4-rgpd.2`: únicamente coordina el correo transaccional de cuenta/facturación con las pre-notificaciones.
- El DPA sigue en su edición separada `1.4-rgpd.1`. No se altera su Anexo III ni la revisión excluida de Sentry.

Se mantienen precios exclusivamente en Oferta, duración y renovación acordadas, baja ordinaria al vencimiento, no reembolso con excepciones legales, seis meses de recuperación, contratación electrónica sin firma manuscrita, DPA con aceptación independiente y privacidad informativa sin casilla de consentimiento. No se añade un porcentaje de disponibilidad, SLA 99,9 %, créditos o nuevas garantías comerciales. Tickit Carta, Tickit Events y Tickit Personal mantienen contratación independiente.

| Apartado CG | Corrección y motivo |
| --- | --- |
| B2B | El uso profesional y las facultades se declaran expresamente; la casilla no elimina la condición real ni derechos imperativos de un eventual consumidor. |
| Contratación electrónica | Idioma, revisión/corrección previa, documentos descargables y versionados, acuse archivable en Mi plan, identidad/negocio/fecha/oferta/huellas y acceso a copia por soporte. La aceptación no se confunde con el cobro y no se presenta como firma cualificada o prueba irrebatible. |
| Propiedad intelectual | Se conserva la titularidad y licencia; se respetan componentes de terceros, excepciones legales, interoperabilidad y datos/activos propios exportables. No se utiliza la licencia técnica para autorizar entrenamiento o fines comerciales propios sobre datos del restaurante. |
| Precios y modificaciones | Se coordina el preaviso de treinta días con la nueva Oferta aceptada ya exigida por la cl. 5.3. Un catálogo, silencio o uso continuado no autorizan cambios discrecionales de precio o condiciones esenciales. |
| Renovaciones y bajas | Se concretan canal, confirmación y fecha efectiva, sin convertir la revocación bancaria en baja ni una tramitación bancaria pendiente en derecho a cobrar un período no debido. |
| No reembolsos | Se mantiene la regla y las excepciones comerciales, preservando cobros indebidos/duplicados y restituciones legales. Se distingue devolución bancaria de inexistencia de deuda por el servicio. |
| Impagos | No se cambian los plazos comerciales D, D+3, D+10, D+15, devolución con siete días o resolución. Se excluye equiparar un SEPA pendiente a impago y se exige comprobar cargos no autorizados o no debidos. Las salvaguardas protegen operaciones abiertas, cobros, documentos y salida; no permiten ventas nuevas ordinarias durante suspensión. |
| Soporte y disponibilidad | Se mantienen horario, canal y objetivos de primera respuesta de medios. No se convierten en tiempos garantizados de resolución ni en disponibilidad porcentual. |
| Responsabilidad | Se conserva el límite ordinario de cuotas de los doce meses previos, sin excluir tipos de daño nuevos. Se precisan excepciones imperativas, dolo, culpa grave cuando no sea limitable, datos personales, responsabilidades propias del productor/proveedor y restituciones exigibles, sin declarar ilimitado cualquier incidente. |
| VeriFactu | La declaración debe identificar versión y arquitectura y estar disponible cuando sea exigible; no se confunde con aprobación de la AEAT. Se preservan obligaciones propias de Alteil y del restaurante, integridad de documentos y gestión de envíos/rectificaciones pendientes. |
| Exportación | Las cl. 11.4–11.15 procedentes de la revisión Data Act se conservan sin modificación: categorías, formatos, exclusiones, asistencia, continuidad, costes y seis meses coordinados con RGPD. Se actualiza el enlace de CG en el registro público. |

## Aviso legal y comprobación societaria

El anuncio **499639 del BORME núm. 215, de 10/11/2026**, confirma ALTEIL SOLUTIONS S.L., domicilio en Calle Primer de Maig 37 de Santa Margarida de Montbui, administrador único David Argente González, sección 8, hoja B 666005, inscripción 1 de 30/10/2026, capital 3.000 euros y actividad principal CNAE 6210. El NIF **B05839543 está verificado según confirmación expresa del usuario y se conserva sin cambios**. No se sustituye domicilio, representación ni identificación registral.

La identificación, domicilio, contacto electrónico directo, registro y NIF de art. 10.1.a/b/e LSSI figuran en el aviso. Los precios se remiten a la Oferta con información de impuestos y gastos aplicables (10.1.f). Para la actividad SaaS examinada no se ha identificado un supuesto de autorización administrativa profesional, colegiación, código de conducta adherido o servicio de tarificación adicional que obligue a inventar esos datos; Alteil no se describe como entidad de servicios de pago por cobrar sus propias cuotas mediante Mollie.

Se retiran «lista operativa a mantener por Product/Tech», «cláusulas sensibles», «cuando se habilite» y referencias de coordinación interna. La publicación vigente tiene acceso desde la pantalla de entrada y enlaces legales comunes; se mantienen las copias históricas necesarias para probar aceptaciones anteriores.

## Mandato y pre-notificación: funcionamiento preparado

Se contrasta el **2025 SEPA Direct Debit Core Rulebook, versión 1.2, vigente desde 30/09/2026**, no la versión 1.1 sustituida. El uso profesional de Tickit no transforma el esquema Core en SDD B2B.

1. El formulario identifica al beneficiario contractual Alteil, NIF y domicilio, la intervención de Mollie y su identificador SEPA publicado **NL08ZZZ502057730000**. No se inventa un identificador propio de Alteil ni se utiliza su NIF como identificador bancario.
2. La referencia propia del mandato conserva el UUID completo, con prefijo de alta o sustitución y 35 caracteres. Se distingue del `mdt_` de Mollie. La recuperación de operaciones antiguas contempla sus referencias anteriores sin sustituir el mandato firmado por uno nuevo arbitrariamente.
3. La casilla autoriza los adeudos y acuerda expresamente reducir el plazo general de catorce días a **tres días naturales**, por decisión del usuario. El texto íntegro, los derechos de devolución y la revocación quedan en un desplegable cerrado inicialmente; la autorización y reducción de 14 a 3 días permanecen visibles junto a la casilla. El backend exige autorización afirmativa y versión vigente; no basta con aceptar CG, DPA o una orden SEPA sin ese dato. Los mandatos previos **sin prueba del acuerdo conservan catorce días**.
4. Antes de crear el mandato se conserva el texto, versión, fecha/hora, actor autenticado, negocio, referencia, acreedor, titular, últimos cuatro caracteres y huella del IBAN. En el alta forma parte del justificante contractual; en el cambio de cuenta queda en el historial privado de facturación antes de la llamada a Mollie. La huella del justificante usa claves ordenadas para sobrevivir al reordenamiento de JSONB. No se almacena ni se registra el IBAN completo.
5. El propietario dispone de descarga de la autorización e historial de avisos en Mi plan. La autorización anterior no se suplanta retroactivamente ni se presenta el clic como firma cualificada o servicio bancario formal de e-Mandates del EPC. La fecha enviada a Mollie es la de la autorización conservada, también al reintentar.
6. La primera cuota sigue con tarjeta y las renovaciones con el mandato SEPA válido. No se permite pasar silenciosamente a renovaciones con la tarjeta inicial si falta el mandato SEPA. Se conservan validación de IBAN, comprobación de estado en Mollie, aislamiento del negocio, idempotencia y la distinción entre pendiente bancario, pago y devolución. Los reintentos de cambio de cuenta no permiten sustituir el titular/cuenta/actor de una autorización ya registrada para la misma solicitud.
7. La conciliación prepara y envía por Resend el importe, fecha de vencimiento, referencia, identificador de acreedor y cuenta enmascarada del próximo adeudo conocido. Un aviso puede enviarse con más antelación; no se espera obligatoriamente al día D−3. Se utiliza el canal de correo transaccional ya existente y `RESEND_WELCOME_API_KEY`, sin nuevas credenciales en el navegador.
8. Avisos y resultados se registran en el historial privado existente. La combinación de negocio, suscripción, mandato, fecha, importe y destinatario da una clave estable para reintentos. No se reenvía un aviso confirmado y una entrega incierta no se repite ciegamente fuera de la ventana de idempotencia. Un fallo definitivo/configuración ausente se reintenta con separación para no generar correo/auditoría en cada consulta. Una entrega tardía queda marcada **fuera de plazo**, no como cumplimiento de tres/catorce días.
9. Se comprueba el plazo aplicable antes de confirmar nuevos cambios de cuota/periodicidad o cuenta que afecten al adeudo próximo. Si un checkout de ampliación ya autorizado se paga después del límite, se preserva el acceso pagado y se evita elevar automáticamente el adeudo no preavisado; queda una incidencia de coordinación/regularización. No se cancela automáticamente un cobro anterior, no se cobra otra tarjeta, no se condona una diferencia ni se inventa un nuevo precio. Requiere revisión operativa de los casos señalados.
10. Los fallos de correo no se convierten en impago ni revocan acceso pagado. Se muestran en el historial y generan diagnóstico sin datos personales y resultado de supervisión de conciliación. La aceptación por Resend no certifica llegada a bandeja o lectura. La regla comercial de suspensión no se altera.

## Conservación y copia bancaria

La evidencia de autorización y sus modificaciones debe conservarse durante la vigencia y los plazos aplicables de reclamación/conservación de la relación de cobro. Ocho semanas y trece meses son ventanas de devolución/reclamación, no una política universal de borrado. La regla de inactividad de 36 meses del esquema exige obtener un nuevo mandato cuando proceda; el estado de Mollie no debe utilizarse para afirmar que se ha auditado por completo ese requisito.

Para una copia bancaria completa, el procedimiento consiste en localizar el mandato por los identificadores vinculados, obtener los datos originales mediante el acceso autorizado a Mollie, comprobar referencia y huella del IBAN frente a la autorización conservada y facilitar la copia por un canal adecuado al deudor o a su entidad, registrando la actuación. **La descarga con cuenta enmascarada no es por sí sola una copia bancaria íntegra.** No se ha comprobado la disponibilidad y conservación contractual de todos esos datos después de una revocación: no se declara cerrado ese extremo ni se introduce almacenamiento de IBAN en claro para ocultarlo.

## Diferencias operativas que no se corrigen alterando la política comercial

- **Impago:** `billing_accounts.grace_days` es configurable y su valor inicial es 14; `commercialState` y la proyección de acceso lo utilizan. El texto comercial mantiene D+15, la ventana de fin de semana/festivos, los avisos D/D+3/D+10 y los regímenes de siete/sesenta días. No se ha identificado una automatización integral equivalente de todos esos avisos y cómputos. No se cambia su configuración ni se declara aplicada esa política en producción.
- **Operaciones abiertas:** existen protecciones de actividad/caja/comandas antes de reducir accesos o capacidad en `billing_transition`. Se exige conservar operaciones y documentos. Eso no certifica que todos los escenarios fiscales, offline y de suspensión estén cubiertos por esa protección parcial; no se modifica la semántica de ventas, caja o fiscalidad en esta revisión.
- **Cuotas en suspensión:** la ausencia contractual de nuevas cuotas durante suspensión no debe confundirse con que cada estado de acceso local detenga por sí solo una suscripción bancaria activa. Las cuentas y cargos afectados requieren conciliación y una actuación autorizada; no se ejecuta una cancelación masiva para ajustar el texto.
- **VeriFactu:** `docs/fiscal/declaracion_responsable.md` es histórico/no aplicable; `DECLARACION_RESPONSABLE_BORRADOR.md` no es declaración final. La revisión no firma, valida ni publica una declaración de la versión fiscal suministrada.
- **Puesta en producción de los avisos:** comprobar sender/permisos Resend, contacto de facturación, frecuencia/cobertura del cron y primeros avisos con margen suficiente. Las próximas domiciliaciones ya existentes pueden tener menos de catorce días sin un acuerdo de reducción acreditado: se señalan para coordinación, sin retrofechar avisos ni imponer tres días unilateralmente. Los casos fuera de plazo o con cambio pendiente exigen intervención antes del cobro; el registro de un error no subsana el preaviso.

## Fuentes oficiales

- [LSSI, arts. 10 y 23–28](https://www.boe.es/buscar/act.php?id=BOE-A-2002-13758); [Ley 7/1998, condiciones generales](https://boe.es/buscar/act.php?id=BOE-A-1998-8789); [Código Civil, arts. 1101–1105 y 1255–1258](https://www.boe.es/buscar/act.php?id=BOE-A-1889-4763).
- [BORME 10/11/2026, Barcelona, anuncio 499639](https://www.boe.es/diario_borme/txt.php?id=BORME-A-2026-215-08&lang=es).
- [EPC: versión vigente de SDD Core](https://www.europeanpaymentscouncil.eu/what-we-do/epc-payment-schemes/sepa-direct-debit-sdd/sepa-direct-debit-core-rulebook-and) y [Rulebook 2025 v1.2](https://www.europeanpaymentscouncil.eu/sites/default/files/kb/file/2026-09/EPC016-06%202025%20SDD%20Core%20Rulebook%20version%201.2.pdf), en especial 4.1–4.3, PT-04.01, PT-04.15/20 y atributos del mandato. Se distingue el esquema Core del B2B y del servicio formal de e-Mandates.
- [Mollie: identificador de acreedor](https://help.mollie.com/hc/en-us/articles/115001921985-What-is-Mollie-s-Creditor-Identifier) y [creación de mandatos](https://docs.mollie.com/reference/create-mandate). La API técnica no sustituye la autorización válida del deudor.
- [AEAT: certificación mediante declaración responsable](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/certificacion-sistemas-informaticos-declaracion-responsable.html).

## Verificación

- `pnpm exec vitest run tests/functional/billing-sepa.test.ts`: **9 pruebas aprobadas** sobre autorización/versionado, prueba persistida, no conservación del IBAN, referencia completa, avisos/deduplicación, errores de envío, plazo de tres días y conservación de catorce sin acuerdo, y ampliaciones pagadas fuera del plazo de aviso.
- `pnpm exec vitest run tests/functional/billing-legal-ui.test.ts tests/functional/billing-admin.test.ts`: **32 pruebas aprobadas** tras hacer desplegable el texto. La comprobación de representación verifica un único mandato de pago y la información de privacidad separada; el desplegable queda cerrado inicialmente.
- `pnpm build`: aprobado tras corregir los tipos de la evidencia y mantener la respuesta de conciliación compatible cuando no hay advertencias. `pnpm lint`: sin errores; tres avisos preexistentes de CRM, restaurante y NativeBillingNotice.
- Huellas de los cuatro documentos activos y enlaces/anclas comprobados contra el contenido actual del workspace, conservando las ediciones aportadas. Se han preservado las cl. 11.4–11.15 de Data Act. `git diff --check`: sin errores en la revisión.

La ejecución completa inicial detectó fallos de compatibilidad de respuesta y de una fixture de ampliación; se corrigieron y se verificaron los grupos afectados. También se actualizaron huellas tras cambios de los documentos en el workspace. **No se repitió la suite completa**, por indicación expresa del usuario; la comprobación final se acotó al flujo SEPA y a las huellas documentales. No se han probado cobros o correos con servicios reales, la configuración de producción ni la presentación en un navegador.
