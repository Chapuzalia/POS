# Inicio guiado del CRM

El CRM utiliza Driver.js 1.10.2: `driver()` para los recorridos y `checklist()`
para el índice de temas. Se carga en un fragmento diferido del CRM, después de
seleccionar un local. No se monta en la pantalla de activación, el POS o el KDS.

## Bienvenida tras la activación

La bienvenida es opcional y se ofrece al propietario cuando la lectura autenticada
de facturación confirma todos estos datos: cuenta Stripe, contrato de alta,
identificadores del negocio coincidentes y `billing_activation_required=false`.
El contexto de sesión también debe haber retirado el bloqueo. El parámetro de
retorno de Checkout no se utiliza como prueba de pago. Se conserva el flujo
existente de conciliación, activación y recarga de sesión, incluido SEPA.

«Más tarde» y cerrar la bienvenida recuerdan la decisión. «Inicio guiado», en la
cabecera, permite abrir la ayuda manualmente, también en negocios existentes y
para responsables con acceso al CRM. Un fallo de lectura de facturación no
interrumpe el CRM; el acceso manual a la ayuda sigue disponible.

## Índice y recorridos

El checklist permite saltar entre datos del local, formatos, organización del TPV,
primer producto, stock, mesas y equipo. Cada tema usa los mismos permisos,
funcionalidades y activaciones por local que la navegación normal. Los temas no
disponibles no se muestran. Ambos accesos comparten el manejador de navegación.

La guía de producto abre el editor existente y señala nombre, formato/precio,
ubicación en el TPV y guardado. La ubicación se omite para productos internos.
Las otras guías explican los controles y los requisitos de cada sección; la de
stock distingue producto de venta de artículo físico y explica unidades,
almacenes, existencias iniciales y la relación de inventario cuando está incluida.
Las guías no crean datos ni guardan formularios por su cuenta. Las validaciones y
los servicios de escritura siguen siendo los de cada pantalla.

Los objetivos del recorrido usan `data-onboarding`, esperan el contenido diferido
y ofrecen volver al índice si la sección no termina de cargar. Al cambiar de
sección, local, usuario, negocio o al desconectarse se destruye el recorrido
activo. Dentro del editor se puede pausar la guía y continuar trabajando; al
cerrar el formulario se vuelve al índice sin descartar el borrador automáticamente.
El popover se incorpora al ámbito de foco del modal y se identifica como capa de
React Aria para que sus controles permanezcan accesibles. Se respetan el tema
claro/oscuro y la preferencia de movimiento reducido.

## Progreso y alcance

La clave nueva `crm:onboarding:v1:<tenantId>:<userId>:<venueId>` guarda en
localStorage `{ offered, reviewed }`. No contiene datos fiscales ni contenido de
formularios. La persistencia es por navegador, usuario, negocio y local; todavía
no se sincroniza entre dispositivos. Si el almacenamiento está bloqueado, la
ayuda sigue funcionando durante la sesión.

Solo «Terminar guía» marca un tema como visto. Cerrar o pausar no lo completa.
Las marcas representan guías vistas, no productos, existencias ni mesas creadas.
Se pueden repetir los temas completados. No hay migración ni cambio de backend.

## Verificación local

- Vitest: activación confirmada, cuentas manuales o pendientes, aislamiento de
  negocio/usuario/local, funcionalidades, almacenamiento inválido o bloqueado,
  aplazamiento, saltos entre temas, finalización y limpieza del recorrido.
- Regresión del retorno de Checkout y suites completas del proyecto.
- Playwright con Edge sin interfaz y servicios sustituidos por datos ficticios,
  en 1440×1000 y 390×844: bienvenida, índice, nombre/precio, navegación de pasos,
  guardado mediante el editor, progreso, cambio de tema, reapertura, persistencia
  al recargar y tema oscuro. Sin errores de consola ni desbordamiento horizontal.
  Browser plugin no disponible. El guardado de QA no utiliza servicios remotos.
- `pnpm lint` y `pnpm build`. Lint conserva los dos avisos de dependencias de hooks
  ya existentes en CrmPage y useRestaurantController.

Pendiente de aceptación integrada con una cuenta de Stripe sandbox y datos
persistidos en Staging. No se han desplegado cambios ni realizado escrituras en
producción.
