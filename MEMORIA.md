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
- **Email de entradas (Resend), decisión del usuario 2026-11-04:** el mail va a estar configurado el 2026-11-05 y **no habrá ventas reales sin mail**. Pendientes del usuario: cargar `RESEND_API_KEY` en Render y verificar en Resend que el dominio de `RESEND_FROM` esté verificado (si no lo está, los mails no salen aunque la clave sea válida). Mientras no haya clave, el link a las entradas (con `accessToken`) se escribe en el log del servidor; el endurecimiento H-04 lo deja solo para desarrollo/tests y en producción enmascara el email y no escribe el link (ver `PLAN.md`).
- **Tandas de entradas (2026-11-10):** implementadas en el árbol de `main`, sin commit y sin desplegar. Falta la prueba en navegador y en Postgres, y la aprobación del usuario para TT.03. Ver la sección del 2026-11-10 al final.
- **Pendientes técnicos principales:** modo sin conexión del escáner y probarlo en celulares reales (Alva); verificar `trust proxy` y el límite por IP en Render; prueba de carga; pasar Mercado Pago a credenciales de producción; limpiar los índices duplicados viejos de Postgres.
- **Estado de despliegue:** los commits de la URL por evento `/e/<slug>`, portada, página de compra con mapa y panel de admin rediseñado ya están en `prod` (ver la sección del 2026-11-04). Lo único pendiente de desplegar son las tres columnas nuevas de `main` (`Event.unlisted`, `Event.mapQuery`, `Purchase.courtesy`): requieren `DB_SYNC_ALTER` sin definir o en `true` (ver la nota de despliegue de la sección 2026-11-05/06).
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

### Eventos +18 (2026-11-03, rama `lotes-y-seguridad`, sin mergear)
- `Event.adultsOnly` solo muestra la etiqueta +18 en el evento y el listado. Por decisión del usuario no hay casilla, ni aceptación, ni validación en la compra.
- La web pasó a llamarse **Kaiser Tikets** (así lo escribió el usuario). Sin cambiar: nombres internos (`ticketera_session_*` en `localStorage`, servicio y base de Render, paquete) y `RESEND_FROM`, que se configura en Render.
- **Lotes con código / cupones: se sacaron de esta rama por pedido del usuario**, que los va a implementar mejor en otra. La versión anterior quedó en `lotes-codigo-mayores18`.
- **Al desplegar:** agrega `Event.adultsOnly`: NO tener `DB_SYNC_ALTER=false`.

### SSL configurable para Postgres local (2026-11-02, misma rama) [SEGURIDAD]
- `DB_SSL=false` conecta sin SSL a un Postgres local. Sin definir sigue con SSL, y con `NODE_ENV=production` se ignora: siempre va con SSL.
- Ya estaba así y no se cambió: `rejectUnauthorized: false`, la conexión va cifrada pero no verifica el certificado del servidor.
### Cabeceras de seguridad y sesiones (2026-11-03, rama `seguridad-cabeceras-sesion`, sin mergear) [SEGURIDAD]
- `helmet` con CSP en `server.js`. Lleva `'unsafe-inline'` porque el frontend usa scripts y `onclick` en línea: limita a dónde se envían datos por `fetch`, formularios y marcos, pero no frena un XSS por sí sola. Las imágenes admiten cualquier `https:` porque la portada puede ser una URL externa. Sacar `'unsafe-inline'` exige pasar todo el JS en línea a archivos.
- Sesión de 3 días (`JWT_EXPIRES_IN`), antes 30. Cambiar la contraseña sube `User.tokenVersion` y corta las sesiones abiertas.
- Los tokens emitidos antes de este cambio siguen valiendo hasta su vencimiento (30 días) salvo que se cambie la contraseña; para cortarlos todos, rotar `JWT_SECRET`.
- `npm audit fix` subió `body-parser`. Quedan sin arreglo `uuid` y `sequelize` (moderadas): el arreglo automático es incompatible.
- **Al desplegar:** agrega la columna `User.tokenVersion`: NO tener `DB_SYNC_ALTER=false`.

