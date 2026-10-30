# Memoria del proyecto Ticketera

Registro vivo de lo que se hizo, las decisiones tomadas y lo que falta. Se actualiza en cada sesión.

## Qué es
Plataforma de venta de entradas para eventos con QR y control de acceso.
- **Backend** (`backend/`): Node.js, Express, Sequelize. PostgreSQL en producción, SQLite en memoria para tests.
- **Frontend** (`frontend/`): tres sitios servidos por el mismo backend: `/` visitantes (compran), `/staff` escáner de QR, `/admin` panel (eventos, lotes, compradores, personal). Estilos y utilidades compartidos en `styles.css` y `common.js`.

## Estado actual (2026-10-24)
- **`main` y `prod` están en el mismo commit** (33f583b o posterior). **Render despliega `prod`** (https://ticketera-vbdw.onrender.com); cada push a `prod` redespliega.
- En producción: lotes (tipos de entrada) y edición de eventos, topes y límites por IP, escáner de QR por cámara y roles (admin / staff) de Alva, pagos con **Mercado Pago de prueba**.
- **Planes pagos de Render ya contratados:** servicio web `0.5c-512mb` y base `0.1c-256mb` (Render nombra los planes por CPU y memoria; `free` es el gratis). `render.yaml` refleja esos nombres.
- **Pausado, no está en prod:** MODO (rama `agregandoModo`; exige alta en un gateway de pago, normalmente con CUIT). Talo Pay (transferencias; acepta personas físicas) se investigó, no se implementó.
- **Ramas viejas** que se conservan: `integracionPagos` (el usuario pidió no borrarla), `haciendoLotes`, `integracion-staff-lotes`, `staff-admin-roles`, `agregandoModo`.
- **Pendientes del usuario en Render:** reactivar la tarjeta (estaba pausada) antes del cobro mensual; borrar `ADMIN_PASSWORD` (ya entró a `/admin`); `DB_SYNC_ALTER=false` cuando la estructura de la base esté estable (antes de abrir ventas).
- **Pendientes técnicos principales:** modo sin conexión del escáner y probarlo en celulares reales (Alva); verificar `trust proxy` y el límite por IP en Render; prueba de carga; pasar Mercado Pago a credenciales de producción; limpiar los índices duplicados viejos de Postgres.
- **`main` tiene 2 commits que `prod` todavía no (revisados el 2026-10-24, listos para subir):** URL pública por evento `/e/<slug>`, portada, página de compra nueva con mapa y panel de admin rediseñado. 75 tests pasan y la migración se probó en Postgres real (columna `slug` única + `imageUrl` a texto + slug para los eventos existentes). **Condiciones al desplegar:** NO tener `DB_SYNC_ALTER=false` (con esa variable el servidor se cae al arrancar porque falta la columna `slug`); hacerlo cuando no haya ventas.
- **Fallos conocidos de esos commits, el usuario decidió dejarlos para más adelante:**
  1. **Un borrador se ve por su dirección pública:** `/e/<slug>` y `GET /api/events/<slug>` devuelven la ficha completa (lotes y precios) de eventos en borrador o cancelados. El slug sale del título, así que se puede adivinar. Arreglo: `getEventById` devuelve 404 salvo para el admin, y el panel (`viewEdit`) tiene que mandar la sesión (`auth: true`).
  2. **Crear un evento como "Borrador" lo publica:** `createEvent` ignora el campo `status`; el formulario lo ofrece. Arreglo: aceptar `status` al crear (validado contra `EVENT_STATUSES`).
  3. Menores: el mapa de la página pública está fijo en el Club Universitario para cualquier evento (`EVENT_MAP_SRC`); el límite de 2 MB de `express.json` aplica a todo el servidor, no solo a la portada.
- Las secciones de abajo son el historial: algunos pendientes viejos ya se resolvieron y están marcados.

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
  - En local con SQLite ya rompe: con datos cargados, `alter` intenta recrear `Users` y falla por las claves foráneas (`SQLITE_CONSTRAINT` en `DROP TABLE Users`), así que el servidor no arranca con `datos-local/ticketera.sqlite`. Pasa también sin los cambios de roles. Mientras tanto, probar en local con una base nueva.
- [x] Plan gratis: el servidor se duerme y la base gratis vence; **resuelto el 2026-10-24: planes pagos contratados**

### Para probar Mercado Pago (HECHO: compra de prueba completa probada en la web publicada)
- [x] Crear la aplicación "Checkout Pro" en mercadopago.com.ar/developers
- [x] Crear dos usuarios de prueba (vendedor y comprador)
- [x] Cargar el Access Token de prueba en `backend/.env` y poner `PAYMENT_PROVIDER=mercadopago`
- [ ] ~~Armar un túnel (ngrok)~~ ya no hace falta: `BACKEND_URL` será la URL de Render
- [x] Probar una compra completa: pagar con el usuario de prueba y ver que lleguen las entradas con QR

### Lotes (tipos de entrada) y edición de eventos (2026-10-21, rama `haciendoLotes`)
- Nuevo modelo `Lot` (`backend/models/Lot.js`): nombre, precio, `quantity` (asignada) y `ticketsAvailable` (lo que queda). Ej.: EARLY, VIP, General, Jugador. **Agotada = `ticketsAvailable` 0.**
- El precio y el cupo ya no viven en el evento: las columnas `ticketPrice`/`ticketsAvailable` de `Event` quedaron nullable y en desuso. Al arrancar, `utils/migrateLots.js` convierte los eventos viejos en un lote "General" (con sus compras asociadas). Es idempotente.
- Una compra es de **un solo lote**; guarda `lotId`, `lotName` y `unitPrice` tal como estaban al comprar (editar el lote después no cambia las compras).
- API: `PUT /api/events/:id` (datos y estado del evento), `POST /api/events/:id/lots`, `PUT .../lots/:lotId` (nombre, precio, `quantity` o `soldOut: true`), `DELETE .../lots/:lotId`. Todo solo para el organizador del evento (o admin).
- Reglas: no se puede asignar menos de lo ya vendido o reservado; un lote con compras no se borra (se agota); el evento siempre tiene al menos un lote; un evento en borrador o cancelado no vende.
- Frontend: crear evento con lotes, pantalla "Editar" (datos del evento + lotes con Guardar / Agotar / Borrar / Agregar), listado con lotes y etiqueta "Agotada", compra eligiendo lote, columna de lote en compradores y CSV. Probado en el navegador con un servidor local.
- 53 tests pasan (16 nuevos en `test/lots.test.js`).
- **Preparación para el día del evento (1200 personas, ~80% de las compras el mismo día, validación en 2 h):** la arquitectura actual (Node + Postgres) alcanza; los riesgos son de infraestructura y de la puerta. El usuario ya decidió pagar Render y el email, y el escáner con cámara lo hace otro dev. Hecho en `haciendoLotes`:
  - La ventana de pago es de **10 minutos** (`PAYMENT_WINDOW_MINUTES`, antes 15 y 30) y el cupo se retiene ventana + 5 = **15 min** (`PURCHASE_HOLD_MINUTES`). Además las compras pendientes de un lote no pueden retener más del **40%** de su cupo (`MAX_PENDING_LOT_PERCENT`, nunca menos que el máximo por compra); el tope por email se cuenta con el lote bloqueado dentro de la transacción: cerca del agotamiento, las compras sin pagar liberan cupo antes. `utils/paymentWindow.js` es la única fuente.
  - Topes contra acaparamiento: máximo **10 entradas por compra** (`MAX_TICKETS_PER_PURCHASE`) y máximo **5 compras pendientes por email y evento** (`MAX_PENDING_PER_EMAIL`, sin distinguir mayúsculas; responde 429).
  - Límite por IP: **60 compras cada 10 min** y **30 intentos de login/registro cada 15 min** (`RATE_LIMIT_CHECKOUT_MAX`, `RATE_LIMIT_AUTH_MAX`; 0 = sin límite). El webhook de pago no se limita. `trust proxy` = 1 en producción (`TRUST_PROXY`).
  - `DB_SYNC_ALTER=false` hace que los reinicios no modifiquen tablas existentes (en Postgres repetir `alter` puede duplicar índices). **Plan:** dejarlo en true para el primer deploy con lotes y ponerlo en false después.
  - 61 tests pasan (8 nuevos en `test/limits.test.js`).
- [ ] **Verificar `trust proxy` en Render:** si la cantidad de proxies es otra, todos los compradores compartirían un mismo límite por IP. Si aparecen compradores con "demasiados intentos", poner `RATE_LIMIT_CHECKOUT_MAX=0` y revisar `TRUST_PROXY`. Ojo: varias personas con datos móviles comparten IP.
- [ ] Prueba de carga con Postgres (simular decenas de compras simultáneas) antes del día del evento
- [x] **Probado en Postgres real (2026-10-23)**, con un Postgres local con SSL (paquete `embedded-postgres`, fuera del proyecto): se armó una base igual a la de producción con el código de `prod` (3 reinicios, evento con 300 entradas, una compra pagada de 3, una pendiente de 2 y una fallida de 4) y se arrancó el servidor de `haciendoLotes` con `NODE_ENV=production`:
  - Migración correcta: lote General de $25.000 con 300 asignadas y 295 disponibles (igual que antes), las 3 compras asociadas al lote, las 3 entradas intactas, y precio/cupo viejos del evento en NULL. Idempotente: al reiniciar no migra de nuevo.
  - Cambios de estructura exactos: tabla `Lots` nueva, columnas `lotId/lotName/unitPrice` en `Purchases`, `Events.ticketPrice/ticketsAvailable` pasaron a opcionales.
  - **Compras simultáneas (lo que SQLite no podía probar):** 120 pedidos a la vez por 20 entradas VIP → exactamente 20 vendidas y 100 "agotado" (553 ms); 60 webhooks simultáneos (3 por compra) sin errores ni entradas duplicadas; 60 compras mientras se editaba la cantidad del lote 7 veces → el cupo cierra exacto (asignadas − disponibles = vendidas + reservadas) y no hay códigos repetidos.
  - **Hallazgo:** con `sync({ alter: true })` cada arranque agrega **un índice único duplicado** por tabla (Purchases, Tickets, Users). Con `DB_SYNC_ALTER=false` los reinicios no agregan nada. La base real de Render ya acumula duplicados de sus reinicios anteriores (inofensivos pero evitables).
  - No cubierto: la versión exacta de Postgres de Render, ni carga real sobre su hardware.
- **Plan de despliegue de los lotes:** 1) hacer una copia de seguridad de la base en Render; 2) fusionar `haciendoLotes` a `prod` (arranca con alter activo: crea `Lots` y migra FIESTARDA); 3) revisar los logs: "Eventos migrados a lotes: 1"; 4) agregar `DB_SYNC_ALTER=false` en las variables de Render para que los reinicios no sigan duplicando índices. Opcional más adelante: borrar los índices duplicados existentes.
- [x] `haciendoLotes` fusionada a `prod` y `main` (24/10)

