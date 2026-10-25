# Tests funcionales y cobros Cashlogy

**Objetivo:** retirar comprobaciones de código fuente y presentación que no ejecutan funcionalidad, y comprobar el cobro Cashlogy ante fallos del agente local.

**Criterio:** mantener resultados calculados, contratos HTTP/almacenamiento/fiscales, SQL ejecutado, herramientas de despliegue ejecutadas y analizadores de seguridad. Eliminar búsquedas de JSX, clases, textos incidentales y expresiones SQL como supuesta prueba de comportamiento. En archivos mixtos conservar los escenarios ejecutables. No confundir la lectura de un módulo para ejecutarlo con una prueba estática.

**Implementación:** conservar el runner heredado para las pruebas existentes y usar Vitest para los escenarios nuevos. Ejecutar el store Zustand, cliente HTTP, polling, almacenamiento y errores reales; sustituir únicamente fetch, almacenamiento del navegador y servicios externos. Los relojes serán simulados.

- [x] Inventariar todos los tests y registrar por archivo las eliminaciones y garantías conservadas.
- [x] Retirar casos estáticos y aserciones estáticas en casos mixtos, limpiando únicamente sus fixtures/imports huérfanos.
- [x] Añadir cobro correcto, errores HTTP/red, datos inválidos, importes/identidades incompatibles, timeout y respuesta tardía, recuperación sin segundo cobro, cancelación, concurrencia y cambio de ámbito.
- [x] Ejecutar primero los escenarios nuevos. Si revelan un defecto, demostrar el fallo antes de la corrección mínima.
- [x] Ejecutar lint, ambas suites y build; comparar los fallos con la ejecución inicial y revisar el diff.

**Límites:** no tocar producción, migraciones, semántica fiscal ni backend externo de impresión. Las pruebas simuladas no acreditan hardware físico ni un despliegue concreto del agente.

**Revisión:** proteger especialmente el POST único, la conservación del requestId pendiente, la identidad tenant/local/terminal, el rechazo de resultados incoherentes y el rechazo de respuestas obsoletas tras cancelar o cambiar de ámbito.

**Ampliación autorizada:** el usuario pidió una reducción mayor y eligió explícitamente 200–300 casos críticos. La selección final conserva 72 casos Cashlogy, 208 del resto de la app y 19 Python del workflow: 299/299 pasan. Se corrige el formato CRLF/LF del fixture de menús, manteniendo íntegros los nueve escenarios y sin modificar la migración. El informe vigente es `docs/test-suite-critical-2026-10-26.md`.