### Cuentas de Mercado Pago cambiables y pausa de ventas (2026-11-02, sin commitear)
- **Motivo:** el organizador va a cobrar con distintas cuentas de Mercado Pago a lo largo de la venta (una primero, otra después). Con un solo `MERCADOPAGO_ACCESS_TOKEN`, cambiar de cuenta con compras en curso hacía que el aviso de pago diera 404 y el comprador pagara sin recibir la entrada.
- **Cuentas en la base** (`PaymentAccount`, `backend/models/`): nombre, access token **cifrado** (AES-256-GCM, clave `PAYMENT_ACCOUNTS_KEY`; `utils/secrets.js`) y cuál está activa. Se administran en `/admin` > Pagos (`/api/payment-accounts`, solo admin). Al agregar una, se verifica el token contra `GET /users/me` de Mercado Pago. El token nunca vuelve al navegador (solo los últimos 4 caracteres).
- **Cada compra recuerda su cuenta** (`Purchase.paymentAccountId`) y la `notification_url` lleva `?acc=<id>`: el webhook confirma el pago con el token de esa cuenta aunque después cambie la activa. Sin `acc` (compras anteriores) usa `MERCADOPAGO_ACCESS_TOKEN`, nunca la cuenta activa. Sin cuenta activa, los pagos nuevos también salen por ese token.
- **Pausa de ventas** (`Setting`, clave `salesPaused`): el checkout responde 503 y la página del evento avisa y no deja elegir entradas. Los webhooks y las entradas ya emitidas siguen andando. **Activar una cuenta exige tener las ventas pausadas** (409 si no): flujo = pausar, activar la otra, reanudar. Una cuenta activa o con compras no se puede borrar (su token hace falta para confirmar pagos).
- **Validación del monto en el webhook** (pendiente cerrado): si la pasarela informa el monto (hoy Mercado Pago: `transaction_amount` y `currency_id`) y no coincide con el de la compra o no es ARS, no se emiten entradas, la compra sigue `pending` y el log dice `PAGO CON MONTO DISTINTO` (hay que revisarlo a mano). Mock y Nave no informan monto y no se validan.
- **Al desplegar:** agrega las tablas `PaymentAccounts` y `Settings` y la columna `Purchases.paymentAccountId`: NO tener `DB_SYNC_ALTER=false`. Hay que **cargar `PAYMENT_ACCOUNTS_KEY` en Render** (frase larga y secreta; si se pierde, se vuelven a cargar las cuentas).
- 114 tests pasan (11 nuevos en `test/paymentAccounts.test.js`).

## Decisiones tomadas
- **Pasarela elegida: Mercado Pago.** Nave exige CUIT y el usuario no tiene. Nave queda implementado por si se consigue.
- **Cobro del primer evento:** por ahora con la cuenta del usuario, solo para probar y dejar todo configurado. Después se usa la cuenta del organizador, o Marketplace de Mercado Pago si hay varios organizadores. Desde el 2026-11-02 se cambia de cuenta desde `/admin` > Pagos, sin tocar Render (ver "Cuentas de Mercado Pago cambiables").
- **Un pago rechazado queda "pendiente"** y no libera el cupo, porque el comprador puede reintentar sobre la misma preferencia. Si se liberara y el reintento se aprobara, se cobraría sin emitir entradas. Solo cancelado, devuelto o contracargo liberan el cupo.
- **Los webhooks no se creen:** del aviso solo se toma el id del pago y el estado real se consulta a la API con las credenciales del comercio. No se sigue ninguna URL que venga en el body.
- **El id de la compra** es el `external_reference` / `external_payment_id` que se manda a la pasarela, y también el `gatewayId` para encontrar la compra al llegar el webhook.
- **Mock bloqueado en producción** (`NODE_ENV=production` lo rechaza).

## Configuración (`backend/.env`, ver `.env.example`)
- `PAYMENT_PROVIDER`: `mock` | `mercadopago` | `nave`
- Mercado Pago: `PAYMENT_ACCOUNTS_KEY` (clave que cifra los tokens de las cuentas del panel), `MERCADOPAGO_ACCESS_TOKEN` (cuenta por defecto si no hay ninguna activa en el panel), `BACKEND_URL` (dirección pública del backend, ahí avisa los pagos a `/api/purchases/webhook`)
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
- Una compra era de un solo lote; **desde el carrito puede llevar varios** (ver "Carrito" abajo). Guarda `lotName` y `unitPrice` tal como estaban al comprar (editar el lote después no cambia las compras).
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
- [x] Verificar que el monto pagado coincida con el de la compra al procesar el webhook (2026-11-02)
- [ ] Mirar los logs de Render buscando también `PAGO CON MONTO DISTINTO`
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

### Post-fiesta: endurecer el login (H-03 de PLAN.md / T1.14 a T1.19 de TAREAS.md) [SEGURIDAD]
Decisión del usuario (2026-11-04): por ahora la app es para un solo evento, así que NO se implementa el endurecimiento completo; queda para la etapa posterior a la fiesta. Lo que falta, para retomarlo:
- MFA TOTP obligatorio para admin y organizador (staff opcional) con códigos de recuperación; hoy entra cualquiera que tenga email y clave.
- Claves de 12+ caracteres con lista de claves comunes (hoy el mínimo es 8, `MIN_PASSWORD_LENGTH` en `userController.js`) y bcrypt coste 12 (hoy 10, `models/User.js`).
- Bloqueo por cuenta (5 fallos → 15 min, se duplica hasta 24 h; hoy solo hay límite por IP) y mismo 401 para cuenta inexistente / clave mala / rol sin acceso / bloqueada, con hash ficticio para igualar tiempos (hoy "sin rol" responde 403 y la cuenta inexistente responde más rápido).
- Decisiones pendientes: quién recupera el acceso si el admin pierde el celular (plan: códigos de recuperación y, último recurso, reseteo desde la consola de Render) y si el staff usa MFA.
- Mientras tanto se usan direcciones renombradas (ver abajo) y claves largas elegidas a mano.