### Rama de producción (2026-10-21)
- La rama `integracionPagos` se renombró a **`prod`**; es la que lee Render (el Blueprint ya apunta a `prod`).
- Al cambiar la rama, el Blueprint quiso pisar `PAYMENT_PROVIDER` con `mock` (el valor de `render.yaml`) y pidió aprobación. No se aprobó: `PAYMENT_PROVIDER` quedó con `sync: false` en `render.yaml`, así que el valor del panel manda. **Si Render vuelve a pedir "Approve" por una variable, no aprobar sin mirar qué cambia.**
- [x] Rama cambiada a `prod` también en el servicio `ticketera`
- `integracionPagos` **se conserva** en GitHub a pedido del usuario (no borrarla)
- **Rama de trabajo actual: `haciendoLotes`** (creada el 2026-10-21 desde `prod`, ya subida a GitHub). Cuando el usuario termine, se fusiona con `prod` y `main`. Mientras tanto, lo que se pushee ahí **no** redespliega Render (solo lo hace `prod`).

### Seguridad de dependencias
- [x] `npm audit fix` aplicado en local (2026-10-20): de 13 vulnerabilidades quedan 2 moderadas en producción, ambas de `uuid`. No afectan: solo fallan en v3/v5/v6 con buffer propio y el proyecto usa v4. Arreglarlas requiere `--force` (cambio mayor), no vale la pena ahora.
- [x] `backend/package-lock.json` commiteado y subido

