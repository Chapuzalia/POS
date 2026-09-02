# Recepción de documentos de proveedor

La recepción de albaranes y facturas vive en `Inventario → Entradas`. Los datos
de compra, mappings y documentos son privados del tenant/venue; únicamente la
identidad global del proveedor y las reglas declarativas de lectura se comparten.

## Desarrollo con fixtures

1. Configurar `VITE_SUPPLIER_DOCUMENT_MOCK_MODE=true` en `.env.local`.
2. Configurar el secreto de Edge Functions `SUPPLIER_DOCUMENT_MOCK_MODE=true`.
3. Aplicar la migración y desplegar `process-supplier-document`.
4. Abrir `Inventario → Entradas` y elegir uno de los ocho escenarios.

El flag de frontend está condicionado además por `import.meta.env.DEV`, por lo
que los controles de fixtures no aparecen en una build de producción. La Edge
Function rechaza cualquier `fixtureId` si su propio flag no está habilitado.

## Providers reales

Configurar los siguientes secretos de Supabase Edge Functions:

- `SUPPLIER_DOCUMENT_OCR_PROVIDER`: `azure` o `mistral`. Si no existe, se usa
  `azure` para mantener el comportamiento anterior.
- `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`: endpoint del recurso Azure.
- `AZURE_DOCUMENT_INTELLIGENCE_API_KEY`: clave del recurso Azure.
- `AZURE_DOCUMENT_INTELLIGENCE_API_VERSION`: opcional; por defecto `2024-11-30`.
- `AZURE_DOCUMENT_INTELLIGENCE_MODEL_ID`: opcional; por defecto `prebuilt-layout`.
- `MISTRAL_API_KEY`: clave del proyecto Mistral, obligatoria cuando el provider es
  `mistral`.
- `MISTRAL_OCR_MODEL`: opcional; por defecto `mistral-ocr-latest`.
- `OPENAI_API_KEY`: API key del proyecto OpenAI.
- `OPENAI_SUPPLIER_DOCUMENT_MODEL`: modelo habilitado para Responses API y Structured Outputs.
- `OPENAI_SUPPLIER_DOCUMENT_IMAGE_FALLBACK`: opcional, `true` para adjuntar imagen
  únicamente cuando el OCR tenga baja confianza o no detecte tablas.

Azure se consume mediante `AzureDocumentOcrProvider`, Mistral mediante
`MistralDocumentOcrProvider` y OpenAI mediante `OpenAiSupplierDocumentProvider`.
Todos leen configuración exclusivamente en la Edge Function. Ninguna clave se
expone al navegador o se guarda en tablas. `extraction_metadata` conserva
`ocrProvider` (`azure`, `mistral` o `mock`) y `ocrModel` para comparar ejecuciones.

## Calidad OCR y fallback Mistral → Azure

Mantener `SUPPLIER_DOCUMENT_OCR_PROVIDER=mistral` para usar Mistral como principal.
La selección configurada no se cambia permanentemente. El default histórico de
la factoría cuando falta la variable sigue siendo Azure.

`validateOcrSanity` valida el contenido antes de guardar `ocr_snapshot` o ejecutar
GPT, el parser, matching o generación de perfiles. Es determinista y no consulta
IA. La confianza se guarda como métrica, pero nunca basta para aceptar un OCR.

Los umbrales conservadores detectan corrupción evidente, no validan todos los
datos de la factura:

| Check | Umbral |
| --- | --- |
| Vacío/casi vacío | Menos de 20 caracteres alfanuméricos. |
| Casi solo símbolos | Al menos 100 caracteres y menos del 5 % alfanuméricos. |
| Líneas repetidas | Al menos 1.000 caracteres; líneas con 8 o más alfanuméricos repetidas al menos 12 veces ocupan el 80 % del texto. |
| Diversidad extremadamente baja | Al menos 1.000 caracteres y 30 líneas relevantes; como máximo 10 % únicas, 80 % de texto duplicado y alguna línea alcanza 12 repeticiones. |
| Secuencias/párrafos sin saltos de línea | Al menos 1.500 caracteres; secuencias de 8 palabras con 12 apariciones no solapadas cubren el 85 % de las palabras. |
| Detecciones visuales serializadas | Al menos 3 objetos con `box_2d`, `label` y `caption` ocupan el 60 % del texto. Llaves aisladas no bastan. |

Se normalizan espacios y mayúsculas. El texto agregado y sus páginas no se suman
como si fueran contenido distinto. En documentos multipágina, el mínimo global
de repeticiones es `max(12, 4 × páginas)`; también se comprueba cada página para
que otras páginas válidas no oculten una página corrupta. Una página final vacía
o una cabecera repetida 2–3 veces no invalidan por sí solas el documento.

Si Mistral pasa, no se construye ni llama a Azure. Si es rechazado por contenido o
devuelve una estructura ilegible, se realiza un único intento Azure usando las
variables existentes y `prebuilt-layout` por defecto. Azure pasa exactamente el
mismo sanity check. No hay un tercer intento ni fallback inverso. Errores de
disponibilidad/autenticación no se confunden con corrupción ni generan una
llamada adicional a Azure; se registra un código interno sin cuerpo HTTP ni
secretos. Si el fallback falla, tampoco se expone su error técnico al usuario.

Solo el OCR aceptado se guarda en `ocr_snapshot`. `extraction_metadata` conserva
`ocrProvider` (o `null` si ninguno fue aceptado), `ocrFallbackUsed`,
`ocrSanityVersion` y `ocrAttempts`. Cada intento contiene `provider`, `accepted`,
`sanityReasons` y métricas numéricas de tamaño, diversidad, repeticiones y
estructura, incluidas las páginas sospechosas. No se guarda el texto rechazado
en esos diagnósticos. Estos datos sobreviven también a un error posterior del
parser.

Si no se obtiene OCR aceptable, el documento queda en `status=error`, con
`code=OCR_QUALITY_TOO_LOW` y sin snapshot utilizable. No se ejecutan las etapas
posteriores. La revisión muestra un mensaje de nueva captura y **Volver a
escanear**, que abre la captura existente sin reenviar automáticamente la misma
imagen. No requiere migraciones adicionales.

## Comprobación al conectar providers

1. Subir una imagen o PDF real desde móvil.
2. Verificar que el documento pasa de `processing` a `review`.
3. Revisar `extraction_metadata`: provider OCR, confianza, tablas y modo parser.
4. Probar un formato conocido para confirmar `parserMode=deterministic`.
5. Probar uno desconocido para confirmar `parserMode=ai` y, si las validaciones
   matemáticas coinciden, la creación de un perfil `candidate`.
6. Resolver líneas, decidir costes y confirmar; repetir la confirmación para
   comprobar que devuelve `duplicate=true` sin volver a sumar stock.

La extracción de texto PDF nativo está abstraída mediante
`NativePdfTextExtractor`. La implementación actual devuelve `null` y delega el
PDF completo en el provider OCR seleccionado hasta que se seleccione una
librería/servicio de extracción de texto nativo para Edge Functions.