### Post-fiesta: pendientes que se dejaron a propósito (decisión del usuario, 2026-11-04)
Nada de esto bloquea el evento. Detalle de cada tarea en TAREAS.md.
- **Login (H-03, T1.14 a T1.19):** ver la sección de arriba (MFA, claves de 12, bloqueo por cuenta).
- **Firma del webhook de Mercado Pago (T2.11 y T2.12):** hoy el webhook no confía en el aviso (consulta el estado real a la API de Mercado Pago) y exige que la cuenta de la URL sea la de la compra (H-01, hecho). La firma `x-signature` sería una tercera capa. Cuesta una columna nueva (`PaymentAccount.webhookSecretEnc`), el secreto en el panel de Mercado Pago y un campo en Pagos; empezar con la firma opcional (aviso en el log) para no dejar de confirmar pagos si se configura mal. La cuenta de Mercado Pago es REAL desde hace tiempo (los textos viejos que dicen "prueba" están desactualizados).
- **Sesiones (T2.03 y T2.04):** JWT con emisor, audiencia y duración por rol, logout y cerrar todas las sesiones. Cierra las sesiones abiertas y toca el frontend: no hacerlo con ventas o puerta en curso.
- **Resto de la Ola 2:** secretos v2 con rotación (T2.09 y T2.10), TLS verificado a Postgres (T2.05 y T2.06, probar en Render), validación de secretos al arrancar (T2.20, solo como aviso), CSP estricta sin JavaScript en línea (T2.01 y T2.02).
- **T3.01 y T3.02:** el listado de compradores devuelve el link privado (`accessToken`) de cada compra; pasarlo a un endpoint aparte (toca el botón «Copiar link» del frontend).
- **Infraestructura y documentos:** migraciones con Umzug, CI, backups y simulacro de restauración, Node fijado, `render.yaml` completo y la Ola 4 documental.
- **Seguridad menor sin hacer:** captcha en el checkout y verificación del certificado de la base.

### Futuro
- [ ] **Varios organizadores:** hoy hay un solo evento de un organizador externo. Con más organizadores, pasar a Marketplace de Mercado Pago: cada organizador vincula su cuenta y cada venta va directo a él, con comisión automática. Implica guardar en cada evento a qué cuenta de pago corresponde, usar esas credenciales en `createPayment` y una pantalla de "Vincular Mercado Pago".
- [ ] Nave: si se consigue CUIT, pedir credenciales a integraciones@navenegocios.com (CUIT, código de vinculación de Nave > Integraciones > Tienda Online Propia, dos `notification_url`)

## Notas
- Documentación de Nave: https://developer-portal-doc-mfe-website-mfe.ranty.io/nave/online-payments/checkout
- Documentación de Mercado Pago: https://www.mercadopago.com.ar/developers/es/docs/checkout-pro
- Las credenciales nunca van al chat, a git ni a lugares públicos.

### Carrito: una compra con varios lotes (2026-10-31, sin desplegar)
- La página `/e/<slug>` funciona en dos pasos, como Passline: 1) elegir cuántas entradas de cada tipo (select 0 a 10 por tipo, tope de 10 en total); 2) resumen con la lista, un reloj de 10 min y los datos del comprador (nombre, email y repetir email).
- Backend: `POST /api/purchases/checkout` acepta `items: [{ lotId, quantity }]` (el formato `{ lotId, quantity }` sigue andando). Nuevo modelo `PurchaseItem` (una línea por lote) y `Ticket.lotId/lotName` (cada entrada sabe de qué tipo es). Reserva todo o nada, con los lotes bloqueados en orden; el tope por compra cuenta todas las entradas del carrito. Webhook, vencimiento y reserva tardía trabajan por línea (`itemsOf`, `reserveItems` en `utils/purchases.js`). Las pasarelas reciben `items` (Mercado Pago y Nave arman una línea por lote).
- El cupo se reserva al **finalizar la compra**, no al pasar al resumen: el reloj del resumen es visual. Passline reserva al pasar al resumen; se decidió dejarlo como estaba.
- **Al desplegar:** crea la tabla `PurchaseItems` y las columnas `Tickets.lotId/lotName`: `DB_SYNC_ALTER` no puede estar en `false` ese día. No probado contra Postgres ni contra Mercado Pago real (los tests usan SQLite y una pasarela simulada). 90 tests pasan.

### Edad mínima personalizable (2026-11-03)
- Nueva columna `Event.minAge` (entero 1-99, null = sin etiqueta); el admin la carga en un campo numérico (sugeridas 16/18/21/23) y la API acepta `minAge`, o `adultsOnly` por compatibilidad (true = 18). Eventos viejos con `adultsOnly` se leen como +18 sin migrar datos.
- **Al desplegar:** agrega la columna `Event.minAge`: NO tener `DB_SYNC_ALTER=false`.

### Packs con descuento por evento (2026-11-03, sin commitear) [SEGURIDAD: toca precios]
- Nuevo modelo `Pack` (evento, lote, cantidad, % de descuento): "Pack x5 al 5%", "Pack x10 al 10%", configurables por evento desde `/admin` > editar evento > Packs con descuento. Se compra de a packs enteros: 1 pack de 5 = 5 entradas con QR propio.
- Checkout: `packs: [{packId,count}]` además de `items`. Precio por entrada = `round(precio*(100-%))/100`, guardado en `PurchaseItem.unitPrice` con `packSize` y `discountPercent`. Borrar un lote borra sus packs; borrar un pack no toca compras hechas.
- Límites: los packs cuentan para `MAX_TICKETS_PER_PURCHASE` (10 por defecto): un pack de 10 ocupa toda la compra.
- Tests: `backend/test/packs.test.js` (12). Con `PURCHASE_HOLD_MINUTES` definida en `.env` fallan 2 tests de `limits.test.js` (ya pasaba antes de esto); correr con `PURCHASE_HOLD_MINUTES= npm test`.
- **Al desplegar:** agrega la tabla `Packs` y las columnas `PurchaseItem.packSize/discountPercent`: NO tener `DB_SYNC_ALTER=false`.

