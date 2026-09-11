## Validación de deploy

- [ ] Las migraciones de este PR son únicamente archivos nuevos; no se ha editado la historia existente.
- [ ] Cada migración es `expand` y mantiene el contrato usado por el frontend N-1.
- [ ] No se eliminan ni renombran columnas, tablas, RPC, vistas o tipos utilizados por clientes abiertos.
- [ ] Los cambios RLS siguen permitiendo las operaciones de N-1.
- [ ] Los índices sobre tablas existentes usan `CONCURRENTLY` y los constraints se validan por fases.
- [ ] He considerado una operación iniciada antes del deploy y terminada después (cobro, Cashlogy, comanda u offline sync).
- [ ] Si hay un cambio `contract`, se publicará en otro release después de retirar N-1.
