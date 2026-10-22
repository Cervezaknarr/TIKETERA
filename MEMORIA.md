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
- `render.yaml` en la raíz: servicio web (`rootDir: backend`) + base Postgres, ambos en `plan: free`. `PAYMENT_PROVIDER` arranca en `mock`.
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
- [x] Commit `5ff7afd` subido a GitHub (`Cervezaknarr/TIKETERA`, rama `integracionPagos`)
- [x] Render: Blueprint desplegado (pidió tarjeta aunque todo sea Free). URL: https://ticketera-vbdw.onrender.com (web, `/health` y `/api/events` responden 200)
- [x] `BACKEND_URL` y `FRONTEND_URL` cargadas en Environment (el servicio responde 200 después de reiniciar)
- [x] Evento "FIESTARDA" ya creado en la web publicada (7/11/2026, Club Universitario, $25.000, 300 entradas)
- [x] `mock` no sirve en producción (se bloquea a propósito): se pasó directo a Mercado Pago de prueba
- [x] Aplicación "Checkout Pro" (API de Preferences) creada en Mercado Pago; `PAYMENT_PROVIDER=mercadopago` y `MERCADOPAGO_ACCESS_TOKEN` de **prueba** cargados en Render (el token de prueba empieza con `APP_USR-`, no `TEST-`; está atado a un usuario `TESTUSER…`)
- [x] **Compra completa probada con comprador de prueba: funciona** (pago, aviso a la web y entrada con QR)
- [ ] Revisar las compras de prueba que quedaron en la base y el cupo del evento antes de vender de verdad
- [ ] Revisar `sequelize.sync({ alter: true })` en `server.js`: en producción conviene migraciones; por ahora modifica tablas al arrancar
- [ ] Plan gratis: el servidor se duerme sin tráfico y la base gratis vence; para un evento real conviene plan pago

### Para probar Mercado Pago (pausado hasta publicar; los hace el usuario)
- [ ] Crear la aplicación "Checkout Pro" en mercadopago.com.ar/developers
- [ ] Crear dos usuarios de prueba (vendedor y comprador)
- [ ] Cargar el Access Token de prueba en `backend/.env` y poner `PAYMENT_PROVIDER=mercadopago`
- [ ] ~~Armar un túnel (ngrok)~~ ya no hace falta: `BACKEND_URL` será la URL de Render
- [ ] Probar una compra completa: pagar con el usuario de prueba y ver que lleguen las entradas con QR

### Rama de producción (2026-10-21)
- La rama `integracionPagos` se renombró a **`prod`**; es la que lee Render (el Blueprint ya apunta a `prod`).
- Al cambiar la rama, el Blueprint quiso pisar `PAYMENT_PROVIDER` con `mock` (el valor de `render.yaml`) y pidió aprobación. No se aprobó: `PAYMENT_PROVIDER` quedó con `sync: false` en `render.yaml`, así que el valor del panel manda. **Si Render vuelve a pedir "Approve" por una variable, no aprobar sin mirar qué cambia.**
- [ ] Cambiar también la rama en Settings del servicio `ticketera` y después borrar `integracionPagos` de GitHub

### MODO como pasarela (2026-10-21, rama `agregandoModo`)
- Proveedor nuevo `modo` (`backend/utils/payments/modo.js`), según https://merchants.modo.com.ar/docs/1e2aa881-a70d-4a1d-a8c5-51d1fdbb8e08 (Botón de Pago, SDK v2): token (dura una semana, se reutiliza) → payment request → el comprador va al site de MODO → webhook firmado → se confirma con `GET /v2/payment-requests/{id}/data`.
- El webhook se verifica con la firma JWS contra las claves de MODO (JWKS, se descargan una vez) y el cuerpo no puede diferir de lo firmado. Los estados finales (ACCEPTED/REJECTED) se confirman contra la API.
- El `gatewayId` es el id de la payment request de MODO; el `external_intention_id` es el id de la compra.
- Una payment request dura **10 minutos máximo** y un rechazo la termina: rechazado = compra fallida (hay que empezar otra). Con MODO conviene `PURCHASE_HOLD_MINUTES=15`.
- Monto mínimo de MODO: $30. Variables: `MODO_ENV` (preprod/production), `MODO_USERNAME`, `MODO_PASSWORD`, `MODO_PROCESSOR_CODE`, `MODO_CC_CODE`, `MODO_MERCHANT_NAME`, `BACKEND_URL`.
- La pantalla de entradas ahora muestra "Estamos confirmando tu pago…" y se actualiza sola (cada 3 s, hasta 1 minuto) al volver de la pasarela; si el pago falló lo dice.
- 7 tests nuevos (`test/modo.test.js`, con firmas RSA reales); 44 en total pasan.
- **MODO no se probó contra su API real.** La forma exacta del cuerpo del webhook no está en la documentación (el id se lee de `id`, `payment_request_id` o `paymentRequestId` del payload firmado); hay que probarlo en preprod y ajustar si hace falta.
- **Para producción MODO exige estar dado de alta en un gateway de pago (Decidir, Getnet, IPG o Line), lo que normalmente requiere CUIT.** Las credenciales de test genéricas están en la documentación ("Credenciales de integración").
- [ ] Probar en preprod con las credenciales de test y un túnel o la URL pública (`BACKEND_URL`)
- [ ] Fusionar `agregandoModo` con `prod` cuando esté probado

### Seguridad de dependencias
- [x] `npm audit fix` aplicado en local (2026-10-20): de 13 vulnerabilidades quedan 2 moderadas en producción, ambas de `uuid`. No afectan: solo fallan en v3/v5/v6 con buffer propio y el proyecto usa v4. Arreglarlas requiere `--force` (cambio mayor), no vale la pena ahora.
- [x] `backend/package-lock.json` commiteado y subido

### Código
- [x] **Liberar el cupo de compras abandonadas o vencidas** (2026-10-20, `backend/utils/purchases.js`). Cada 5 minutos el servidor pasa las compras `pending` de más de 40 minutos (`PURCHASE_HOLD_MINUTES`, la preferencia de pago vence a los 30) a `failed` y devuelve su cupo. Si un pago se aprueba después de vencer (ej. efectivo), se intenta reservar de nuevo el cupo y completar la compra; si ya no queda, **no se emiten entradas** y el log dice `PAGO APROBADO SIN CUPO` (hay que reembolsar a mano desde Mercado Pago). 37 tests pasan.
- [ ] Mirar los logs de Render de vez en cuando buscando `PAGO APROBADO SIN CUPO`
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
