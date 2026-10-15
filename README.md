# Mi negocio

Aplicación web en React para registrar compras y ventas, controlar inventario, generar facturas y consultar gastos, utilidades y gráficos acumulados de ventas, gastos y productos más vendidos. La interfaz usa Tailwind CSS y animaciones GSAP. La tienda se comparte de forma segura mediante una clave especial que permite consultar los mismos datos desde diferentes dispositivos.

## Requisitos e inicio

Se requiere Node.js 22.5 o posterior. Instala las dependencias y, desde la carpeta del proyecto, ejecuta:

```bash
npm install
npm start
```

El inicio compila la interfaz React con Vite y luego levanta el servidor. En Windows, también puedes hacer doble clic en **Iniciar Mi Negocio.bat**.

Para trabajar en desarrollo, abre dos terminales: ejecuta `npm run start:api` en una y `npm run dev` en la otra; Vite enviará las solicitudes `/api` al servidor local.

Abre la dirección que aparece en la terminal (por defecto, http://localhost:3000) y selecciona **Crear tienda**.

Si el puerto está ocupado, el servidor probará automáticamente el siguiente y mostrará la dirección correcta en la terminal.

**No abras `index.html` directamente ni uses Live Server**, porque esos servidores no incluyen la API y no permiten crear la tienda ni iniciar sesión.

Ingresa el nombre, apellido y nombre de la tienda. Crea y confirma una clave privada de al menos 12 caracteres.

Puedes crear varias tiendas independientes; cada una tiene sus propios datos y una clave diferente. Guarda cada clave: no hay correo para iniciar sesión ni función para recuperar claves. Para volver a entrar, escribe la clave de la tienda que quieras abrir.

El encabezado muestra el nombre de la tienda y un saludo con el nombre del propietario. Los botones **Mostrar/Ocultar** permiten revisar la clave antes de usarla.

Cada clave da acceso únicamente a los datos de su tienda. Compártela solo con personas autorizadas. Las tiendas creadas anteriormente con correo siguen usando como clave la contraseña de su cuenta anterior.

## Publicar en Internet

Netlify puede publicar los archivos estáticos, pero no mantener este servidor Express encendido ni guardar una base SQLite persistente. Por eso, el despliegue de la aplicación completa usa Render para Express y PostgreSQL administrado para los datos.

1. Crea una base de datos PostgreSQL en un proveedor que ofrezca un plan gratuito y copia su URL de conexión (`DATABASE_URL`).
2. Antes de desplegar la app, copia los datos locales a PostgreSQL desde la carpeta del proyecto. En PowerShell, ejecuta:

   ```powershell
   $env:DATABASE_URL = "pega-aqui-la-URL-de-conexion"
   npm run migrate:sqlite
   ```

   La migración se cancela si la base remota ya tiene datos, para evitar sobrescribirlos. No compartas ni publiques la URL: contiene la contraseña de la base.
3. Sube los cambios de este proyecto a GitHub. En Render, conecta el repositorio como Blueprint. El archivo `render.yaml` configura el servidor web en el plan gratuito y solicita `DATABASE_URL`; no necesita un disco persistente. Pega la misma URL de conexión y conserva `NODE_ENV=production`.
4. Después de desplegar, abre la URL del servicio de Render; no la URL estática de Netlify.

La app sigue usando SQLite localmente si no se define `DATABASE_URL`. El proceso de compilación genera los archivos de React, y Express los sirve junto con la API. La migración copia tiendas y registros, pero no sesiones activas; inicia sesión de nuevo después del despliegue.

## Acceder desde otros dispositivos

- **En la misma red local:** inicia el servidor en el equipo donde quieras guardar la base de datos y abre desde el otro dispositivo `http://<IP-local-del-equipo>:<puerto-mostrado-en-la-terminal>`. El equipo debe permanecer encendido y su firewall debe permitir conexiones al puerto.
- **Desde fuera de la red:** despliega esta aplicación en un servidor accesible por Internet con HTTPS y configura `DATABASE_URL` con una base PostgreSQL persistente.
- **Base de datos local:** se crea en `data/mi-negocio.sqlite`. Puedes cambiar su ubicación con `DATABASE_PATH`; para producción, usa `DATABASE_URL`. Render define `PORT` automáticamente.
- **Almacenamiento:** el tema claro/oscuro se guarda en el navegador. Los productos, compras, ventas y gastos se guardan en SQLite localmente o en PostgreSQL cuando está configurado `DATABASE_URL`, y se comparten con todas las personas que accedan mediante la clave de la tienda.
- **Migración:** los registros antiguos de IndexedDB en este navegador se migran a la tienda cuando se crea por primera vez o cuando una tienda existente sin registros se abre desde este navegador.

## Cálculos

- El precio de venta se calcula sumando el porcentaje de utilidad al costo promedio de compra.
- La cuota inicial corresponde al 20 % del total de venta. El saldo restante se divide en el número de cuotas indicado.
- Las compras actualizan el costo promedio ponderado del producto; al guardar una venta se verifica y descuenta el stock.
- Los importes se muestran en pesos colombianos (COP).

## Seguridad

La clave se almacena como hash scrypt y la sesión se identifica mediante una cookie `HttpOnly`.

En despliegues públicos, configura HTTPS, guarda `DATABASE_URL` como secreto y configura copias de seguridad en el proveedor de PostgreSQL.