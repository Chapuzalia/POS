import type { DriveStep, Driver } from 'driver.js'
import { notifyOperationalError } from '../../../utils/notifications'
import type { OnboardingTopic } from './onboardingModel'

const target = (name: string) => `[data-onboarding="${name}"]`
const step = (name: string, title: string, description: string, popover?: DriveStep['popover']): DriveStep => ({ element: target(name), popover: { title, description, ...popover }, waitForElement: 8000 })

function explainPendingAction(driver: Driver, message: string) {
  const description = driver.getState().popover?.description
  if (!description) { notifyOperationalError(message); return }
  let hint = description.querySelector<HTMLElement>('[data-onboarding-hint]')
  if (!hint) {
    hint = document.createElement('p')
    hint.dataset.onboardingHint = 'true'
    hint.setAttribute('role', 'status')
    hint.className = 'mt-3 font-semibold text-[var(--crm-blue)]'
    description.appendChild(hint)
  }
  hint.textContent = message
}

// Wait for the user's selection. Never submit forms or create business data.
export function continueWhen(selector: string, message: string): NonNullable<DriveStep['popover']>['onNextClick'] {
  return (_element, _step, { driver }) => {
    if (document.querySelector(selector)) driver.moveNext()
    else explainPendingAction(driver, message)
  }
}
const choose = (name: string, title: string, description: string, next: string, message: string) => step(name, title, description, { nextBtnText: 'Continuar', onNextClick: continueWhen(target(next), message) })
const open = (name: string, title: string, description: string): DriveStep => step(name, title, description, {
  nextBtnText: 'Abrir formulario', onNextClick: (element, _step, { driver }) => {
    if (element instanceof HTMLButtonElement && !element.disabled) { element.click(); driver.moveNext() }
    else explainPendingAction(driver, 'Este formulario todavía no está disponible. Revisa los requisitos y espera a que termine de cargar.')
  },
})
const firstField = { disableButtons: ['previous'] } satisfies DriveStep['popover']
const selectProduct = (next: string) => choose('product-list', 'Elige el producto que vas a configurar', 'Busca el producto y pulsa Editar. Elige tú el producto correcto y después pulsa Continuar. Si aún no existe, créalo primero desde el índice.', next, 'Abre la ficha de un producto con Editar antes de continuar.')
const selectItem = () => choose('stock-overview', 'Abre el artículo y su almacén', 'Busca el artículo en Todas las existencias y pulsa su nombre o Ver stock. Comprueba el almacén de la fila y después pulsa Continuar. Si no hay artículos, crea uno desde el índice.', 'stock-detail', 'Abre la ficha de un artículo antes de continuar.')

