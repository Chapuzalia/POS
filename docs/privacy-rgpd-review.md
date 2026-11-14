# Tickit POS: información de privacidad, arts. 12 y 13 RGPD

13 de noviembre de 2026. Revisión local de documentación y de los formularios afectados. Sin cambios de producción, bases de datos, ventas, permisos o controles de seguridad. Se mantienen las decisiones comerciales y las ediciones legales anteriores.

## Resultado

- Nueva política en `public/legal/2026-11-13-rgpd/privacidad.html`, versión `1.4-rgpd.1`, manteniendo los apartados de identidad, finalidades/bases, destinatarios, transferencias, conservación, derechos, capas y datos necesarios, y ampliándolos.
- Manifiesto `supabase/functions/_shared/billing/legal.ts` actualizado a `2026-11-13.3`, con la nueva ruta, versión y huella. Los justificantes anteriores conservan los documentos archivados en sus recibos; no se reescribe la edición de 12/11/2026.
- Primera capa visible antes de los datos en acceso, perfil de facturación y domiciliación, incluida la sustitución del mandato sin repetir los datos del pagador. La segunda capa es la política enlazada, también disponible desde Documentación y Mi plan mediante el manifiesto común.
- Bienvenida: primera capa añadida al correo manual (HTML y texto) y variable `PRIVACY_URL` preparada para la plantilla externa. El fragmento `docs/welcome-privacy-footer.html` permite incorporar el mismo aviso en esa plantilla sin rehacer su diseño. Su publicación externa queda pendiente; no se ha reemplazado el modelo de plantillas ni enviado correo real.
- Se mantienen las dos casillas contractuales de oferta/representación y DPA. No se añade una aceptación de privacidad ni consentimiento genérico; el mandato SEPA continúa separado como autorización de pago.

## Correcciones y evidencia

| Información | Corrección y evidencia |
| --- | --- |
| Identidad y funciones | Se conservan los datos identificativos de Alteil. Se separan su relación comercial y obligaciones propias de las operaciones del restaurante; soporte, seguridad o diagnóstico sobre datos operativos por cuenta del restaurante permanecen en el DPA. No se inventa una designación de DPD o una certificación. |
| Contratación y contactos | Se reserva el art. 6.1.b a personas que sean parte del contrato o pidan medidas precontractuales. Para interlocutores de sociedades, art. 6.1.f y art. 19 LOPDGDD en su alcance profesional. Se describen los intereses y la oposición, sin dar por hecho que cada empleado es contratante. |
| Facturación y cobros | `BillingProfileFields.tsx`, `SepaMandateFields.tsx`, `billing/profile.ts` y `billing/service.ts` muestran identificación fiscal, domicilio, email, titular e IBAN. `sepaMandate` transmite estos últimos a Mollie para el mandato. La tarjeta se recoge en el checkout de Mollie. Se distinguen cobro contractual, gestión de representantes y conservación fiscal/contable. |
| Soporte, seguridad y diagnóstico | Se individualizan fines, categorías y bases. No se asigna al interés legítimo propio el contenido operativo del restaurante. Se mantiene la identificación contractual existente del proveedor de diagnóstico, sin revisar Sentry, Replay ni su configuración, excluidos por instrucción del usuario. El texto no certifica la existencia de un gestor de consentimiento. |
| Obligaciones legales | Se vincula el art. 6.1.c a obligaciones concretas fiscales/contables, derechos o incidentes. La defensa de reclamaciones se identifica por separado como interés legítimo; no como obligación universal. |
| Destinatarios | Infraestructura OVHcloud/Webdock, Cloudflare, diagnóstico, Mollie/bancos y destinatarios legales o de reclamaciones, según su función. Mollie se identifica como responsable independiente en sus servicios de pago, conforme a su información oficial. `welcome-email.ts` y `docs/stripe-onboarding.md` identifican además Resend para la bienvenida cuando se habilita; se incorpora de forma condicionada, con su DPA, en el circuito propio de Alteil, sin afirmar que se haya comprobado su activación en producción. Supabase autoalojado no implica un proveedor externo Supabase Inc. |
| Escaneo inteligente | Mistral, Microsoft Azure y OpenAI solo para el complemento contratado y utilizado, bajo el DPA del restaurante. No se presentan como receptores generales de datos de contratación, archivo manual o ventas. Se conservan las restricciones de finalidad y entrenamiento. |
| Transferencias | Se mantiene Francia/Dinamarca para infraestructura propia y se diferencia de red, accesos y proveedores externos. Se informa de posibles destinos fuera del EEE, incluido EE. UU., mecanismo de adecuación o CCT aplicable, cadena pública y acceso a copia de garantías. No se presume adhesión efectiva de una entidad al DPF ni una región privada no acreditada. |
| Conservación | Criterios por finalidad y hechos que determinan su término, no una remisión global al proveedor. Se distinguen seis años mercantiles y cuatro años tributarios generales, sus inicios, interrupciones y excepciones; los plazos especiales o territoriales de reclamaciones no se sustituyen por un único plazo civil. Bloqueo limitado y eliminación de copias; los seis meses de recuperación empresarial no se extienden a cualquier tratamiento propio. |
| Derechos | Alcance de cada derecho, oposición a intereses legítimos, retirada específica, plazos de respuesta, gratuidad con excepciones, comprobación proporcionada de identidad, reclamación ante AEPD/autoridad competente y separación de solicitudes al restaurante. Se corrige el enlace AEPD defectuoso. |
| Procedencia, necesidad y automatización | Se explican datos directos, contactos facilitados por el negocio, estados de Mollie y eventos técnicos; también información del art. 14 para contactos indirectos. Se distinguen campos necesarios/opcionales. Se describe la lógica de activación/renovación según contrato y pago, sus efectos y revisión humana, sin negar globalmente las automatizaciones existentes ni atribuir a Alteil los controles de fraude de Mollie. |

