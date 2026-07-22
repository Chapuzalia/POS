# Reconstrucción del catálogo — fase 2

## Resultado

La fase 2 deja un destino final comprobable sin cambiar el catálogo que consumen el CRM y el TPV. El catálogo **Mess** se empaquetó, importó dos veces en PostgreSQL 17 aislado y comparó semánticamente con el origen. Resultado: `EXPECTED_NORMALIZATION`, sin diferencias funcionales.

No se escribió en la base productiva. Las únicas lecturas remotas fueron el snapshot previo y la descarga de 57 imágenes desde Storage. El local de validación fue el UUID ficticio `11111111-1111-4111-8111-111111111111` dentro del contenedor `pos-catalog-phase2`.

## Contrato congelado

El contrato formal está en `scripts/catalog-rebuild/schema/catalog-export.schema.json` y su validación runtime en `scripts/catalog-rebuild/lib/contract.mjs`.

- `format`: `club-pos-catalog-export`.
- `schemaVersion`: `2`.
- Las entidades funcionales son estrictas (`additionalProperties: false`).
- Solo `metadata`, `trace` y `source` admiten trazabilidad abierta.
- Los suplementos admiten enteros entre -100.000.000 y 100.000.000.
- El precio base de variante no puede ser negativo.
- Las referencias se validan semánticamente, incluidas propiedad variante/producto, alcance local, menús anidados, variante predeterminada activa y capacidad.
- Un cambio futuro de estructura exige incrementar `schemaVersion`.

La versión aumentó desde el borrador 1 porque el contrato cambió: `categories[].unused` y los campos de archivo/checksum de `images[]` son nuevos. El adaptador de `upgradeDraftExport` permite usar el backup preliminar de fase 1 sin modificarlo.

## ZIP autocontenido

`backups/mess-catalog.zip` contiene:

```text
catalog.json
conversion-report.md
manifest.json
images/image_0001.webp
...
images/image_0057.webp
```

El manifest guarda `ref`, `productRef`, ruta interna, MIME detectado desde el binario, tamaño, SHA-256, ausencia y deduplicación. El importador vuelve a calcular checksum y tamaño antes de cualquier escritura. Binarios iguales comparten archivo. No se guardan claves ni URLs firmadas.

Mess: 57 imágenes copiadas, 0 ausentes, 57 binarios únicos y ZIP de 510.873 bytes.

## Esquema SQL y migración 29

La ruta forward-only es:

- `30.catalog-rebuild-migration.sql`: transforma objetos compatibles, crea relaciones finales, constraints, triggers diferibles, auditoría, RLS e `import_catalog`.
- `31.catalog-export-function.sql`: exporta semántica final para comparación sin reutilizar UUID como identidad.
- `32.catalog-history-decoupling.sql`: elimina FK desde comandas abiertas al catálogo mutable, conservando los UUID snapshot.
- `33.catalog-final-permissions.sql` y `34.catalog-base-permissions.sql`: grants mínimos coherentes con RLS.

Estrategia sobre la 29:

- Se reutilizan `products`, `product_variants`, `categories`, `catalog_tabs`, `catalog_placements`, `selection_groups`, `modifier_groups`, `modifiers`, `ticket_lines` y componentes históricos.
- Se transforman en sitio: categoría por local, variante con local, colocación con categoría/variante opcionales, grupo modificador reutilizable y suplemento firmado.
- Se crean las relaciones definitivas que la 29 no tenía: `catalog_tab_categories`, `selection_group_options`, asignaciones de selección/modificadores y sus variantes.
- `selection_group_items`, `variant_selection_groups`, `product_modifier_groups`, `catalog_placements.default_variant_id`, `modifier_groups.product_id` y los campos funcionales antiguos quedan marcados como transitorios. No se usan en la importación final y se eliminarán en el corte de fase 3.
- `sale_formats` no se persiste en el destino funcional.
- No se modificó la migración 29 ni ninguna migración ya desplegable.

El baseline consolidado preexistente tiene un defecto de orden: `0.complete-database.sql` declara dos funciones que usan `orders` antes de que la migración 1 cree la tabla. `validate-isolated.ps1` divide mecánicamente ese baseline en el punto conocido, aplica la migración 1 y continúa en orden numérico. No altera el archivo histórico.

## Importador

`import_catalog` bloquea la fila del local y ejecuta todo el cambio SQL en una transacción. El cliente valida contrato/ZIP, genera UUID nuevos, resuelve relaciones por `ref`, prepara imágenes con rutas nuevas y llama una única RPC. Si la RPC falla, elimina las imágenes preparadas. Tras éxito elimina los binarios sustituidos.

Solo existen `empty` y `replace`:

- `empty` cuenta configuración y aborta antes de escribir si hay datos.
- `replace` elimina exclusivamente configuración del local destino y reconstruye el catálogo.
- `--dry-run` valida, resuelve, normaliza, simula conteos y genera informe sin escritura ni subida.