### Rol organizador por evento (2026-11-03, sin commitear) [SEGURIDAD: permisos, cuentas de cobro y datos personales]
- Nuevo rol `organizer`. El admin lo crea en /admin > Staff y lo asigna desde el formulario del evento (campo "Organizador"). Entra a `/organizador` y, solo en SUS eventos: ve compradores (nombre, email, entradas; con export CSV), crea y borra staff (queda acotado a ese evento con `User.eventId`), escanea QR y maneja pagos (agrega/activa/borra cuentas de Mercado Pago propias del evento, pausa y reanuda las ventas del evento).
- Decisión: las cuentas del organizador son de cada evento y no se mezclan con las generales del admin (`PaymentAccount.eventId`). Un evento sin cuenta propia cobra con la cuenta activa de la plataforma. **La plata de un evento con cuenta propia va a la cuenta del organizador.**
- Pausa de ventas por evento (`Event.salesPaused`, checkout responde 503) independiente de la pausa general. Cambiar la cuenta del evento exige pausarlo, como en el panel general.
- (Reemplazado por «Staff por evento», abajo: ya no hay staff general.) Borrar un organizador deja sus eventos sin organizador (su staff queda; lo borra el admin).
- Tests: `backend/test/organizer.test.js` (10): aislamiento entre organizadores, staff, escáner, cuentas y checkout con la cuenta del evento. Corren 137 en total con `PURCHASE_HOLD_MINUTES=` vacío.
- **Al desplegar:** agrega `User.eventId`, `Event.organizerId/salesPaused/paymentAccountId`, `PaymentAccount.eventId` y el valor `organizer` del enum de `User.role`: NO tener `DB_SYNC_ALTER=false`. El enum en Postgres no se probó en una base real (solo SQLite): probarlo en una base de prueba antes de producción.

### Staff por evento (2026-11-03, rama `main`, sin desplegar) [SEGURIDAD: permisos]
- **Pedido del usuario:** el único usuario general es el admin. Todo staff pertenece a uno o varios eventos, y se aclara al cargarlo. Un organizador puede tener varios eventos y un staff puede repetirse en varios.
- Tabla nueva `StaffEvent` (`userId` + `eventId`, par único). `canScanEvent` ahora es async y mira esa tabla; `GET /api/checkin/my-events` lista solo los eventos asignados. `User.eventId` queda en desuso.
- Admin: `POST /api/users` exige `eventIds` para el staff (400 si falta o hay un evento inexistente); `PUT /api/users/:id` los cambia. En /admin > Personal hay casillas de eventos al crear, una columna «Eventos» y un botón «Eventos» para editarlos.
- Organizador: al crear staff puede marcar también otros eventos SUYOS (403 si manda uno ajeno). «Borrar» quita al staff del evento y borra el usuario solo si no le quedan eventos. Si el staff también está en eventos de otro organizador, no puede cambiarle la clave ni los eventos (403: lo hace el admin) y no ve los eventos ajenos.
- Borrar un evento sin compras borra sus asignaciones.
- **Migración:** al arrancar, `migrateStaffEvents` pasa los `User.eventId` viejos (staff de organizadores) a `StaffEvent`. **El staff general que ya existe en producción (`eventId` null) queda SIN eventos y deja de poder escanear hasta que el admin le asigne eventos** en /admin > Personal > «Eventos».
- **Al desplegar:** crea la tabla `StaffEvents` (con `DB_SYNC_ALTER=false` las tablas faltantes igual se crean, pero conviene tenerlo en `true` esa vez). Probado solo en SQLite.
- Tests: 138 con `PURCHASE_HOLD_MINUTES=` vacío (nuevo caso de staff en varios eventos en `organizer.test.js`; ajustados `checkin` y `roles`).

### Recuperación de entradas (2026-11-04, sin desplegar)
- Pensado para salir a producción real mientras el dominio y `RESEND_API_KEY` no estén configurados: el comprador puede perder el link de sus entradas.
- **Comprador** (`/e/<slug>`): "Mis entradas" muestra el aviso «Guardá este link» con botón **Copiar link**; las compras se recuerdan en `localStorage` (`ticketera_compras`) y el paso 1 de la compra muestra «Tus compras en este dispositivo» con acceso directo.
- **Admin y organizador** (compradores del evento): por cada compra pagada, botón **Copiar link** (el mismo `#/entradas/<token>` del mail, armado con el origen actual) y **Enviar mail**. El reenvío es `POST /api/purchases/event/:eventId/:purchaseId/resend` (`protect` + `eventManager`: el organizador solo en sus eventos; solo compras `completed`; espera de 30 s entre reenvíos de la misma compra, en memoria). Si el email no está configurado responde 503 con «Copiá el link y mandáselo a mano»; si Resend falla, 502.
- El link es por compra (no por entrada): una compra de varias entradas comparte el link. Cambiar de teléfono sigue necesitando el mail o que el admin pase el link.
- 144 tests pasan (`test/resend.test.js`, con Resend interceptado).

