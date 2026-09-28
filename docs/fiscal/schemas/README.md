# Esquemas AEAT fijados para revisión local

Descargados de los enlaces oficiales de la [página de esquemas de AEAT](https://www.agenciatributaria.es/AEAT.desarrolladores/Desarrolladores/_menu_/Documentacion/Sistemas_Informaticos_de_Facturacion_y_Sistemas_VERI_FACTU/Esquemas_de_los_servicios_web/Esquemas_de_los_servicios_web.html) el **28/09/2026**, ruta `tikeV1.0`:

| Fichero | SHA-256 |
| --- | --- |
| `SuministroInformacion-v1.0.xsd` | `EE4C1655175644DE44C4C25055FFEB8E5F4BB4BC3834CE8254D4222EF18C8AA1` |
| `SuministroLR-v1.0.xsd` | `CBDAC8D427CC5AB5D77CA48974CAB0F35D6BB819C4C66DB361681E3710AEBA36` |
| `xmldsig-core-schema.xsd` | `D102AD3DF7664C307E0C2C776BA4A90513B1969974D8A940BAE1A77F9F21E15D` |

La tercera dependencia procede del [XSD XML Signature de W3C](https://www.w3.org/TR/xmldsig-core/xmldsig-core-schema.xsd), importado por `SuministroInformacion.xsd`. Se descargó en la misma fecha. `scripts/test-verifactu-xsd.ps1` comprueba muestras F1, F2 y anulación generadas por `canonical.ts` con `System.Xml.Schema.XmlSchemaSet` de .NET. Esta comprobación de muestras no sustituye la validación local completa en la PWA ni las validaciones de negocio de AEAT.

Son recursos de referencia congelados. `canonical.ts` implementa una validación estructural local **parcial** basada en estos tipos; tener estos XSD en el repositorio no significa que el navegador los ejecute ni que se superen todas las reglas de AEAT. Cada actualización debe conservar la versión anterior para interpretar registros ya expedidos, comparar cambios y añadir vectores de conversión y validación antes de cambiar el esquema canónico.