Los UUID de tickets, comandas y sus snapshots no tienen FK al catálogo vivo. La prueba real preservó una comanda abierta, su línea, un ticket y su línea a través de `replace`; también preservó los UUID snapshot no nulos.

## Normalización Mess

El JSON no se modifica. El plan importado normalizó 642 órdenes:

| Colección | Cambios |
|---|---:|
| products | 116 |
| variants | 217 |
| tabs | 7 |
| tabCategories | 18 |
| placements | 209 |
| selectionGroupOptions | 11 |
| selectionAssignments | 64 |

Se desactivaron 18 asignaciones porque su producto estaba inactivo; no se excluyó ninguna variante. Se conservó `Otros` como categoría no utilizada y no se asoció automáticamente a pestañas.

## Conteos reconstruidos

| Entidad | Origen | Destino |
|---|---:|---:|
| categories | 10 | 10 |
| tabs | 7 | 7 |
| tabCategories | 21 | 21 |
| products | 116 | 116 |
| variants | 217 | 217 |
| placements | 213 | 213 |
| selectionGroups | 2 | 2 |
| selectionGroupOptions | 12 | 12 |
| selectionAssignments | 64 | 64 |
| modifierGroups / modifiers / assignments | 0 | 0 |
| images | 57 | 57 |

El ZIP valida con `ERROR 0`, `WARNING 18`, `INFO 6`. Los avisos son las 18 asignaciones incoherentes que la regla aprobada desactiva. El comparador devuelve `EXPECTED_NORMALIZATION` y cero colecciones diferentes.

## Comandos

Exportación:

```powershell
node scripts/catalog-rebuild/export-catalog.mjs `
  --source .\backups\mess-catalog.json `
  --report .\backups\mess-conversion.md `
  --out .\backups\mess-catalog.zip
```

El proxy local de este entorno usa un certificado no confiable; solo aquí fue necesario anteponer `$env:NODE_TLS_REJECT_UNAUTHORIZED='0'` al proceso de descarga.

Validación y dry run:

```powershell
node scripts/catalog-rebuild/validate-catalog.mjs --file .\backups\mess-catalog.json

node scripts/catalog-rebuild/import-catalog.mjs `
  --file .\backups\mess-catalog.zip `
  --venue '<venue_uuid>' `
  --mode replace `
  --dry-run
```

Importación:

```powershell
node scripts/catalog-rebuild/import-catalog.mjs `
  --file .\backups\mess-catalog.zip `
  --venue '<venue_uuid>' `
  --mode empty
```

Comparación:

```powershell
node scripts/catalog-rebuild/compare-catalogs.mjs `
  --source .\backups\mess-catalog.json `
  --venue '<venue_uuid>'
```

Migración directa usando la misma conversión, archivo y plan:

```powershell
node scripts/catalog-rebuild/migrate-current-catalog.mjs `
  --source-venue '<source_venue_uuid>' `
  --venue '<target_venue_uuid>' `
  --mode empty
```

Base aislada:

```powershell
docker run --name pos-catalog-phase2 `
  -e POSTGRES_PASSWORD=catalog_test `
  -e POSTGRES_DB=pos_catalog_test `
  -p 127.0.0.1:55432:5432 `
  -d postgres:17-alpine

powershell -ExecutionPolicy Bypass -File scripts/catalog-rebuild/validate-isolated.ps1
```

## Verificación ejecutada

- 15 pruebas nuevas de contrato, ZIP, checksum, referencias, normalización, modos, dry run, rollback, aislamiento, UUID, repetibilidad, migración directa y comparación.
- Migraciones compiladas y ejecutadas en PostgreSQL 17 aislado.
- RLS comprobado con usuario cashier asignado a un único local.
- Relación cruzada de local rechazada por FK compuesta.
- `empty` sobre catálogo poblado devolvió `CATALOG_NOT_EMPTY` y mantuvo 116 productos y el ticket.
- Plan inválido falló después del borrado lógico; el rollback mantuvo 116 productos, una comanda y un ticket.
- Segundo `replace` mantuvo comanda abierta, ticket y UUID snapshots.
- `pnpm run build`: correcto. Solo permanece el aviso preexistente de tamaño de chunk de Vite.

## Fase 3 propuesta

1. Congelar despliegue y ejecutar backup/dry run por local.
2. Adaptar servicios CRM al esquema final detrás de un punto de corte, sin doble escritura permanente.
3. Adaptar `catalogAccess.ts` y las RPC canónicas al modelo final y ejecutar pruebas de venta/cobro completas.
4. Cambiar lectura por local de forma controlada, comparar telemetría y mantener rollback por backup ZIP.
5. Cuando todos los consumidores usen el destino, eliminar objetos transitorios de la 29, campos funcionales antiguos, fallback y herramientas de `scripts/catalog-rebuild/`.