### Devoluciones y contracargos anulan las entradas (2026-11-04, sin desplegar)
- **Problema que se encontró:** el aviso de Mercado Pago/Nave de un pago devuelto (`refunded`) o contracargado (`charged_back`) llegaba como «rechazado», y como solo se procesaba si la compra seguía pendiente, una compra ya paga **no cambiaba**: las entradas seguían siendo válidas aunque la plata ya se hubiera devuelto.
- **Ahora:** las pasarelas informan `refunded` (MP: `refunded`/`charged_back`; Nave: `REFUNDED`/`CHARGED_BACK`/`PURCHASE_REVERSED`). El webhook de una compra `completed` la pasa a `refunded` y anula (`void`) sus entradas todavía sin usar (`voidPurchase` en `purchaseController.js`; el escáner ya rechazaba `void`). Las que ya entraron no se tocan: se loguea cuántas. Log: `COMPRA DEVUELTA O CONTRACARGADA`. Una devolución de una compra todavía pendiente se sigue tratando como rechazo (libera el cupo). El cupo de una compra devuelta NO se libera solo.
- **A mano:** botón **Anular** por compra paga en `/admin` y `/organizador` (`POST /api/purchases/event/:eventId/:purchaseId/void`, `protect` + `eventManager`). No devuelve el dinero: eso se hace en la cuenta de pagos. Sirve si el aviso de la pasarela tarda o no llega. Filtro «Devueltas» en la lista de compradores; la página del comprador avisa que la compra fue devuelta.
- Un contracargo puede llegar semanas después, cuando el evento ya pasó: anular ayuda solo si el aviso llega antes de la puerta. No probado con avisos reales de Mercado Pago (tests con la pasarela simulada). 150 tests pasan (`test/refunds.test.js`).

### Endurecimiento SOC 2 / ISO 27001, primer tramo de la Ola 1 (2026-11-04, rama `hardening-soc2-iso27001`, sin desplegar) [SEGURIDAD: auth, permisos, datos personales, cobros]
- **Plan y tablero:** `PLAN.md` (hallazgos H-xx/I-xx, decisiones, orden de despliegue D0–D3, acciones manuales M-xx) y `TAREAS.md`. Esto es solo el primer tramo: **no equivale a estar en cumplimiento**; quedan unas 70 tareas (MFA, migraciones, CSP, JWT, firma de webhook, CI, backups, runbooks, políticas).
- **Webhook (H-01, T1.01):** la notificación de la pasarela devuelve el `accountId` con el que se consultó el pago y se compara con `Purchase.paymentAccountId`; si no coincide, falta o es de otra cuenta → 404, log `WEBHOOK_ACC_MISMATCH` y fila de auditoría. **Fail-closed:** toda pasarela (también `mock` y `nave`) debe devolver la clave `accountId` (null si no hay cuenta); una pasarela nueva que no lo haga será rechazada.
- **Logs sin datos personales (H-04, parcial):** `utils/redact.js` (`maskEmail`, `scrubFreeText`). En producción el mailer no escribe el email ni el link con `accessToken`. No hay `logger.js` ni códigos de log estables todavía (T1.04).
- **AuditLog (H-02, T1.11–T1.13):** modelo append-only (hooks de Sequelize + trigger Postgres `audit_log_append_only` creado tras el `sync`), `GET /api/audit` solo admin, y cada evento sale también como JSON `{"audit":true,...}` por stdout. `utils/audit.js`: `audit()` nunca lanza (best effort); con `strict: true` el insert va dentro de la transacción, falla la acción si falla el registro y el log sale en `afterCommit`. **Estrictas:** `PURCHASE_VOID`, `PURCHASE_VOID_AUTO`, `PAYMENT_ACCOUNT_CREATE/ACTIVATE/DELETE`. Las demás acciones (login, eventos, lotes, packs, usuarios, staff, `SALES_*`) no. Además: `CHECKIN_OK/REJECTED` (un `bulkCreate` por sync, sin auditar reenvíos idempotentes), `ACCESS_DENIED` (método + patrón de ruta, nunca la URL concreta ni query) y `PAYMENT_CONFIRMED` (post-commit, no estricta por decisión: no se revierte un pago cobrado).
- **Cambios sobre lo de nico (recuperación/anulación):** `POST .../void` exige `reason` (3–200 caracteres); se guarda enmascarado (emails y secuencias de 7+ dígitos → `***`) porque AuditLog no se puede borrar; el `prompt` del frontend avisa de no poner datos personales. El mensaje del reenvío usa el email enmascarado.
- **Tests:** 216 pasan, también con el `.env` local (`limits.test.js` ya no depende de `PURCHASE_HOLD_MINUTES`). Probado solo en SQLite: **el trigger y el comportamiento estricto no se probaron en Postgres real**.
- **A tener en cuenta más adelante:**
  - `AuditLog` se crea con `sync`, sin migración (T1.08–T1.11). Con `alter` activo no hace falta nada especial, pero hay que migrarla antes de apagar `sync` en producción.
  - La retención de 1 año no está automatizada: la purga es manual y exige deshabilitar el trigger. El usuario de la app es dueño de la tabla y puede quitarlo, así que no es inmutabilidad real (un log WORM externo sería la mejora). IP y user-agent son datos personales: declararlos en la política de privacidad (T4.xx).
  - Deuda registrada en `TAREAS.md`: T1.33 (chequeos al borrar cuentas de pago fuera de la transacción), T1.34 (`PAYMENT_REJECTED`), T1.35 (logout: no existe el endpoint), T1.36 (estricto para `SALES_*`/`USER_*`), T1.37 (documentar que `PAYMENT_CONFIRMED` no es estricta).
  - Sin límite de velocidad propio para los 403 ni para `LOGIN_FAIL` anónimo más allá de `authLimiter` (30 por IP cada 15 min).
  - `lastResend` (reenvío de entradas) sigue en memoria, sin tope por usuario ni limpieza (H-18, T3.10); el link de entradas (`accessToken`) no vence y vive en `localStorage` del comprador.
  - Latencia del check-in con carga no medida; frontend de anulación solo con `node --check`, sin probar en el navegador.
  - **Antes de desplegar (D0):** copia de la base y un momento tranquilo (sin ingreso en puerta; pausar ventas es opcional). Solo `AuditLog` es tabla nueva: con `DB_SYNC_ALTER=false` se crea sola. **Ensayo en Postgres local hecho el 2026-11-04 (20/20 pasos OK):** tabla y trigger creados con `alter=false`, trigger bloquea UPDATE/DELETE, la auditoría estricta revierte la acción real si falla el registro, una `pending` previa se confirma y el modo `production` con SSL arranca. **No cubierto:** Mercado Pago real, Resend, copia de la base de prod; hacer una compra de prueba real tras el deploy. Las tareas `[SEGURIDAD]` T1.28–T1.32, T3.04 y T3.05 quedaron **cerradas, aprobadas por el usuario el 2026-11-04** (ya desplegadas en `prod`); T2.07 y T3.03 tienen lo hecho aprobado pero siguen abiertas. Estado de `prod` al 2026-11-04: `main` y `prod` iguales.

