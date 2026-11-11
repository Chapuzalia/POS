# Inicio guiado del CRM

El CRM utiliza Driver.js 1.10.2: `driver()` para los recorridos y un índice React
con temas desplegables. La API de `checklist()` instalada no admite grupos;
no se modifica su DOM interno para simularlos. Se carga en un fragmento diferido del CRM, después de
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

El índice incluye 17 recorridos de entre cuatro y nueve pasos: datos del local,
formatos, organización del TPV, primer producto, creación de mixers, asignación
de mixers/modificadores, creación de modificadores, unidades y equivalencias,
almacenes, artículos de stock, objetivos, recuentos, reposición, consumo por venta,
mesas, dispositivos y usuarios del CRM. El índice muestra el número de pasos.
Se agrupan en cinco temas desplegables: Negocio y equipo, Catálogo y productos,
Mixers y modificadores, Inventario y stock, y Sala y servicio. Inicialmente están
cerrados. Se pueden abrir varios a la vez y conservan su apertura al iniciar una
guía, volver o cerrar y reabrir el índice durante la sesión. Cada tema muestra
guías vistas/guías disponibles; los temas sin guías autorizadas se omiten. El
progreso guardado conserva sus claves e identificadores anteriores.
Cada tema usa los mismos permisos,
funcionalidades y activaciones por local que la navegación normal. Los temas no
disponibles no se muestran. Ambos accesos comparten el manejador de navegación.

La guía de producto abre el editor existente y señala nombre, formato/precio,
ubicación en el TPV y guardado. La ubicación se omite para productos internos.
Las guías de mixers recorren grupo, opciones de producto/variante, suplemento y
cantidades; la asignación al producto recorre tipo de grupo, selección del grupo,
mínimo, máximo, alcance por variante y guardado. Los modificadores tienen su
recorrido de creación y reutilizan el de asignación.

Stock distingue cuatro tareas: crear el artículo y sus rutas, definir objetivos
por almacén sin alterar existencias, establecer el total contado y sumar una
entrada de reposición. «Completar objetivo» propone solo la diferencia respecto
al saldo. La guía de consumo vincula artículo y producto mediante consumo directo
y explica los valores heredados del formato frente a los específicos por variante.
Se añaden los pasos previos de unidades/equivalencias y almacenes.

Los pasos que requieren seleccionar un producto, grupo, artículo o zona mantienen
su explicación hasta que el usuario realiza la acción. No eligen el primer
registro automáticamente. Si falta la selección, la instrucción se muestra en
el propio popover, por encima de la capa del recorrido. Solo se abren
automáticamente formularios nuevos o pestañas de configuración sin guardar.
Las guías no crean datos ni guardan formularios por su cuenta. Las validaciones y
los servicios de escritura siguen siendo los de cada pantalla.

Los objetivos del recorrido usan `data-onboarding`, esperan el contenido diferido
y ofrecen volver al índice si la sección no termina de cargar. Al cambiar de
sección, local, usuario, negocio o al desconectarse se destruye el recorrido
activo. Dentro del editor se puede pausar la guía y continuar trabajando; al
cerrar el formulario se vuelve al índice sin descartar el borrador automáticamente.
El popover se incorpora al ámbito de foco de los modales de catálogo, stock,
unidades, almacenes y usuarios; se identifica como capa de
React Aria para que sus controles permanezcan accesibles. Se respetan el tema
claro/oscuro y la preferencia de movimiento reducido. Los desplegables del CRM
permanecen por encima de la ayuda y sus opciones son interactuables.

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
  Los recorridos mantienen al menos cuatro pasos; se comprueba que no avanzan
  sin la selección requerida, que un control deshabilitado no abre formularios
  y que otro editor o confirmación pausa la ayuda sin bloquearlo.
- Regresión del retorno de Checkout y suites completas del proyecto.
- Playwright con Edge sin interfaz y servicios sustituidos por datos ficticios,
  en 1440×1000 y 390×844: bienvenida, índice, nombre/precio, navegación de pasos,
  guardado mediante el editor, progreso, cambio de tema, reapertura, persistencia
  al recargar y tema oscuro. Sin errores de consola ni desbordamiento horizontal.
  Browser plugin no disponible. El guardado de QA no utiliza servicios remotos.
- Ampliación de QA en ambos tamaños: selección y asignación de mixers con
  mínimo/máximo y variantes; opciones del grupo; unidades, almacenes y artículo;
  objetivo de Barra de 12 a 24 manteniendo el saldo de 8; reposición de 16 hasta
  alcanzar 24; vínculo de consumo directo con artículo existente y cantidad
  específica; recuento total a 20 conservando el objetivo. Las escrituras usan
  servicios locales sustituidos en memoria, sin datos remotos. Sin errores de
  consola ni desbordamiento horizontal. Mesas, ajustes y accesos conservan
  pendiente su aceptación integrada con datos persistidos de Staging.
- `pnpm lint` y `pnpm build`. Lint conserva los dos avisos de dependencias de hooks
  ya existentes en CrmPage y useRestaurantController.
- Índice por temas: pruebas de agrupación única, filtrado por permisos y conteos;
  desplegar/plegar de forma independiente, conservar apertura y lanzar una guía.
  Playwright/Edge en escritorio y móvil: cinco temas cerrados al entrar, guías
  ocultas hasta desplegar, ida/vuelta a una guía, progreso global y por tema,
  reapertura, teclado, tema oscuro, consola limpia y ausencia de desbordamiento.

Pendiente de aceptación integrada con una cuenta de Stripe sandbox y datos
persistidos en Staging. No se han desplegado cambios ni realizado escrituras en
producción.
