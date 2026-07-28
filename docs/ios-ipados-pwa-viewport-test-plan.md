# Pruebas manuales del viewport en la PWA de iOS/iPadOS

Realizar la prueba principal en un iPad físico con la aplicación instalada desde
Safari en la pantalla de inicio. Repetir después la comprobación de control en
Safari normal.

## Matriz

- PWA instalada y Safari normal.
- Orientación vertical y horizontal.
- Modales de pago en efectivo, movimientos, descuento, producto, configuración,
  historial y cualquier modal del CRM que contenga controles de formulario.

## Secuencia

1. Abrir un modal.
2. Enfocar un `input`, `textarea` o `select`.
3. Escribir o cambiar su valor.
4. Ocultar el teclado con el botón de la esquina inferior derecha.
5. Pulsar botones de las zonas superior, central e inferior.
6. Confirmar que cada pulsación activa exactamente el elemento visible bajo el dedo.
7. Cerrar el modal y confirmar que no queda scroll residual, un salto de layout ni
   una zona que no responda.
8. Repetir el ciclo al menos 20 veces y alternar entre varios modales.
9. Cambiar la orientación, esperar a que el layout se estabilice y repetir.
10. Con un modal abierto, cambiar a otra aplicación, volver y repetir las pulsaciones.

## Resultado esperado

- La posición visual y el área táctil de todos los controles coinciden.
- El contenido recupera toda la altura disponible al cerrar el teclado.
- El documento permanece en el origen; solo se desplazan los contenedores internos.
- No aparecen saltos, scroll residual ni áreas sin respuesta.
- Safari normal no recibe el workaround de reparación y conserva su comportamiento.
- El zoom de accesibilidad continúa disponible.