### Direcciones renombradas: /adminGt, /organizadorGt, /staffGt (2026-11-04, sin desplegar) [SEGURIDAD: discreción, no reemplaza el login]
- Las carpetas de `frontend/` pasaron de `admin`, `organizador` y `staff` a `adminGt`, `organizadorGt` y `staffGt`; las direcciones viejas responden 404. Sin variables de entorno ni código en el servidor (se probó una versión con `ADMIN_PATH`/`ORGANIZER_PATH`/`STAFF_PATH` y se descartó). Los enlaces entre sitios y los textos del panel se actualizaron.
- Límite: ocultar la dirección no protege la API. `POST /api/auth/login` sigue público; la defensa real son las claves largas y al azar que elige el admin, más el límite por IP (30 cada 15 min). Si hace falta más discreción, cambiar el sufijo `Gt` por algo menos obvio renombrando las carpetas.
- Avisar a quienes ya tenían guardadas las direcciones viejas (admin, organizadores, staff).

### Endurecimiento menor del backend (2026-11-04, sin desplegar) [SEGURIDAD]
Tareas del plan del otro dev (TAREAS.md): T2.07 (parcial), T2.13, T2.22, T3.03, T3.04, T3.05 y parte de T3.06. Sin tocar Mercado Pago ni el modelo de datos.
- **Sync del escáner (T2.07):** ya no envía `buyerEmail`. Sigue enviando `buyerName` A PROPÓSITO (el staff lo ve en la puerta para comprobar el DNI): el criterio de aceptación de T2.07 que pide quitarlo no se aplica por decisión del usuario.
- **Límites por IP (T2.13 y /tickets):** webhook 300 por minuto (`RATE_LIMIT_WEBHOOK_MAX`) y link privado de la compra 120 cada 10 min (`RATE_LIMIT_TICKETS_MAX`); 0 = sin límite. No se acotó el cuerpo del webhook por ruta.
- **`ensureAdmin` (T3.03):** solo crea el admin si no existe ninguno y el email no está usado; nunca asciende una cuenta existente. Con esto `ADMIN_EMAIL`/`ADMIN_PASSWORD` se pueden borrar de Render.
- **API pública (T3.04):** los eventos ya no incluyen `userId` ni el nombre del admin (`User`) para visitantes; el admin sí los ve.
- **Escaneos (T3.05):** un id de escaneo que ya existe en OTRO evento no se devuelve ni se modifica (resultado `invalid`).
- **Validaciones (T3.06 parcial):** `deviceId` hasta 64 caracteres; `buyerEmail` string, formato válido y hasta 254. Falta el límite de cuerpo JSON por ruta y la lista blanca de `status`.
- **`/health` (T2.22):** hace `SELECT 1` con tope de 2 s; responde `{"status":"ok"}` o 503 `{"status":"degraded"}`, sin entorno ni versión (Render lo usa como healthCheckPath).

