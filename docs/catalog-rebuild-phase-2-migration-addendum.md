# Fase 2 — adenda de validación SQL

Esta adenda completa la ruta descrita en `catalog-rebuild-phase-2.md` con las migraciones surgidas de la verificación PostgreSQL final:

- `35.catalog-remove-conflicting-uniqueness.sql` elimina por definición de columnas la unicidad heredada de la migración 29. Esa unicidad ignoraba la variante fijada y habría bloqueado dos colocaciones que solo difirieran por variante. El índice definitivo sigue impidiendo únicamente el duplicado exacto, incluidos valores nulos.
- `36.catalog-final-validation.sql` añade validación de alcance tenant/local y propiedad variante/producto a los objetos reutilizados, además de capacidad activa diferible para modificadores.
- `37.catalog-scope-trigger-correction.sql` separa las ramas del trigger polimórfico para que PostgreSQL no intente resolver campos que no existen en otras tablas.
- `38.catalog-audit-completion.sql` completa auditoría y `updated_at` de imágenes y audita las relaciones de variantes asignadas.

Las cuatro forman parte obligatoria de la secuencia forward-only y fueron compiladas en PostgreSQL 17. Se comprobó dentro de una transacción revertida que una segunda colocación con otra variante fija es aceptada.