### Código
- [x] **Liberar el cupo de compras abandonadas o vencidas** (2026-10-20, `backend/utils/purchases.js`). Cada 5 minutos el servidor pasa las compras `pending` de más de 40 minutos (`PURCHASE_HOLD_MINUTES`, la preferencia de pago vence a los 30) a `failed` y devuelve su cupo. Si un pago se aprueba después de vencer (ej. efectivo), se intenta reservar de nuevo el cupo y completar la compra; si ya no queda, **no se emiten entradas** y el log dice `PAGO APROBADO SIN CUPO` (hay que reembolsar a mano desde Mercado Pago). 37 tests pasan.
- [ ] Mirar los logs de Render de vez en cuando buscando `PAGO APROBADO SIN CUPO`
- [ ] Verificar que el monto pagado coincida con el de la compra al procesar el webhook
- [ ] **Contador de la reserva en la página del comprador:** mostrar cuánto le queda de los 10 min (`PAYMENT_WINDOW_MINUTES`) para pagar, con aviso al vencer. Pendiente en el frontend público (lo toca la sesión estética); el backend ya devuelve `purchase.expiresAt` en el checkout y en `GET /api/purchases/tickets/:token` (null si ya no está pendiente); falta el contador en el frontend
- [ ] Probar el flujo contra el sandbox real (hasta ahora solo hay tests con la API simulada)
- [ ] Probar la atomicidad de las compras simultáneas con Postgres (SQLite no lo permite)