export function getOnboardingSteps(topic: OnboardingTopic): DriveStep[] {
  switch (topic.id) {
    case 'products': return [
      open('product-create', 'Crea tu primer producto', 'Necesitas un formato activo y, para mostrarlo en el TPV, una pestaña y categoría. Puedes prepararlos desde el índice. Abriremos el formulario sin guardar datos.'),
      step('product-name', '1. Ponle un nombre', 'Escribe, por ejemplo, Gin tonic. El nombre identifica el producto del catálogo, no su formato. Puedes completar también la descripción.', firstField),
      step('product-tax', '2. Revisa el IVA', 'Se propone el IVA del local. Comprueba si corresponde y elige IVA personalizado solo cuando necesite otro tipo. Se aplicará a las futuras ventas del producto.'),
      step('product-variants', '3. Formato y precio', 'Elige Copa e introduce su precio final. Configuración avanzada de variantes permite otros formatos con precios distintos. Mantén una variante activa y predeterminada.'),
      { ...step('product-placement', '4. Colócalo en el TPV', 'Selecciona pestaña y categoría, por ejemplo Bebidas y Combinados. Destacado lo resalta. Un producto interno no tendrá aparición inicial en el TPV.'), skipMissingElement: true },
      step('product-save', '5. Revisa y crea el producto', 'Comprueba nombre, IVA, precio y ubicación. Pulsa Crear producto para guardar y corrige cualquier validación. Terminar guía cierra esta ayuda; no guarda por ti. Después podrás asignar mixers y configurar el consumo desde sus guías.'),
    ]
    case 'mixers': return [
      step('group-name', '1. Nombra el grupo de mixers', 'Crea antes los productos que serán opciones, como Tónica y Cola. Escribe un grupo reutilizable, por ejemplo Refresco del combinado. Podrás compartirlo entre varios productos.'),
      step('group-create', '2. Crea el grupo', 'Pulsa Crear grupo. Esto todavía no añade opciones ni asigna el grupo a un producto. Si ya tienes uno preparado, puedes utilizarlo.'),
      choose('group-list', '3. Selecciona el grupo', 'Pulsa el nombre del grupo recién creado o uno existente para abrir sus opciones. Después pulsa Continuar.', 'group-options', 'Selecciona un grupo de mixers antes de continuar.'),
      step('mixer-product', '4. Elige producto y variante', 'Busca o filtra el refresco, por ejemplo Tónica. Selecciona su variante concreta o deja Variante predeterminada. Las opciones de mixers usan productos existentes del catálogo.'),
      step('option-supplement', '5. Configura el suplemento', 'Indica 0,00 si está incluido en el combinado. Para una opción premium puedes indicar, por ejemplo, 0,50 €. El suplemento se suma al elegir esa opción.'),
      step('mixer-quantities', '6. Cantidades de esta opción', 'Predeterminada 0 no preselecciona unidades. Máxima 1 permite una unidad de esta opción. No confundas estos límites con el mínimo y máximo del grupo que configurarás al asignarlo.'),
      step('option-save', '7. Guarda y repite las opciones', 'Pulsa Añadir opción y comprueba que aparece debajo. Repite con Cola y los demás refrescos, revisando variante, suplemento y cantidades.'),
      step('group-options', '8. Continúa con la asignación', 'Ahora abre Asignar mixers al producto desde el índice para vincular el grupo a Gin tonic. Allí decidirás si elegir es obligatorio, cuántas opciones se permiten y a qué variantes se aplica.'),
    ]
    case 'product-mixers': return [
      selectProduct('product-assignments'),
      step('product-assignment-type', '1. Tipo de grupo', 'En Mixers y modificadores asignados elige Mixers para los refrescos. Para opciones como Sin hielo elige Modificadores. El grupo debe existir y estar activo.', firstField),
      step('product-assignment-group', '2. Elige el grupo', 'Selecciona Refresco del combinado u otro grupo preparado. Si no aparece, revisa que está activo y que has elegido el tipo correcto. Los grupos no se asignan automáticamente.'),
      step('assignment-min', '3. Selección obligatoria u opcional', 'Mínimo 0 hace opcional la elección. Mínimo 1 obliga a elegir al menos una opción. Para un combinado que necesita un refresco puedes usar mínimo 1.'),
      step('assignment-max', '4. Máximo de elecciones', 'Máximo 1 permite un único refresco. Un máximo mayor permite varias selecciones dentro de la capacidad de las opciones. Debe ser compatible con el mínimo y las opciones disponibles.'),
      step('product-assignment-variant', '5. Variantes a las que se aplica', 'Elige Todas las variantes o un formato concreto. Por ejemplo, aplica el refresco a Copa sin incluirlo al vender Botella.'),
      step('assignment-save', '6. Guarda y comprueba', 'Pulsa Asignar grupo. Debajo aparecerán el grupo, el rango mínimo–máximo y sus variantes. Este botón guarda la asignación; Guardar información de la parte superior no sustituye este paso.'),
    ]
    case 'modifiers': return [
      step('group-name', '1. Nombra el grupo', 'Escribe Hielo, Punto de cocción o Extras. El modificador se define con texto, a diferencia del mixer que selecciona un producto del catálogo.'),
      step('group-create', '2. Crea el grupo', 'Pulsa Crear grupo y selecciona después su nombre en la lista para completar sus opciones.'),
      choose('group-list', '3. Selecciona el grupo', 'Abre el grupo que quieres completar y pulsa Continuar.', 'group-options', 'Selecciona un grupo de modificadores antes de continuar.'),
      step('modifier-name', '4. Nombra la opción', 'Escribe una opción clara para el personal, por ejemplo Sin hielo. Cada opción se añade por separado.'),
      step('option-supplement', '5. Suplemento y selección inicial', 'Indica 0,00 si no cambia el precio o el recargo de un extra. Marca Seleccionado por defecto solo si debe aparecer elegido inicialmente.'),
      step('option-save', '6. Guarda y asigna', 'Pulsa Añadir modificador y repite para las demás opciones. Después abre Asignar mixers al producto en el índice, elige Modificadores y configura grupo, límites y variantes.'),
    ]
    case 'inventory-units': return [
      open('unit-create', '1. Prepara la unidad física', 'Define cómo contarás el artículo: ud para botellines, ml para líquidos o g para ingredientes. Abriremos Nueva unidad.'),
      step('unit-name', '2. Nombre y abreviatura', 'Escribe Mililitros y ml, o Unidad y ud. La abreviatura aparecerá junto a las existencias.', firstField),
      step('unit-decimals', '3. Decimales permitidos', 'Usa cantidades enteras para unidades indivisibles y decimales si necesitas fracciones. La precisión debe servir para comprar, consumir y contar el artículo.'),
      step('unit-equivalence', '4. Base o contenido del envase', 'Para crear ml usa 1 de La propia unidad. Para Botella 70 cl crea primero ml y configura después 700 Mililitros como equivalencia. Esta equivalencia no es el consumo de una venta.'),
      step('unit-save', '5. Guarda y revisa', 'Pulsa Crear unidad. Comprueba nombre, abreviatura, equivalencia y precisión en la lista. Después podrás elegirla como unidad física del artículo de stock.'),
    ]
    case 'inventory-warehouses': return [
      open('warehouse-create', '1. Crea una ubicación física', 'Prepara un almacén por ubicación que necesites controlar, como Barra y Reserva. Pertenecerá al local seleccionado.'),
      step('warehouse-name', '2. Nombre del almacén', 'Escribe un nombre claro, como Barra principal. Ayudará a distinguir dónde contar y reponer las existencias.', firstField),
      step('warehouse-description', '3. Describe su uso', 'Indica ubicación o finalidad, por ejemplo Bebidas listas para el servicio. Así distinguirás una reserva del almacén desde el que se vende.'),
      step('warehouse-save', '4. Guarda y asigna los artículos', 'Pulsa Crear almacén. Después activa esta ubicación en los artículos y configura prioridad y objetivo. Crear el almacén no registra existencias ni asigna todos los artículos.'),
    ]
    case 'inventory-stock': return [
      open('stock-create', '1. Crea el artículo físico', 'Necesitas una unidad física y un almacén activos; prepara ambos desde el índice. El artículo representa lo que cuentas y es distinto del producto de venta.'),
      step('item-name', '2. Identifica el artículo', 'Escribe un nombre reconocible para el recuento, por ejemplo Botellín Tónica. Completa su descripción y mantén Artículo activo para utilizarlo.', firstField),
      step('item-unit', '3. Elige la unidad física', 'Selecciona ud para botellines o ml para líquidos, según cómo los cuentes. No podrás cambiar la unidad mientras haya existencias.'),
      choose('item-routes', '4. Activa sus almacenes', 'Marca cada almacén donde se controlará el artículo. Activa al menos uno antes de continuar; sus campos de prioridad y objetivo se habilitarán.', 'item-priority-enabled', 'Activa al menos un almacén del artículo antes de continuar.'),
      step('item-priority-enabled', '5. Orden de consumo', 'Una prioridad menor se consume primero. Ejemplo: Barra con prioridad 1 y Reserva con prioridad 2. Revisa el orden en todas las filas activas.'),
      step('item-target-enabled', '6. Objetivo por almacén', 'Indica cuánto quieres mantener: 24 ud en Barra y 72 ud en Reserva, por ejemplo. Vacío es sin objetivo. El objetivo NO introduce existencias reales.'),
      step('item-save', '7. Guarda la configuración', 'Pulsa Crear artículo. Después utiliza Registrar las existencias iniciales para introducir el recuento físico. La creación y el objetivo no sustituyen ese recuento.'),
    ]
    case 'stock-targets': return [
      selectItem(),
      open('stock-config', '1. Abre Configurar artículo', 'El objetivo está en la configuración del artículo por almacén. No cambies el stock real para modificar cuánto quieres mantener.'),
      choose('item-routes', '2. Revisa los almacenes', 'Activa las ubicaciones donde controlas este artículo. Comprueba su unidad física y las filas que vas a reponer.', 'item-priority-enabled', 'Activa al menos un almacén para definir su objetivo.'),
      step('item-priority-enabled', '3. Orden de consumo', 'Asigna prioridades coherentes, por ejemplo 1 para Barra y 2 para Reserva. La prioridad y el objetivo cumplen funciones diferentes.'),
      step('item-target-enabled', '4. Define cuánto quieres mantener', 'Escribe el objetivo de cada ubicación en la unidad física del artículo. Para mantener 24 botellines en Barra, escribe 24 en esa fila. Vacío significa sin objetivo; 0 es un objetivo explícito de cero.'),
      step('item-save', '5. Guarda sin alterar el saldo', 'Pulsa Guardar artículo. Se conservan las existencias reales. Al volver al listado verás la cobertura y cuánto falta. Utiliza Reponer hasta el objetivo para registrar una entrada real.'),
    ]
    case 'stock-count': return [
      selectItem(),
      step('stock-totals', '1. Cuenta por almacén', 'Cuenta físicamente las existencias de cada almacén activo. No copies el objetivo como si fuera el saldo real.'),
      step('stock-total-input', '2. Introduce el TOTAL contado', 'Si había 8 y ahora cuentas 20, escribe 20, no 12. Repite en los almacenes que cambien y respeta la unidad y sus decimales.'),
      step('stock-totals', '3. Revisa el resultado', 'Comprueba Quedará en cada fila. Solo se guardan los almacenes modificados. Si otro terminal cambia el saldo, actualiza y revisa el recuento para no sobrescribir su movimiento.'),
      step('stock-save', '4. Guarda el recuento', 'Pulsa Guardar total cuando sea correcto. Esto modifica las existencias reales. Para sumar mercancía recibida usa Reponer: allí se indica la entrada, no el total final.'),
    ]
    case 'stock-replenishment': return [
      choose('stock-overview', '1. Elige dónde reponer', 'Busca la fila del artículo y almacén y pulsa Reponer. El objetivo puede ser diferente por ubicación. Después pulsa Continuar.', 'replenishment-form', 'Pulsa Reponer en la fila del artículo y almacén antes de continuar.'),
      step('replenishment-current', '2. Revisa saldo y objetivo', 'Comprueba el disponible y el objetivo de ese almacén. La diferencia orienta la reposición, pero aún no registra una entrada.'),
      step('replenishment-quantity', '3. Cantidad recibida', 'Escribe lo que realmente ha llegado. Puedes usar los botones rápidos o Completar objetivo si aparece. Con 8 disponibles y objetivo 24, propone una entrada de 16.'),
      step('replenishment-result', '4. Resultado previsto', 'Existencias tras la entrada suma la cantidad al disponible. Si otro terminal consume, el resultado definitivo puede variar. Todavía no se ha guardado.'),
      step('replenishment-save', '5. Confirma la entrada', 'Pulsa Confirmar reposición solo si has recibido la mercancía. Comprueba el saldo y cobertura al volver. Se suma la entrada; el objetivo no cambia.'),
    ]
    case 'product-inventory': return [
      selectProduct('product-inventory'),
      choose('product-inventory', '1. Selecciona Consumo directo', 'Para descontar un artículo físico al vender, elige Consumo directo. Si tu plan incluye Escandallo, ese modo permite varios ingredientes. Esta guía recorre el consumo directo.', 'product-direct', 'Selecciona Consumo directo para continuar.'),
      step('product-direct-item', '2. Vincula el artículo físico', 'Selecciona el artículo ya creado, por ejemplo Tónica. Crear automáticamente crea otro al guardar: úsalo solo si no existe para evitar duplicados.'),
      step('product-direct-variants', '3. Consumo por variante', 'Una unidad de refresco puede consumir 1 ud y una copa de destilado 50 ml. Revisa cada variante activa; no confundas cantidad consumida con precio.'),
      step('product-direct-variants', '4. Heredado o específico', 'Usar predeterminado toma el consumo de Formatos. Si no está configurado, vuelve a esa guía o desmarca la casilla e indica aquí cantidad y unidad por variante.'),
      step('product-direct-save', '5. Guarda el vínculo', 'Pulsa Guardar consumo directo y comprueba la confirmación. Es un guardado independiente de Guardar información. El artículo también necesita almacenes y existencias.'),
    ]
    case 'formats': return [
      step('formats-page', '1. Nombra el formato', 'Escribe Unidad, Copa o Ración. Se reutiliza en distintos productos; el precio se configura después en cada variante.'),
      choose('format-create', '2. Crea o utiliza uno existente', 'Pulsa Añadir formato o utiliza uno ya preparado. Para continuar debe existir al menos un formato en la lista.', 'format-row', 'Crea al menos un formato de venta antes de continuar.'),
      step('format-row', '3. Revisa estado y orden', 'Mantén activo el formato que vas a usar. Las flechas ajustan el orden y Editar cambia el nombre. Después podrás elegirlo en el producto.'),
      { ...step('format-consumption', '4. Consumo por venta', 'Con inventario indica cantidad y unidad: Copa consume 50 ml, o Unidad consume 1 ud. Guarda con el botón de esa fila. Los productos con Usar predeterminado heredarán estos valores.'), skipMissingElement: true },
      step('formats-page', '5. Utilízalo en tu catálogo', 'Vuelve al índice, crea el producto y asigna el formato y su precio. Para descontar stock completa también Descontar stock al vender.'),
    ]
    case 'categories': return [
      step('category-create', '1. Crea la categoría', 'Escribe Refrescos o Combinados y pulsa Añadir. Una categoría es del local y puede aparecer en varias pestañas sin duplicarla.'),
      step('tab-create', '2. Prepara la pestaña', 'Crea una pestaña como Bebidas. Organiza la navegación del TPV. Puedes editar su icono y ordenar las pestañas con las flechas.'),
      step('category-association', '3. Vincula categoría y pestaña', 'En Categorías dentro de cada pestaña elige Bebidas y Refrescos y pulsa Asociar. Crear ambas por separado no las vincula.'),
      step('category-association-list', '4. Orden y visibilidad', 'Comprueba la categoría bajo su pestaña. Las flechas cambian su orden y el control de visibilidad permite mostrarla u ocultarla.'),
      step('categories-page', '5. Coloca los productos', 'Al crear o editar el producto asigna su aparición a esta pestaña y categoría. Crear la categoría no añade productos por sí solo. Continúa con Tu primer producto desde el índice.'),
    ]
    case 'tables': return [
      step('tables-enable', '1. Revisa la operativa de mesas', 'Comprueba que está activa en este local. El plano se organiza por zonas, como Sala y Terraza.'),
      step('tables-zone', '2. Crea una zona', 'Escribe Sala o Terraza y pulsa Crear zona. Si ya existe, selecciónala en la lista para trabajar en su plano.'),
      choose('tables-zone', '3. Abre el plano', 'Crea o selecciona la zona que quieres preparar y pulsa Continuar.', 'table-new', 'Crea o selecciona una zona antes de continuar.'),
      choose('table-new', '4. Añade o selecciona una mesa', 'Pulsa Nueva mesa o selecciona una existente en el plano. Nueva mesa la guarda inmediatamente: úsalo solo si necesitas crear otra. Después pulsa Continuar.', 'table-name', 'Crea una mesa o selecciona una del plano antes de continuar.'),
      step('table-name', '5. Nombre para el servicio', 'Pon un identificador como Mesa 1 o T1. Comprueba que editas la mesa correcta de la zona seleccionada.'),
      step('table-capacity', '6. Capacidad', 'Indica cuántas personas admite la mesa. Debe ser mayor que cero y corresponder a la distribución real.'),
      step('table-shape', '7. Forma de la mesa', 'Selecciona cuadrada, rectangular o redonda para que el equipo reconozca mejor el plano.'),
      step('table-save', '8. Guarda los datos', 'Pulsa Guardar para conservar nombre, capacidad y forma. Puedes preparar otra con Nueva mesa o Duplicar, revisando sus datos.'),
      step('table-map', '9. Distribuye la sala', 'Arrastra las mesas y ajusta su tamaño con la esquina. Los movimientos se guardan al terminar el arrastre. Puedes añadir paredes, columnas o textos como referencias.'),
    ]
    case 'settings': return [
      choose('settings-venues', '1. Abre la ficha del local', 'Pulsa el nombre del local para desplegar su configuración. Si tienes varios, comprueba cuál editas y pulsa Continuar.', 'settings-form', 'Despliega la ficha de un local antes de continuar.'),
      step('settings-name', '2. Nombre comercial', 'Revisa el nombre y el orden en el selector. Utiliza nombres que el equipo pueda distinguir.'),
      step('settings-fiscal', '3. Datos fiscales', 'Comprueba razón social, NIF/CIF y dirección con los datos reales del negocio antes de guardar.'),
      step('settings-tax', '4. IVA predeterminado', 'Será el propuesto al crear productos. Cada producto puede tener otro IVA cuando corresponda; revísalo al crear su ficha.'),
      step('settings-day', '5. Cambio de día operativo', 'Revisa la hora si el servicio acaba de madrugada. Vacío utiliza días naturales y cambio a medianoche.'),
      step('settings-save', '6. Guarda el local', 'Pulsa Guardar local para los datos generales. Los addons se guardan al instante con sus controles. Después vuelve al índice para preparar el catálogo.'),
    ]
    case 'access': return [
      step('device-form', '1. Prepara un terminal', 'El dispositivo tendrá credenciales propias y pertenecerá al local indicado. No es una cuenta personal de acceso al CRM.'),
      step('device-name', '2. Identifica el puesto', 'Escribe Caja barra o iPad terraza. Evita nombres indistinguibles si utilizarás varios terminales.'),
      step('device-mode', '3. Modo de trabajo', 'Caja se orienta al cobro, Satélite a tomar pedidos e Híbrido combina ambas funciones. Elige el modo que necesita este puesto.'),
      step('device-save', '4. Crea el dispositivo', 'Pulsa Crear dispositivo y revisa las credenciales mostradas. Entrégalas al terminal correspondiente. No lo sustituyas por la cuenta Owner.'),
      step('device-form', '5. Acceso de otras personas al CRM', 'Para una persona que administrará el negocio, el propietario puede usar Crear un usuario del CRM en el índice. Es un flujo distinto al alta de un terminal.'),
    ]
    case 'users': return [
      open('user-create', '1. Añade una persona al CRM', 'Esta cuenta es para administrar el CRM. Para los puestos del TPV utiliza dispositivos. Solo el propietario puede crear usuarios CRM.'),
      step('user-email', '2. Correo de acceso', 'Introduce el correo de la persona y comprueba su escritura antes de guardar.', firstField),
      step('user-password', '3. Contraseña inicial', 'Configura una contraseña válida según el formulario y entrégala por un canal adecuado. La guía no registra su contenido.'),
      step('user-role', '4. Selecciona el rol', 'Manager administra los locales asignados. Owner tiene acceso de propietario al negocio. Asigna el rol mínimo necesario.'),
      { ...step('user-venues', '5. Locales del Manager', 'Marca los locales donde trabajará. El Manager necesita esas asignaciones para acceder a sus datos. Un Owner no utiliza esta selección.'), skipMissingElement: true },
      step('user-save', '6. Guarda y revisa', 'Pulsa Crear usuario y comprueba que aparece con rol y locales correctos. No reutilices esta cuenta como credencial de un dispositivo.'),
    ]
  }
}