## Límites operativos

El texto define las obligaciones y criterios que deben aplicarse; no certifica por sí solo su ejecución. La revisión no prueba firmas privadas de proveedores, ajustes de sus cuentas, ejecución de borrados periódicos ni procedimientos internos de atención de derechos. Los pendientes de conservación, recuperación, accesos y brechas ya identificados están en `docs/dpa-rgpd-review.md`; no se han alterado esos controles ni el encargo aprobado. No se ha ampliado ninguna finalidad comercial o de aprendizaje global.

**Pendiente externo concreto:** añadir a la plantilla de Resend `23a9523e-2c39-405f-8cf4-99dfa8ba8160` el fragmento preparado y declarar `PRIVACY_URL` con fallback a la URL pública del documento, para clientes de funciones anteriores. No se ha inspeccionado su HTML publicado ni se presume que ya contenga el aviso. El API de Resend impide combinar `template` con `html`/`text`; no se intenta sobrescribir su contenido desde el envío. Es un cambio de producción que no se ha ejecutado. La política y el frontend pueden prepararse y verificarse localmente sin esa publicación.

## Fuentes oficiales contrastadas

- [RGPD, arts. 5, 6, 12–14 y 15–22](https://www.boe.es/buscar/doc.php?id=DOUE-L-2016-80807): información, bases y derechos.
- [LOPDGDD, arts. 11, 19 y 32](https://www.boe.es/eli/es/lo/2018/12/05/3/con): capas, contactos profesionales y bloqueo.
- [AEPD: guía del deber de informar](https://www.aepd.es/guias/guia-modelo-clausula-informativa.pdf): estructura por capas; el ejemplar público está marcado «en revisión», por lo que se usa como orientación junto a la normativa vigente.
- [AEAT: conservación de libros, art. 30 del Código de Comercio](https://www3.agenciatributaria.gob.es/Sede/impuesto-sobre-sociedades/gestion-impuesto-sobre-sociedades/obligaciones-contables-registrales/conservacion-libros.html), [Ley General Tributaria, arts. 66–70](https://boe.es/buscar/act.php?id=BOE-A-2003-23186) y [Código Civil, art. 1964.2](https://www.boe.es/buscar/act.php?id=BOE-A-1889-4763#a1964).
- [Mollie: política de privacidad y función como responsable en pagos](https://www.mollie.com/legal/privacy); [Cloudflare: DPA y transferencias](https://www.cloudflare.com/cloudflare-customer-dpa/). Las referencias restantes a DPA se conservan conforme a la revisión anterior.
- [Resend: DPA](https://resend.com/legal/dpa) y [API de envío con plantilla](https://resend.com/docs/api-reference/emails/send-email): proveedor de bienvenida localizado en código y separación entre contenido local y plantilla publicada.

## Verificación

- Pruebas específicas de contratación, administración, altas y bienvenida: `pnpm exec vitest run tests/functional/billing-legal.test.ts tests/functional/billing-legal-ui.test.ts tests/functional/billing-admin.test.ts tests/functional/billing-onboarding.test.ts tests/functional/welcome-email.test.ts`: **54 aprobadas**. Incluyen la presentación de privacidad antes de recoger datos fiscales/SEPA, sin duplicados ni casillas adicionales, y los enlaces de bienvenida con origen validado.
- `pnpm test`: **656 pruebas funcionales y 236 legacy aprobadas**, sin fallos.
- `pnpm lint`: sin errores; tres avisos preexistentes en `CrmPage`, `useRestaurantController` y `NativeBillingNotice`.
- `pnpm build`: aprobado, incluidas las comprobaciones TypeScript de API y frontend. Sin publicar releases ni mapas de fuentes.
- Cuatro huellas SHA-256 del manifiesto verificadas, enlaces locales y anclas de privacidad correctos y edición de privacidad de 12/11/2026 comparada con `HEAD`: intacta. `git diff --check`: sin errores.

No se han enviado correos reales, publicado la plantilla de Resend ni inspeccionado su contenido remoto. La verificación de los avisos usa renderizado estático de componentes y pruebas locales; no se ha realizado una revisión visual en navegador ni una comprobación de procedimientos o configuraciones de producción.
