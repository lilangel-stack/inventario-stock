# Mi negocio

Aplicación web para registrar compras y ventas, controlar inventario, generar facturas y consultar gastos, utilidades y gráficos acumulados de ventas, gastos y productos más vendidos. La tienda se comparte de forma segura mediante una clave especial que permite consultar los mismos datos desde diferentes dispositivos.

## Requisitos e inicio

Se requiere Node.js 22.5 o posterior. Desde la carpeta del proyecto, ejecuta:

```bash
npm start
```

Abre la dirección que aparece en la terminal (por defecto, http://localhost:3000) y selecciona **Crear tienda**.

Si el puerto está ocupado, el servidor probará automáticamente el siguiente y mostrará la dirección correcta en la terminal.

**No abras `index.html` directamente ni uses Live Server**, porque esos servidores no incluyen la API y no permiten crear la tienda ni iniciar sesión.

Ingresa el nombre, apellido y nombre de la tienda. Crea y confirma una clave privada de al menos 12 caracteres.

Puedes crear varias tiendas independientes; cada una tiene sus propios datos y una clave diferente. Guarda cada clave: no hay correo para iniciar sesión ni función para recuperar claves. Para volver a entrar, escribe la clave de la tienda que quieras abrir.

El encabezado muestra el nombre de la tienda y un saludo con el nombre del propietario. Los botones **Mostrar/Ocultar** permiten revisar la clave antes de usarla.

Cada clave da acceso únicamente a los datos de su tienda. Compártela solo con personas autorizadas. Las tiendas creadas anteriormente con correo siguen usando como clave la contraseña de su cuenta anterior.

## Acceder desde otros dispositivos

- **En la misma red local:** inicia el servidor en el equipo donde quieras guardar la base de datos y abre desde el otro dispositivo `http://<IP-local-del-equipo>:<puerto-mostrado-en-la-terminal>`. El equipo debe permanecer encendido y su firewall debe permitir conexiones al puerto.
- **Desde fuera de la red:** despliega esta aplicación en un servidor accesible por Internet con HTTPS y almacenamiento persistente. Configura ese almacenamiento para el archivo de SQLite. No publiques la aplicación en Internet sin HTTPS.
- **Base de datos:** se crea en `data/mi-negocio.sqlite`. Puedes cambiar su ubicación con la variable de entorno `DATABASE_PATH` y el puerto con `PORT`.
- **Almacenamiento:** el tema claro/oscuro se guarda en el navegador. Los productos, compras, ventas y gastos se guardan en SQLite y se comparten con todas las personas que accedan mediante la clave de la tienda.
- **Migración:** los registros antiguos de IndexedDB en este navegador se migran a la tienda cuando se crea por primera vez o cuando una tienda existente sin registros se abre desde este navegador.

## Cálculos

- El precio de venta se calcula sumando el porcentaje de utilidad al costo promedio de compra.
- La cuota inicial corresponde al 20 % del total de venta. El saldo restante se divide en el número de cuotas indicado.
- Las compras actualizan el costo promedio ponderado del producto; al guardar una venta se verifica y descuenta el stock.
- Los importes se muestran en pesos colombianos (COP).

## Seguridad

La clave se almacena como hash scrypt y la sesión se identifica mediante una cookie `HttpOnly`.

En despliegues públicos, configura HTTPS y conserva el archivo SQLite en un disco persistente con copias de seguridad.