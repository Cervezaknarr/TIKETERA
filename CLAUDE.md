# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Plataforma de venta de entradas con QR (el usuario y la documentación están en español). `MEMORIA.md` es el registro vivo del proyecto: estado, decisiones, pendientes e historial. Leelo antes de trabajar y actualizalo cuando cambie algo relevante.

## Comandos

Todo se corre desde `backend/` (no hay build ni linter):

```bash
npm install
npm run dev                              # nodemon; copiar .env.example a .env y completarlo
npm test                                 # node --test, corre backend/test/*.test.js
node --test test/lots.test.js            # un archivo
node --test --test-name-pattern="slug" test/slug.test.js   # un test por nombre
```

La web se abre en `http://localhost:5000`: el backend sirve el frontend. Para correr sin Postgres, `DATABASE_URL=sqlite::memory:` (con `sqlite3`); ojo que `sequelize.sync({ alter: true })` falla en SQLite con datos ya cargados, así que usar una base nueva cada vez. `PAYMENT_PROVIDER=mock` simula la pasarela (bloqueado con `NODE_ENV=production`).

## Arquitectura

**Un solo servicio** Express (`backend/server.js`) que expone `/api/*` y sirve `frontend/` como estático. No hay build del frontend: HTML/CSS/JS planos, sin framework, navegación por hash (`#/...`). Tres sitios con estilos y utilidades compartidos (`styles.css`, `common.js`):
- `/` visitantes: listado y compra sin cuenta. `/e/<slug>` abre directo el evento (`server.js` sirve `index.html`; `frontend/event.css` aplica solo bajo `body.ev`).
- `/staff` escáner de QR del personal (`frontend/vendor/jsQR.js`). `/admin` panel del administrador.
- Los permisos viven en las rutas del backend (`middleware/authMiddleware.js`: `protect`, `admin`, `staff`), no en la separación de URLs. Solo `admin` crea/edita eventos y lotes; `staff` solo valida entradas. No hay registro público.

**Modelo de datos** (Sequelize, `backend/models/`): `Event` → `Lot` (tipo de entrada con precio y cupo) → `Purchase` → `Ticket` (una entrada por persona, con código corto), más `Scan` y `User`.
- El precio y el cupo viven en el `Lot`, no en el evento (`Event.ticketPrice/ticketsAvailable` están en desuso; `utils/migrateLots.js` migra eventos viejos al arrancar).
- Una compra es de **un solo lote**. Guarda `lotName` y `unitPrice` tal como estaban al comprar.
- El evento se identifica por `id` o por `slug` (único, generado del título en un hook de `Event` con `utils/slug.js`); `GET /api/events/:id` acepta ambos. La portada (`imageUrl`) es una data URL que el admin reduce en el navegador.

**Compra y pago** (`controllers/purchaseController.js`, `utils/purchases.js`, `utils/paymentWindow.js`): el checkout reserva cupo en una transacción (`reserveStock`) y crea la compra `pending`; la pasarela avisa por webhook y recién ahí se emiten los `Ticket`. Un barrido cada 5 minutos libera el cupo de compras vencidas. Reglas que no son obvias:
- Pasarelas en `utils/payments/` (`mock`, `mercadopago`, `nave`), elegidas con `PAYMENT_PROVIDER`; cada una implementa `createPayment` y `resolveWebhook`. El webhook nunca confía en el body: consulta el estado real a la API de la pasarela. Producción usa Mercado Pago (hoy con credenciales de prueba).
- El webhook es idempotente y se procesa con la compra bloqueada; un pago rechazado deja la compra `pending` (no libera cupo). Un pago aprobado tras vencer intenta reservar de nuevo, y si no hay cupo no emite entradas y loguea `PAGO APROBADO SIN CUPO`.
- Topes y límites por IP (`middleware/rateLimit.js`, variables en `.env.example`); `trust proxy` = 1 en producción.

**Tests** (`backend/test/`): `node:test` con SQLite en memoria. Cada archivo fija `process.env.DATABASE_URL`, `JWT_SECRET`, `NODE_ENV=test` **antes** de `require("../server")`, hace `sequelize.sync({ force: true })` y levanta la app en un puerto libre. Las pasarelas se simulan, no hay tests contra sandboxes reales.

## Despliegue y reglas del repo

- **Render despliega la rama `prod`** (no `main`): cada push a `prod` redespliega el servicio de producción. Config en `render.yaml`. `main` es la rama de trabajo; hoy `main` y `prod` se mantienen iguales.
- **No hacer `git push` (y menos a `prod`) sin que el usuario lo pida explícito.** Varias sesiones de Claude trabajan en paralelo sobre este repo: hacé `git fetch` y `git log` antes de tocar archivos compartidos.
- `sequelize.sync({ alter: true })` modifica tablas al arrancar. Con `DB_SYNC_ALTER=false` solo se crean las tablas faltantes, por lo que un cambio de modelos (columna nueva) **rompe el arranque** si esa variable está en `false`. Desplegar cambios de modelos con alter activo y ponerlo en `false` después (en Postgres, `alter` repetido duplica índices).
- Los archivos usan `core.autocrlf=true`: al editar con scripts, conservá los fines de línea.
- Las credenciales (Mercado Pago, Resend, admin) viven en variables de entorno de Render y `.env`, nunca en el repo.