### Antes de salir en producción
- [ ] Publicar el backend con una dirección fija (sin túnel)
- [ ] Cambiar el token de prueba por el de producción de la cuenta que cobre
- [ ] Configurar `RESEND_API_KEY` con un dominio verificado para activar el email
- [x] Trabajo de `integracionPagos` commiteado y fusionado

### Fusión de lotes + escáner/roles (2026-10-24, rama `integracion-staff-lotes`; YA SUBIDA Y FUSIONADA a `prod` y `main`)
- Se fusionó `origin/staff-admin-roles` (AlvaGoncalves) sobre `prod`. Conflictos: `purchaseController.js` (se dejó mi bloque, que ya incluye el control de estado), `server.js` (se conservaron ambos: migración de lotes + `ensureAdmin`), `eventRoutes.js` (las rutas de lotes pasaron a `protect, admin`) y `frontend/index.html`.
- Los lotes se llevaron al frontend nuevo: sitio público (`/`) lista lotes con "Agotada" y la compra elige lote; **`/admin`** crea eventos con lotes y la edición muestra datos del evento + lotes (guardar, agotar, borrar, agregar), compradores con columna de lote y CSV con lote. Estilos de lotes en `frontend/styles.css`.
- Con el modelo de roles solo el `admin` crea/edita eventos y lotes; el staff solo valida (403 en lo demás, 401 sin sesión). Mis tests de lotes se adaptaron (admin = dueño, staff = el otro usuario).
- 70 tests pasan. Probado en el navegador (SQLite): login admin, crear evento con 3 lotes, compra pública con lote (EARLY agotada), editar/agotar lotes, staff crea → escanea (admitida, 2.ª vez duplicada) y no puede editar.
- **Al desplegar hay que cargar en Render `ADMIN_EMAIL` y `ADMIN_PASSWORD`** (sin eso nadie crea eventos; las cuentas viejas de tipo "usuario" ya no entran). Con el email de la cuenta actual, se la pasa a admin sin tocar su contraseña. Después borrar `ADMIN_PASSWORD`.
- Pendientes heredados de la rama del escáner: modo sin conexión del escáner; decidir si el staff debe recibir nombre y email de los compradores en el sync; probar `/staff` en celulares reales (la cámara solo funciona con https).
- No probado: esta fusión contra Postgres (la migración de lotes ya se probó por separado).
- [x] `integracion-staff-lotes` subida y llevada a `prod` y `main` (el usuario lo pidió explícitamente). Verificado en producción: `/`, `/admin/`, `/staff/` responden, el registro público ya no existe (404) y FIESTARDA conservó su lote.