### Cuentas por evento, evento «no listado», cortesías y paneles con marca GT (2026-11-05/06, rama `main`, SIN desplegar a `prod`) [SEGURIDAD: cobros, permisos]
Hecho en una sola tanda con el dueño, antes de la venta real del evento «7D/6D - CULP». **Para quien siga: leé esto antes de tocar pagos, eventos o compras.**

**Para desplegar** (hoy `main` está adelante de `prod`): hay tres columnas nuevas (`Event.unlisted`, `Event.mapQuery`, `Purchase.courtesy`), así que el deploy necesita `DB_SYNC_ALTER` sin definir o en `true`; recién después se vuelve a `false` (con `false` el arranque se rompe). Después del deploy **todos los eventos quedan sin cuenta de cobro y no venden** hasta cargar una cuenta en cada uno (ver abajo).

1. **Se eliminaron las cuentas de Mercado Pago generales.** Cada `PaymentAccount` pertenece a un evento (`eventId`); un evento puede tener varias y una sola activa (`Event.paymentAccountId`).
   - `utils/payments/mercadopago.js`: `createPayment` exige `event.paymentAccountId` (si no, lanza error); ya no existe `getActiveAccount`. `getConfig(null)` (webhook sin `?acc=`) usa solo `MERCADOPAGO_ACCESS_TOKEN`, y queda únicamente para confirmar compras viejas.
   - `purchaseController.createCheckoutSession`: con pasarela `mercadopago` y evento sin cuenta activa responde 503 **antes** de reservar cupo.
   - `paymentAccountController` / `paymentAccountRoutes`: se quitaron listar, crear, activar y borrar generales. `/api/payment-accounts` ahora solo tiene `GET /` (estado: pausa general + compras pendientes + pasarela) y `PUT /sales-paused` (pausa general de emergencia). `createPaymentAccount` se sigue usando desde `/api/organizer/events/:eventId/payments/accounts` (el middleware `eventManager` deja pasar al admin).
   - `organizerController.activateAccount`: la **primera** cuenta de un evento se activa sin pausar; cambiar a otra exige las ventas del evento pausadas. `getMyEvents` agrega `hasPaymentAccount`.
   - Frontend: `/adminGt` > Pagos = pausa general + lista de eventos con «Administrar cobro» (cargar/activar/borrar cuentas de ese evento, pausa del evento). El admin también puede entrar a `/organizadorGt` (el login acepta rol `admin`; el backend ya lo permitía y ve todos los eventos).
   - Una cuenta de un evento no se puede activar en otro (404). Tests: `paymentAccounts.test.js` reescrito con rutas por evento + un test nuevo («sin cuenta activa el evento no vende…»); `organizer`, `audit` y `payments` adaptados.
   - **Qué hacer en prod:** si ya se habían cargado cuentas en el viejo Pagos general, no se ven más; hay que volver a cargarlas en cada evento. Las compras ya hechas con ellas siguen confirmándose (guardan su `paymentAccountId`). Revisar que cada cuenta quede en el evento correcto antes de activarla: nada detecta un token pegado en el evento equivocado.

2. **Evento «no listado»** (`Event.unlisted`, boolean, default false): no aparece en el listado público (`GET /api/events` filtra `unlisted = false` para no-admin) pero se abre y se vende por su link `/e/<slug>`. Checkbox «No listado» en el formulario del evento en `/adminGt` y etiqueta en la lista. **No es privado**: quien tenga el link lo ve. Test: `unlisted.test.js`.

3. **Cortesías** (solo admin): entradas sin pago, por evento. `controllers/courtesyController.js`, `routes/courtesyRoutes.js`, montado en `/api/courtesies/event/:eventId[/:id[/send|/void]]`. Modelo: un `Purchase` con la columna nueva `courtesy = true`, `status = completed`, `totalPrice = 0`, sin lote ni pasarela, con un `Ticket` por persona (código normal de `generateTicketCode`). No descuentan cupo de ningún lote. El escáner no las distingue. Crear **no** manda mail: el botón «Enviar mail» (`/send`, reutiliza `sendPurchaseEmail`, cooldown 30 s) lo manda aparte. Se puede corregir nombre/email y anular (reutiliza `voidPurchase`). Auditoría `COURTESY_CREATE/SEND/UPDATE/VOID` sin el email. UI: `/adminGt`, botón «Cortesías» en cada evento y en Compradores; en Compradores llevan la etiqueta «Cortesía» y «Entradas vendidas» no las cuenta (hay una tarjeta aparte). Para esto `purchaseController` ahora exporta `sendPurchaseEmail` y `voidPurchase`. Test: `courtesies.test.js`.

4. **Marca en los paneles internos:** `/staffGt`, `/adminGt` y `/organizadorGt` pasaron de «🎟️ Kaiser Tikets» a «GT Tickets» con el logo GT (mismo SVG del sitio público); `RESEND_FROM` de ejemplo en `.env.example` actualizado. El sitio público ya se había cambiado antes (commit `5fb4ddc`).

