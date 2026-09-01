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