### Escáner de QR y roles (2026-10-24)
- [x] **Tres sitios** servidos por el mismo backend, con estilos (`frontend/styles.css`) y utilidades (`frontend/common.js`) compartidos:
  - `/` **visitantes**: ven eventos publicados, compran sin cuenta y ven sus entradas con el link privado. No hay login ni registro.
  - `/staff` **personal de la puerta**: login y escáner de QR, nada más.
  - `/admin` **administrador**: crear y editar eventos (incluido el estado), compradores con estadísticas y CSV, y alta/baja/cambio de contraseña del staff.
- [x] **Permisos en el backend** (la URL separada es orden, la seguridad está en las rutas):
  - Eventos POST/PUT/DELETE y listado de compras: solo `admin`. Check-in y estadísticas de ingreso: `staff` o `admin` (ya no vale ser "organizador" del evento).
  - `/api/auth/register` eliminado. El login rechaza (403) las cuentas `user` que quedaron del registro anterior.
  - `/api/users` (solo admin): listar personal, crear staff (siempre con rol `staff`, contraseña de 8 o más caracteres), cambiar nombre o contraseña y borrar. Los admin no se modifican ni se borran desde la API. Al borrar un staff su sesión se corta en el acto (el middleware busca al usuario en cada request).
  - La compra rechaza eventos que no estén `published` (borrador o cancelado).
- [x] **Primer admin**: al arrancar, si está `ADMIN_EMAIL`, se crea con `ADMIN_PASSWORD` (8 o más caracteres). Si el email ya existe, se lo pasa a admin sin tocar su contraseña. Se eligió así porque el plan gratis de Render no tiene consola. Variables agregadas a `render.yaml` con `sync: false`.
- [x] Escáner: usa `BarcodeDetector` (Chrome/Android) o `jsQR` 1.4.0 (Apache-2.0, copiado en `frontend/vendor/`). Resultado en grande con pitido y vibración, sigue solo a los 2,5 s, contador de ingresos y carga manual del código. La cámara solo funciona con https o localhost.
- [x] Al editar un evento, el cupo solo se manda si el admin lo cambió, para no pisar las ventas hechas con el formulario abierto.
- 46 tests pasan (nuevo `backend/test/roles.test.js`).
- [x] **Render**: `ADMIN_EMAIL` y `ADMIN_PASSWORD` cargados; el usuario ya entró a `/admin`. [ ] Falta borrar `ADMIN_PASSWORD` del panel de Render.
- [ ] [SEGURIDAD] El sync del escáner le manda al dispositivo del staff la lista de entradas con nombre y email de cada comprador (pensado para el modo sin conexión). Decidir si el staff debe ver esos datos.
- [x] [SEGURIDAD] El login ahora tiene límite por IP (30 intentos cada 15 min, `RATE_LIMIT_AUTH_MAX`). [ ] Los tokens siguen durando 30 días.
- [ ] Modo sin conexión en el escáner (el backend ya lo soporta).
- [ ] Probar `/staff` en celulares reales (Android e iPhone) y `/admin` en el navegador antes de la fiesta.

### Futuro
- [ ] **Varios organizadores:** hoy hay un solo evento de un organizador externo. Con más organizadores, pasar a Marketplace de Mercado Pago: cada organizador vincula su cuenta y cada venta va directo a él, con comisión automática. Implica guardar en cada evento a qué cuenta de pago corresponde, usar esas credenciales en `createPayment` y una pantalla de "Vincular Mercado Pago".
- [ ] Nave: si se consigue CUIT, pedir credenciales a integraciones@navenegocios.com (CUIT, código de vinculación de Nave > Integraciones > Tienda Online Propia, dos `notification_url`)

## Notas
- Documentación de Nave: https://developer-portal-doc-mfe-website-mfe.ranty.io/nave/online-payments/checkout
- Documentación de Mercado Pago: https://www.mercadopago.com.ar/developers/es/docs/checkout-pro
- Las credenciales nunca van al chat, a git ni a lugares públicos.