**Contexto de infraestructura (no está en el repo):** dominio `tickets.gambetech.com.ar` activo en Render con HTTPS; dominio `gambetech.com.ar` verificado en Resend con los registros DNS en Donweb; DB de Render sin acceso desde internet (reglas de IP quitadas); `DB_SYNC_ALTER` se pone en `false` cuando no haya cambios de modelos. Variables de entorno de mails en Render (las carga el dueño, nunca en el repo): `RESEND_API_KEY`, `RESEND_FROM=Tickets <tickets@gambetech.com.ar>`, `FRONTEND_URL` y `BACKEND_URL` = `https://tickets.gambetech.com.ar`. Si en los logs aparece «EMAIL NO ENVIADO: falta RESEND_API_KEY», todavía no están guardadas.

**Descartado a propósito** (el dueño prefirió no hacerlo): ocultar eventos con una marca en la descripción (`[oculto]`) o con una lista de slugs en el frontend; ocultar lotes solo en el frontend. Si alguien lo propone de nuevo, ya existe el campo `unlisted`.

**Tests:** 277 pasan, 0 fallan (`cd backend && PURCHASE_HOLD_MINUTES= npm test`, verificado el 2026-11-06).

### Tandas de entradas (2026-11-10, árbol de `main`, sin commit y sin desplegar) [CUPO Y PRECIOS: cambia qué se puede vender]
- **Qué es:** un lote puede esperar a que se agote el de arriba. Modelo y ejemplo en `CLAUDE.md` (Arquitectura). Diseño en `PLAN.md` («Tandas de entradas secuenciales»); tareas TT.01 a TT.11 en `TAREAS.md`.
- **Estado:**
  - Hecho con tests: columna `Lot.afterPrevious`, `utils/tiers.js`, `locked` en la API, 409 `LOT_LOCKED` en el checkout, reorden de lotes y alta/edición con el modo.
  - Hecho en la página pública y en `/adminGt`, pero **sin probar en el navegador**: `uiTiers.test.js` y `uiTiersAdmin.test.js` solo revisan el texto y la estructura del código.
  - Pendiente: TT.08 (recorrido visual y concurrencia en Postgres). TT.03 (el checkout que rechaza tandas cerradas) espera la aprobación del usuario.
- **Tests:** el conteo estático de `test(`/`it(` en `backend/test/` da 325 (34 archivos). La última corrida completa registrada fue 324/324, antes de agregar el test de `uiTiers.test.js`. Falta confirmarlo con una corrida de `npm test`.
- **Decisiones:**
  - **Dos modos por lote, no un «grupo» de texto libre.** El campo `tierGroup` de la primera versión (TT.01 a TT.04) se reemplazó antes de cualquier deploy: la cadena la define el orden del evento, sin nombres que haya que escribir igual en cada lote.
  - **Estado en vivo.** El bloqueo se calcula al consultar, sin guardarlo. Así no queda desfasado con el cupo, pero una tanda que recupera cupo vuelve a cerrar las siguientes, y una compra ya hecha no se revierte.
  - **El checkout bloquea todos los lotes del evento** cuando tiene alguna tanda, en orden de id (sin deadlocks entre carritos), y evalúa la regla dentro de la transacción.
  - **La aprobación tardía no revalida tandas.** El cobro ya se hizo: solo se reserva cupo. Puede emitir entradas de una tanda que cerró después de la compra, si su lote todavía tiene cupo.
  - **Los packs siguen a su lote**, no a la cadena.
  - **`afterPrevious` solo lo ve el admin**; el público ve `locked`.
- **Nota de despliegue:**
  - `Lot.afterPrevious` es una **columna nueva** (boolean, por defecto `false`: los lotes existentes quedan «a la vez», sin cambio de comportamiento). El deploy necesita `DB_SYNC_ALTER` sin definir o en `true`; con `false` el arranque se rompe (`server.js` usa `alter: DB_SYNC_ALTER !== "false"`). Después del deploy, poner `DB_SYNC_ALTER=false` en Render. En Postgres, repetir `alter` duplica índices: no dejarlo en `true`.
  - Va en el mismo deploy que las columnas pendientes de `main`. Según la última nota de «Estado de despliegue», son `Event.unlisted`, `Event.mapQuery` y `Purchase.courtesy` (sección 2026-11-05/06). Las secciones de carrito, packs, staff por evento, recuperación de entradas y endurecimiento (`AuditLog`) también dicen «sin desplegar», y ese estado no las menciona: confirmar con el dueño cuáles ya están en `prod` antes de subir.
  - `tierGroup` nunca llegó a un deploy (los cambios siguen sin commit), así que no hay nada que migrar.
  - Antes de desplegar, copia de la base de Render, como en los deploys anteriores.
- **Pendientes honestos:**
  1. La concurrencia real en Postgres no está probada: SQLite ignora `FOR UPDATE`. El bloqueo de la cadena, la ausencia de deadlocks y el cupo exacto con compras simultáneas quedan por probar (TT.08, opcional pero recomendado).
  2. La prueba visual en el navegador está pendiente: checklist de TT.08 en `TAREAS.md` (gris y «Próximamente», sin selector, etiquetas y ↑/↓ del admin, recarga tras el 409).
  3. TT.03 (checkout) espera la aprobación del usuario, porque cambia qué se puede vender.
  4. La rama 404 de la reserva (lote borrado en plena compra) no tiene test automático (TT.10).
