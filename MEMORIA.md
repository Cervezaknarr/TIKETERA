# Memoria del proyecto Ticketera

Registro vivo de lo que se hizo, las decisiones tomadas y lo que falta. Se actualiza en cada sesión.

## Qué es
Plataforma de venta de entradas para eventos con QR y control de acceso.
- **Backend** (`backend/`): Node.js, Express, Sequelize. PostgreSQL en producción, SQLite en memoria para tests.
- **Frontend** (`frontend/index.html`): una sola página.
- Rama de trabajo actual: `integracionPagos`.

## Historial
| Fecha | Qué se hizo |
|---|---|
| (antes) | Entradas individuales con código corto, check-in offline-first, rol staff, webhook idempotente |
| (antes) | Email de entradas con Resend (inactivo hasta tener `RESEND_API_KEY`), listado de compradores, export CSV |
| 2026-10-20 | Capa de pasarelas de pago en `backend/utils/payments/` (`mock`, `nave`, `mercadopago`), elegida con `PAYMENT_PROVIDER` |
| 2026-10-20 | **Nave** implementado según la documentación oficial (token, intención de pago, webhook verificado contra su API) |
| 2026-10-20 | **Mercado Pago** (Checkout Pro) implementado: preferencia de pago, webhook verificado contra su API |
| 2026-10-20 | Helper HTTP compartido (`utils/payments/http.js`): timeout de 10 s y 3 intentos ante errores de red o 5xx |
| 2026-10-20 | Tests de pagos con la API de las pasarelas simulada: 33 pasan |

### Preparación para publicar en Render (2026-10-20)
- **Se pausó la prueba de pagos** hasta tener la web publicada: con una URL fija ya no hace falta ngrok.
- El backend **sirve el frontend** (`express.static`), así que hay un solo servicio y no hace falta CORS en producción. El frontend usa su propio origen como API (antes apuntaba a `localhost:3000`).
- `/` ahora devuelve la web; el health check pasó a `/health`.
- `render.yaml` en la raíz: servicio web (`rootDir: backend`) + base Postgres. `PAYMENT_PROVIDER` arranca en `mock`.
- En local la web se abre en `http://localhost:5000` (backend), no con un servidor aparte.

## Decisiones tomadas
- **Pasarela elegida: Mercado Pago.** Nave exige CUIT y el usuario no tiene. Nave queda implementado por si se consigue.
- **Cobro del primer evento:** por ahora con la cuenta del usuario, solo para probar y dejar todo configurado. Después se usa la cuenta del organizador, o Marketplace de Mercado Pago si hay varios organizadores. Cambiar de cuenta es cambiar `MERCADOPAGO_ACCESS_TOKEN`.
- **Un pago rechazado queda "pendiente"** y no libera el cupo, porque el comprador puede reintentar sobre la misma preferencia. Si se liberara y el reintento se aprobara, se cobraría sin emitir entradas. Solo cancelado, devuelto o contracargo liberan el cupo.
- **Los webhooks no se creen:** del aviso solo se toma el id del pago y el estado real se consulta a la API con las credenciales del comercio. No se sigue ninguna URL que venga en el body.
- **El id de la compra** es el `external_reference` / `external_payment_id` que se manda a la pasarela, y también el `gatewayId` para encontrar la compra al llegar el webhook.
- **Mock bloqueado en producción** (`NODE_ENV=production` lo rechaza).

## Configuración (`backend/.env`, ver `.env.example`)
- `PAYMENT_PROVIDER`: `mock` | `mercadopago` | `nave`
- Mercado Pago: `MERCADOPAGO_ACCESS_TOKEN`, `BACKEND_URL` (dirección pública del backend, ahí avisa los pagos a `/api/purchases/webhook`)
- Nave: `NAVE_ENV`, `NAVE_CLIENT_ID`, `NAVE_CLIENT_SECRET`, `NAVE_AUDIENCE`, `NAVE_POS_ID`
- `FRONTEND_URL`: a dónde vuelve el comprador después de pagar y base del link "ver mis entradas"
- `RESEND_API_KEY`, `RESEND_FROM`: email de entradas (vacío = no se envía, el link sale por consola)

## Pendientes
### Publicar en Render (en curso, tiene prioridad)
- [ ] Commitear y subir la rama a GitHub (`Cervezaknarr/TIKETERA`)
- [ ] Render: New > Blueprint > elegir el repositorio (usa `render.yaml`)
- [ ] Después del primer deploy, copiar la URL asignada (`https://ticketera-XXXX.onrender.com`) a `BACKEND_URL` y `FRONTEND_URL`
- [ ] Crear el usuario organizador y el evento en la web publicada
- [ ] Revisar `sequelize.sync({ alter: true })` en `server.js`: en producción conviene migraciones; por ahora modifica tablas al arrancar
- [ ] Plan gratis: el servidor se duerme sin tráfico y la base gratis vence; para un evento real conviene plan pago

### Para probar Mercado Pago (pausado hasta publicar; los hace el usuario)
- [ ] Crear la aplicación "Checkout Pro" en mercadopago.com.ar/developers
- [ ] Crear dos usuarios de prueba (vendedor y comprador)
- [ ] Cargar el Access Token de prueba en `backend/.env` y poner `PAYMENT_PROVIDER=mercadopago`
- [ ] ~~Armar un túnel (ngrok)~~ ya no hace falta: `BACKEND_URL` será la URL de Render
- [ ] Probar una compra completa: pagar con el usuario de prueba y ver que lleguen las entradas con QR

### Código
- [ ] **Liberar el cupo de compras abandonadas o vencidas.** Hoy el cupo queda reservado para siempre si el comprador no paga, porque no hay ningún proceso que lo libere. Hacerlo antes de producción.
- [ ] Verificar que el monto pagado coincida con el de la compra al procesar el webhook
- [ ] Probar el flujo contra el sandbox real (hasta ahora solo hay tests con la API simulada)
- [ ] Probar la atomicidad de las compras simultáneas con Postgres (SQLite no lo permite)

### Antes de salir en producción
- [ ] Publicar el backend con una dirección fija (sin túnel)
- [ ] Cambiar el token de prueba por el de producción de la cuenta que cobre
- [ ] Configurar `RESEND_API_KEY` con un dominio verificado para activar el email
- [ ] Commitear el trabajo de la rama `integracionPagos` (hoy hay cambios sin commitear)

### Futuro
- [ ] **Varios organizadores:** hoy hay un solo evento de un organizador externo. Con más organizadores, pasar a Marketplace de Mercado Pago: cada organizador vincula su cuenta y cada venta va directo a él, con comisión automática. Implica guardar en cada evento a qué cuenta de pago corresponde, usar esas credenciales en `createPayment` y una pantalla de "Vincular Mercado Pago".
- [ ] Nave: si se consigue CUIT, pedir credenciales a integraciones@navenegocios.com (CUIT, código de vinculación de Nave > Integraciones > Tienda Online Propia, dos `notification_url`)

## Notas
- Documentación de Nave: https://developer-portal-doc-mfe-website-mfe.ranty.io/nave/online-payments/checkout
- Documentación de Mercado Pago: https://www.mercadopago.com.ar/developers/es/docs/checkout-pro
- Las credenciales nunca van al chat, a git ni a lugares públicos.
