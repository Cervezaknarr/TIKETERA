# PLAN — Endurecimiento alineado a SOC 2 (TSC) e ISO/IEC 27001:2022 Anexo A

Proyecto: Kaiser Tikets (`/workspace/proyectos/tiketeraNew/TIKETERA`). Fecha del plan: 2026-11-04.
Origen: dos auditorías de solo lectura (código: H-01..H-18; infraestructura: I-01..I-16).
Tablero de ejecución: `TAREAS.md`. Registro vivo del proyecto: `MEMORIA.md`.

## 1. Objetivo y alcance

**Objetivo:** cerrar los hallazgos de las dos auditorías y dejar los controles técnicos y la
documentación mínima para que una revisión SOC 2 (Seguridad, Disponibilidad, Integridad del
procesamiento, Confidencialidad, Privacidad) o una certificación ISO 27001:2022 encuentre controles
diseñados, implementados y con evidencia.

**Dentro del alcance**
- Backend Express/Sequelize (`backend/`), los cuatro sitios del frontend (`frontend/`), `render.yaml`,
  la configuración del repositorio en GitHub y del servicio en Render.
- Corrección de los hallazgos H-01..H-18 e I-01..I-16.
- Políticas, procedimientos, runbooks, inventario de activos, registro de proveedores y catálogo de
  evidencias (en `docs/`).

**Fuera del alcance** (se registra, no se hace en este plan)
- Auditoría formal, contratación de auditor, pentest externo.
- Rediseño de la arquitectura (sigue siendo un solo servicio Express + Postgres en Render).
- Marketplace de Mercado Pago, Nave, MODO.
- Fallos funcionales conocidos de `MEMORIA.md` que el usuario decidió posponer (borrador visible por su
  slug público, `createEvent` ignora `status`). **Recomendación:** el primero es una fuga de
  información (C1.1 / A.8.3) y conviene sumarlo a la Ola 3 si el usuario lo aprueba.

**Lo que ya está bien y no se rehace:** helmet/HSTS, rate limit por IP, `tokenVersion`, bcrypt, webhook
idempotente con validación de monto, AES-GCM de los tokens de pago, `eventManager`/`scanAccess`,
historial de git sin secretos, `mock` bloqueado en producción.

## 2. Principios de trabajo

1. **Rama:** todo se hace en `hardening-soc2-iso27001`, creada desde `main` (antes, `git fetch` y
   `git log`: hay otras sesiones trabajando sobre el repo). Una ola = un conjunto de commits revisados.
2. **Sin push ni cambios en `prod`** salvo que el usuario lo pida explícitamente. Render despliega `prod`:
   cada despliegue es una acción del usuario o se hace con su orden explícita.
3. **Cambios de esquema con orden de despliegue:** mientras exista `sequelize.sync({ alter })`, una
   columna nueva con `DB_SYNC_ALTER=false` rompe el arranque. Desde la Ola 1 el esquema pasa a
   **migraciones versionadas** y en producción el servidor ya no llama a `sync`. Hasta entonces rige la
   regla de `CLAUDE.md`. Cada despliegue con cambios de esquema va precedido de una copia de la base.
4. **Simplicidad:** sin servicios nuevos salvo los imprescindibles (destino de logs y monitor de uptime,
   que elige el usuario). Se prefiere `node:crypto` y código propio corto y testeado a dependencias
   nuevas; las únicas dependencias nuevas previstas son `umzug` (migraciones) y `eslint` (dev).
5. **Toda tarea que toque autenticación, permisos, secretos o datos personales lleva `[SEGURIDAD]`** y
   el usuario la aprueba antes de cerrarla.
6. **Tests primero en lo crítico:** H-01, H-03, H-04 y H-08 se cierran solo con tests que fallan con el
   código actual y pasan con el arreglo.
7. **Cada ola cierra con:** `tester` (regresión completa + criterios) → `revisor` (diff) →
   `documentador` (README, `CLAUDE.md`, `MEMORIA.md`, docs) → `revisor-docs`.
8. Conservar fines de línea (`core.autocrlf=true`).

## 3. Decisiones de arquitectura (resumen y justificación)

| # | Decisión | Por qué |
|---|----------|---------|
| D1 | H-01: el webhook toma la cuenta de la **compra** y exige `acc == purchase.paymentAccountId` dentro de la transacción; además se guarda `PaymentAccount.collectorId` (de `GET /users/me` al cargar la cuenta) y se exige `payment.collector_id == collectorId`. | La URL no es confiable. La comparación con la compra cierra el ataque sin cambiar el modelo (puede salir como hotfix); el `collectorId` agrega una segunda verificación independiente. |
| D2 | Migraciones con **Umzug** (`backend/migrations/`, `npm run migrate`), ejecutadas como `preDeployCommand` de Render. En producción no se llama a `sync`; en tests y desarrollo con SQLite se sigue usando `sync({ force: true })` y CI verifica que modelos y migraciones no diverjan. | Umzug es una librería chica que ya usa Sequelize; sin CLI ni configuración extra. Elimina `alter` (I-01/H-10) y los índices duplicados. |
| D3 | Línea base de migraciones = esquema de `prod` **después** del despliegue D0 (ver §5). | `main` tiene cambios de modelo sin desplegar; tomar la base después de D0 evita que la migración inicial tenga que adivinar el estado de prod. |
| D4 | `AuditLog` en la misma base, append-only (la app solo inserta; en Postgres un trigger bloquea UPDATE/DELETE) y emisión simultánea como línea JSON a stdout → log stream de Render → proveedor externo con retención ≥ 1 año. | Evidencia de CC6/CC7 y A.8.15 con lo que ya existe; el almacenamiento externo da inmutabilidad práctica y retención sin otro servicio propio. |
| D5 | Logger propio mínimo (`utils/logger.js`): JSON por línea, niveles, `code` estable para alertas y redacción obligatoria (emails enmascarados, tokens nunca). | Resuelve H-04 e I-05 a la vez sin dependencias; los códigos (`PAYMENT_NO_STOCK`, etc.) permiten alertas en el proveedor de logs. |
| D6 | MFA **TOTP** (RFC 6238) con `node:crypto`, obligatorio para `admin` y `organizer`; códigos de recuperación hasheados; secreto cifrado con `utils/secrets.js`; anti-replay por paso. QR con `qrcode` (ya instalado). | Sin dependencias ni proveedores nuevos. El staff (escáner de puerta) queda opcional para no frenar la operación del día del evento. |
| D7 | Contraseñas: mínimo 12, máximo 72 bytes (límite de bcrypt), lista local de contraseñas comunes, bcrypt coste 12 con rehash al iniciar sesión, hash ficticio si el usuario no existe y **401 genérico** para todo fallo. Bloqueo progresivo por cuenta (5 fallos → 15 min, se duplica hasta 24 h). | Más simple que argon2id (dependencia nativa) y suficiente; la lista local evita llamar a un servicio externo de claves filtradas. |
| D8 | Sesión: se mantiene el JWT Bearer, pero con **CSP sin `'unsafe-inline'` para scripts**, `algorithms: ["HS256"]`, `iss`/`aud`, duración corta por rol (admin/organizador 8 h, staff 12 h), logout y «cerrar todas las sesiones» (`tokenVersion++`). | Mover a cookie HttpOnly obliga a rehacer los cuatro sitios y a agregar CSRF; quitar el JS en línea ataca la causa (XSS) y es requisito de todos modos. Se revisa si un auditor lo exige. |
| D9 | `secrets.js` v2: formato `v2:<kid>:<iv>:<tag>:<ct>`, clave de 32 bytes en base64 o derivada con scrypt (sal fija de la app) si es frase, AAD = `paymentAccount:<id>` / `user:<id>:mfa`, `PAYMENT_ACCOUNTS_KEY_PREVIOUS` para rotar, lectura de v1 y re-cifrado perezoso + script. | KDF real, integridad ligada al registro y rotación sin perder cuentas. |
| D10 | Sin `RESEND_API_KEY` en producción: **alerta** (log `EMAIL_DISABLED` al arrancar y en cada envío omitido), no caída. | Hoy producción opera a propósito sin email (recuperación por «Copiar link», `MEMORIA.md`); fallar dejaría el servicio caído. |
| D11 | CI en GitHub Actions; Render con `autoDeployTrigger: checksPass` y `branch: prod`; protección de `prod` en GitHub. | Ningún cambio llega a producción sin tests, revisión y aprobación (CC8.1 / A.8.32). |
| D12 | Backups: PITR/backups gestionados de Render + export manual (`pg_dump`) antes de cada despliegue con cambios de esquema + simulacro de restauración trimestral con registro. Objetivos propuestos: **RPO ≤ 24 h** (≤ minutos si el plan tiene PITR), **RTO ≤ 4 h**. | No agrega almacenamiento externo con credenciales de la base; el simulacro es la evidencia que pide A1.3 / A.8.13. |
| D13 | Node fijado en **24 LTS** (`engines`, `.node-version`, `NODE_VERSION` en Render, CI). Si `sqlite3` no compila, se usa 22 LTS. | Reproducibilidad (A.8.9 / CC8.1). |

## 4. Estructura de carpetas (nuevo o modificado)

```
TIKETERA/
├── PLAN.md, TAREAS.md
├── .github/
│   ├── workflows/ci.yml          # tests, migraciones en Postgres, lint, npm audit
│   ├── workflows/codeql.yml
│   ├── workflows/gitleaks.yml
│   ├── dependabot.yml
│   └── CODEOWNERS
├── .gitignore (+ *.sqlite, datos-local/, *.log), .mailmap, .node-version
├── render.yaml                    # region, branch, autoDeployTrigger, preDeployCommand, NODE_VERSION
├── backend/
│   ├── migrations/                # Umzug: 0001-baseline, 0002-dedupe-indices, 0003-auditlog, ...
│   ├── scripts/                   # migrate.js, rotate-secrets.js, db-export.sh, load-test.js
│   ├── data/common-passwords.txt
│   ├── models/AuditLog.js
│   ├── utils/logger.js, utils/audit.js, utils/totp.js, utils/passwordPolicy.js
│   └── test/ (nuevos: webhookAccount, logging, audit, auth-mfa, secrets-v2, ...)
├── frontend/**/                   # JS en línea movido a archivos .js por sitio
└── docs/
    ├── seguridad/                 # políticas, SoA, inventario, proveedores, plan de incidentes
    ├── runbooks/                  # pagos, restauración, rotación, credencial comprometida
    ├── operacion/                 # monitoreo, despliegue y migraciones, continuidad
    └── evidencias/README.md       # catálogo de evidencias por control y frecuencia
```

## 5. Fases, orden y dependencias

### Ola 0 — Preparación
Crear la rama, línea base de tests y `npm audit`. Sin cambios de comportamiento.

### Ola 1 — Crítico / alto
Orden interno:
1. **H-01** (T1.01–T1.03) primero. **Bloqueante para desplegar el rol organizador a prod**: hoy las cuentas
   por evento (`PaymentAccount.eventId`) están en `main` sin desplegar; no deben llegar a prod sin este
   arreglo. Sin cambio de modelo.
2. **H-04 + logger** (T1.04–T1.05) en paralelo con 1 (archivos distintos salvo `purchaseController.js`:
   T1.04 se aplica después de T1.01 en ese archivo).
3. **Checkpoint D0** (despliegue, lo ordena el usuario): `main` + H-01 + H-04 a `prod` con el flujo actual
   (copia de la base → `DB_SYNC_ALTER` en true → verificar → `DB_SYNC_ALTER=false`). Ensayado antes en
   un Postgres local con la forma de prod (T1.07), incluido el enum `organizer`.
4. **Migraciones** (T1.08–T1.10): Umzug, línea base = esquema de prod post-D0, eliminación de índices
   duplicados, `preDeployCommand`.
5. **Cambios de modelo de la ola, en una sola tanda de migraciones** (dependen de 4):
   `AuditLog` (T1.11), columnas de `User` para MFA/bloqueo (T1.14), `PaymentAccount.collectorId` (T1.03).
6. **AuditLog** (T1.12–T1.13) y **autenticación** (T1.15–T1.19) en paralelo entre sí, coordinando
   `authController.js` (T1.12 instrumenta el login después de T1.15).
7. **CI + protección de rama** (T1.21–T1.22), **backups** (T1.23–T1.24), **monitoreo** (T1.25–T1.26) e
   **incidentes** (T1.27): en paralelo desde el inicio de la ola (no tocan código de negocio).
8. Cierre (T1.90–T1.93) y **despliegue D1** (lo ordena el usuario).

### Ola 2 — Media
- CSP/JS en línea (T2.01 → T2.02) es la tarea más grande; arranca primero.
- JWT y logout (T2.03 → T2.04), TLS Postgres (T2.05 → T2.06), PII del sync (T2.07 → T2.08),
  secrets v2 (T2.09 → T2.10), firma y límite del webhook (T2.11 → T2.12 → T2.13): en paralelo entre sí.
  T2.09 antes de T2.11 (el secreto del webhook se cifra con v2).
- Infra y operación (T2.14–T2.22) en paralelo con todo lo anterior; T2.23 y el cierre al final.
- **Cambio de modelo:** `PaymentAccount.webhookSecretEnc` (T2.11, migración).
- **Despliegue D2:** invalida todas las sesiones (cambian `iss`/`aud`): avisar a admin, organizadores y
  staff; no hacerlo con ventas o puerta en curso.

### Ola 3 — Baja
Tareas chicas e independientes (T3.01–T3.14), casi todas paralelizables. T3.03 (H-12) habilita que el
usuario borre `ADMIN_EMAIL`/`ADMIN_PASSWORD` de Render. T3.08 (H-17) requiere revisar si hay portadas con
URL `https` en la base antes de restringir.

### Ola 4 — Documental
Políticas, SoA, inventario, proveedores, evidencias (T4.01–T4.12). Puede empezar en paralelo desde la
Ola 2 (los documentos describen controles ya decididos), pero se cierra después de la Ola 3 para
reflejar el estado final.

### Orden de despliegue y modelo de datos

| Despliegue | Contenido | Cambios de esquema | Condiciones |
|---|---|---|---|
| D0 | `main` + H-01 + H-04 | Solo la tabla `AuditLog` y su trigger de Postgres: `prod` ya incluye el resto de los modelos (slug, packs, StaffEvent, organizer). Con `DB_SYNC_ALTER=false` el arranque crea las tablas que faltan, así que no hace falta activar `alter`. | Copia de la base; momento tranquilo (sin ingreso en puerta ni evento por abrir; no hace falta pausar las ventas, solo evitar compras `pending` recientes); ensayo en Postgres local (T1.07, hecho el 2026-11-04, ver `MEMORIA.md`). Aviso previo por las URLs `/adminGt`, `/staffGt`, `/organizadorGt`. Opcional: H-01 como hotfix desde `prod` si el usuario lo pide. |
| D1 | Resto de la Ola 1 | Migraciones: baseline (se marca aplicada), dedupe de índices, `AuditLog`, `User` (MFA/bloqueo), `PaymentAccount.collectorId` | Copia de la base; `preDeployCommand: npm run migrate` configurado; el admin tiene una app TOTP a mano (MFA obligatorio al primer login); luego borrar `DB_SYNC_ALTER` de Render. |
| D2 | Ola 2 | `PaymentAccount.webhookSecretEnc` | Copia de la base; aviso de cierre de sesiones; `PAYMENT_ACCOUNTS_KEY_PREVIOUS` si se rota la clave. |
| D3 | Ola 3 | Ninguno previsto (si H-17 limpia portadas, migración de datos) | Después: borrar `ADMIN_EMAIL`/`ADMIN_PASSWORD`. |

Toda migración tiene `down` y se prueba ida y vuelta en Postgres local antes del despliegue.

## 6. Matriz de trazabilidad

Referencias SOC 2 = Trust Services Criteria 2017 (rev. 2022). ISO = ISO/IEC 27001:2022 Anexo A.

| Hallazgo | Sev. | Tareas | SOC 2 | ISO 27001:2022 Anexo A |
|---|---|---|---|---|
| H-01 webhook `acc` sin verificar | Crítica | T1.01, T1.02, T1.03 | CC6.1, CC6.3, PI1.2, PI1.3 | 8.3, 8.26, 8.28, 8.29 |
| H-02 sin AuditLog | Alta | T1.11, T1.12, T1.13, T1.25, T1.26, T3.13 | CC4.1, CC7.2, CC7.3 | 8.15, 8.16, 5.28 |
| H-03 sin MFA, claves débiles, enumeración | Alta | T1.14–T1.19 | CC6.1, CC6.2, CC6.6 | 5.17, 8.5, 8.2 |
| H-04 PII/accessToken en logs | Alta | T1.04, T1.05, T0.03 | CC6.1, C1.1, P4.2 | 5.34, 8.11, 8.12, 8.15 |
| H-05 JWT en localStorage, CSP, sin logout, `algorithms` | Media | T2.01–T2.04 | CC6.1, CC6.6, CC6.8 | 8.5, 8.26, 8.28 |
| H-06 / I-09 TLS Postgres sin verificar | Media | T2.05, T2.06 | CC6.7 | 8.20, 8.21, 8.24 |
| H-07 PII en sync del staff | Media | T2.07, T2.08 | CC6.3, C1.1, P4.1 | 5.15, 5.34, 8.3, 8.11 |
| H-08 KDF/AAD/rotación de `secrets.js` | Media | T2.09, T2.10 | CC6.1 | 8.24 |
| H-09 webhook sin firma ni límite | Media | T1.01, T2.11–T2.13 | CC6.6, PI1.2 | 8.20, 8.26 |
| H-10 / I-01 `alter` sin migraciones, índices duplicados | Media/Alta | T1.06–T1.10, T1.21, T2.15 | CC8.1, CC7.1 | 8.32, 8.9, 8.31 |
| H-11 accessToken e ids de pasarela en listado | Baja | T3.01, T3.02 | CC6.3, C1.1 | 8.3, 5.34 |
| H-12 promoción a admin por `ADMIN_EMAIL` | Baja | T3.03 | CC6.2, CC6.3 | 8.2, 5.18 |
| H-13 API pública expone userId/nombre | Baja | T3.04 | C1.1, P4.1 | 8.3, 5.34 |
| H-14 Scan por id sin `eventId` | Baja | T3.05 | CC6.3 | 8.3 |
| H-15 validación incompleta | Baja | T3.06 | PI1.2, CC6.6 | 8.26, 8.28 |
| H-16 `esc()` en onclick, `ticketera_api` | Baja | T2.01, T3.07 | CC6.8 | 8.28 |
| H-17 portada https externa | Baja | T3.08, T3.09 | CC6.6 | 8.26, 8.23 |
| H-18 `lastResend` sin limpieza | Baja | T3.10 | A1.1 | 8.6 |
| I-02 sin CI, sin protección de prod, sin CODEOWNERS | Alta | T1.21, T1.22, M-01 | CC8.1, CC5.2 | 8.32, 8.4, 8.25, 8.29 |
| I-03 sin backups probados, RPO/RTO | Alta | T1.06, T1.23, T1.24, M-04 | A1.2, A1.3, CC7.5 | 8.13, 5.30 |
| I-04 sin plan de incidentes ni runbooks | Alta | T1.27, T4.08 | CC7.3, CC7.4, CC7.5 | 5.24–5.27, 5.37 |
| I-05 sin monitoreo ni alertas | Alta | T1.04, T1.25, T1.26, M-06, M-07 | CC4.1, CC7.2, A1.1 | 8.15, 8.16, 8.17 |
| I-06 Node sin fijar | Media | T2.14 | CC8.1 | 8.9 |
| I-07 dependencias vulnerables, sin Dependabot | Media | T2.15 | CC7.1 | 8.8 |
| I-08 sin SAST/gitleaks/ESLint/CodeQL | Media | T2.16 | CC7.1, CC8.1 | 8.25, 8.28, 8.29 |
| I-10 `render.yaml` incompleto, `ADMIN_PASSWORD`, CSP | Media | T2.17, T2.02, M-05 | CC8.1, CC6.1 | 8.9, 5.23 |
| I-11 instancia única, continuidad, carga | Media | T2.18, T2.19, M-09 | A1.1, A1.2, CC9.1 | 5.29, 5.30, 8.6, 8.14 |
| I-12 rotación de secretos, MEMORIA desactualizada | Media | T2.09, T2.20, T2.21, M-10 | CC6.1 | 5.17, 8.24 |
| I-13 `.gitignore` | Baja | T3.11, T0.03 | C1.1 | 8.12 |
| I-14 `/health` | Baja | T2.22, T2.23 | A1.1, CC7.2 | 8.16 |
| I-15 higiene de ramas | Baja | T3.12, M-11 | CC8.1 | 8.32, 8.4 |
| I-16 políticas documentales | Baja | T4.01–T4.12 | CC1.4, CC2.2, CC5.3, CC9.2, P4.2, P4.3 | 5.1, 5.9, 5.10, 5.12, 5.19–5.23, 5.31, 5.37, 8.10, 8.25 |
| Datos locales (`../datos-local/server.log`) | Alta | T0.03 | C1.2, P4.3 | 8.10 |

## 7. Criterios de aceptación por fase

**Ola 0:** rama creada desde `main` actualizado, sin push; `npm test` (con `PURCHASE_HOLD_MINUTES=`)
pasa y se registra la cantidad; `npm audit` registrado; `server.log` local borrado con confirmación.

**Ola 1:**
- Un webhook con `acc` distinto del `paymentAccountId` de la compra (o inexistente, o presente cuando la
  compra no tiene cuenta) no emite ni anula entradas, deja log `WEBHOOK_ACC_MISMATCH` y tiene test.
- Ningún log contiene `accessToken` ni emails completos (test que captura stdout/stderr).
- En producción el servidor no ejecuta `sync`; `npm run migrate` crea el esquema completo en un Postgres
  vacío, se aplica sin cambios sobre una copia de prod post-D0 y elimina los índices duplicados; CI
  falla si modelos y migraciones divergen.
- `AuditLog` registra las acciones listadas en T1.12 con autor, IP y fecha; UPDATE/DELETE fallan en
  Postgres; cada evento sale también como JSON en stdout.
- Admin y organizador no pueden entrar sin TOTP; bloqueo por cuenta; 401 genérico idéntico para usuario
  inexistente, clave errónea, rol sin acceso y cuenta bloqueada; política de 12+ y lista de comunes.
- CI corre en cada PR y push a `main`/`prod`; `render.yaml` despliega solo con checks en verde.
- Backups verificados, restauración ensayada con registro, RPO/RTO documentados.
- Alertas definidas por código de log; plan de incidentes y 4 runbooks escritos.

**Ola 2:** CSP sin `'unsafe-inline'` en `script-src` y sin atributos `on*` en los HTML; JWT con
`algorithms`, `iss`, `aud` y duración por rol; logout y «cerrar todas las sesiones»; conexión a Postgres
verificada o por red privada documentada; sync del staff sin nombre ni email; `secrets.js` v2 con
rotación probada; webhook con firma verificada y límite; Node fijado; Dependabot, CodeQL, gitleaks y
ESLint en CI; `npm audit --omit=dev` sin moderadas; `/health` comprueba la base y no expone entorno;
validación de secretos al arrancar; procedimiento de rotación escrito.

**Ola 3:** cada hallazgo H-11..H-18, I-13, I-15 con su criterio de `TAREAS.md` cumplido y test cuando
aplica.

**Ola 4:** las 8 políticas, SoA, inventario de activos, registro de proveedores y catálogo de evidencias
existen, están aprobadas por el usuario (fecha y versión en el encabezado) y `revisor-docs` confirmó que
describen el comportamiento real del código y la configuración.

**Todas las olas:** `npm test` en verde, `revisor` sin observaciones bloqueantes, `MEMORIA.md` y
`CLAUDE.md` actualizados, tareas `[SEGURIDAD]` aprobadas por el usuario.

## 8. Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| D0 lleva a prod `AuditLog` y su trigger, y el reinicio del servicio puede cortar un pago o el ingreso en puerta. El ensayo en Postgres local (2026-11-04) cubrió la tabla, el trigger y el rollback de la auditoría estricta, pero no Mercado Pago real ni una copia de la base de prod | Arranque roto, compra en vuelo con error o staff sin acceso en la puerta | Copia previa; desplegar en un momento tranquilo y sin evento con ingreso abierto; compra de prueba real tras el deploy; rollback = redeploy del commit anterior de `prod` (la tabla y el trigger quedan, son inofensivos); restaurar la copia solo si hubo daño en datos. |
| Línea base de migraciones distinta del esquema real de prod | `migrate` falla en el despliegue | La baseline verifica tablas/columnas esperadas y aborta con mensaje claro; se prueba contra un dump de prod post-D0. |
| El staff general existente queda sin eventos tras D0 (`MEMORIA.md`) | No pueden escanear | Checklist de D0: el admin asigna eventos al staff inmediatamente después. |
| MFA obligatorio bloquea al admin (pierde el teléfono) | Sin acceso de administración | Códigos de recuperación + procedimiento «break-glass» documentado (script con acceso a la base de Render). |
| D2 corta todas las sesiones | Staff desconectado en puerta | No desplegar en día de evento ni con ventas activas. |
| Quitar `'unsafe-inline'` rompe pantallas | Funciones del panel o escáner caídas | Recorrido manual de los 4 sitios por `tester` con la consola sin violaciones CSP. |
| Firma `x-signature` exige el secreto de cada aplicación de MP | Webhooks rechazados → pagos sin entradas | Transición: verificar si hay secreto, alertar si falta; `MP_WEBHOOK_SIGNATURE_REQUIRED=true` solo cuando todas las cuentas lo tengan. |
| Rotar `PAYMENT_ACCOUNTS_KEY` mal | Tokens ilegibles, webhooks sin confirmar | Clave anterior en `_PREVIOUS` durante la ventana; script de re-cifrado con modo `--dry-run`. |
| Instancia única de Render | Caída durante la venta | Monitor externo, plan de continuidad, prueba de carga; escalar plan es decisión del usuario. |
| Varias sesiones de Claude sobre el repo | Conflictos | `git fetch`/`git log` antes de cada tarea; tareas que tocan el mismo archivo no van en paralelo. |

## 9. Acciones manuales del usuario

Los agentes no tienen acceso a estos paneles ni deben ejecutar acciones irreversibles. Cada una deja
evidencia (captura o export con fecha) en el lugar que indica `docs/evidencias/README.md`.

**GitHub (`Cervezaknarr/TIKETERA`)**
- **M-01** Protección de `prod` (y de `main`): PR obligatorio, 1 aprobación, checks de CI requeridos
  (`ci`, `codeql`, `gitleaks`), sin force-push ni borrado, incluir administradores. Después de T1.21.
- **M-02** 2FA obligatorio en la cuenta (y en la organización si se crea); revisar colaboradores
  (AlvaGoncalves y otros) y sus permisos; dar de baja accesos innecesarios.
- **M-03** Activar secret scanning y push protection, Dependabot alerts y security updates, y habilitar
  code scanning (para CodeQL).

**Render**
- **M-04** Confirmar el tipo de backup del plan de Postgres (PITR / diarios) y su retención; ampliarla si
  hace falta para el RPO; hacer el export manual antes de D0, D1, D2; ejecutar con el `devops` el
  simulacro de restauración (T1.24) en una base nueva.
- **M-05** Borrar `ADMIN_PASSWORD` ya; borrar `ADMIN_EMAIL` después de D3 (T3.03); borrar
  `DB_SYNC_ALTER` después de D1; no aprobar cambios de variables que proponga el Blueprint sin mirarlos.
- **M-06** Configurar un **log stream** a un proveedor con retención ≥ 1 año y crear las alertas por
  código definidas en `docs/operacion/monitoreo.md` (T1.26).
- **M-07** Crear el monitor de uptime externo sobre `/health` con aviso por email/teléfono.
- **M-08** Confirmar la **región** del servicio y la base (debe ser la misma; anotarla para `render.yaml`;
  cambiarla exige crear servicios nuevos) y configurar `preDeployCommand`/`NODE_VERSION` si el Blueprint
  no los sincroniza.
- **M-09** Reactivar la tarjeta (estaba pausada) y decidir si se escala el plan o se agrega una segunda
  instancia para el día del evento.
- **M-10 Rotación de claves** (después de D2, con `docs/runbooks/rotacion-secretos.md`): `JWT_SECRET`
  (corta todas las sesiones), `PAYMENT_ACCOUNTS_KEY` (con `_PREVIOUS` y script de re-cifrado),
  `MERCADOPAGO_ACCESS_TOKEN` y secretos de webhook de MP, `RESEND_API_KEY`; contraseñas de los
  organizadores y staff existentes que no cumplan la política nueva. Guardar las claves en un gestor de
  contraseñas con acceso solo del responsable (custodia).
- **M-11** Decidir qué ramas viejas se borran (la lista la arma T3.12; `integracionPagos` se conserva).
- **M-12** Aprobar cada despliegue D0–D3 y cada tarea `[SEGURIDAD]`; aprobar las políticas de la Ola 4
  (incluidos los plazos de retención de datos de compradores).
- **M-13** Mercado Pago: cargar el secreto de firma de webhooks de cada aplicación (T2.11) y verificar que
  el `collector_id` mostrado en el panel coincide con la cuenta esperada.

---

# PLAN — Tandas de entradas secuenciales (2026-11-10)

Tareas: `TAREAS.md` > «Tandas de entradas (TT.xx)». Independiente del plan de endurecimiento de arriba.

## T-1. Objetivo
El admin carga por adelantado las tandas siguientes de un tipo de entrada (p. ej. «General 1.ª tanda»
$10.000, «2.ª tanda» $13.000, «3.ª tanda» $16.000). En `/` y `/e/<slug>` se **ven** todas, pero solo la
tanda actual es comprable; las siguientes aparecen en gris, sin selector de cantidad, con la etiqueta
«Próximamente». Cuando la tanda actual se agota, la siguiente se habilita sola, sin intervención del admin.
Los eventos existentes y los tipos de entrada paralelos (VIP / General) no cambian.

## T-2. Modelo de datos
> **REDISEÑO (TT.11, 2026-11-10):** `Lot.tierGroup` (texto libre) fue **reemplazado** por `Lot.afterPrevious`.
> La funcionalidad no estaba en producción: sin compatibilidad hacia atrás. Lo que sigue describe el modelo vigente.

- **Una columna nueva: `Lot.afterPrevious`** (`BOOLEAN`, `allowNull: false`, `defaultValue: false`). Cada lote
  tiene solo DOS modos:
  - `false` = **a la vez** (en paralelo): se vende normalmente junto a los demás (comportamiento actual).
  - `true` = **se activa después de que se agote el anterior** (el lote inmediatamente anterior por `position`).
- **Cadena:** empieza en un lote con `afterPrevious = false` (la «cabeza») y la forman los lotes consecutivos
  siguientes con `afterPrevious = true`, hasta el siguiente lote con `false` o el final. Un lote paralelo en
  medio abre una cadena nueva. Puede haber varias cadenas por evento. El primer lote del evento con `true` se
  trata como cabeza (no puede esperar a nada).
- **El orden es `Lot.position`, que ya existe** (`withLots` ordena por `position, createdAt`). Desempate:
  `createdAt`, `id`. Reordenar con `lots-order` puede cambiar qué lotes forman cadena (se calcula en vivo).
- **Sin estado almacenado** («activa/bloqueada»): se calcula en vivo (ver T-3). Los lotes existentes quedan con
  `afterPrevious = false`. `migrateLots` no cambia. Sin índice nuevo.
- **Despliegue:** columna nueva → el deploy necesita `DB_SYNC_ALTER` sin definir o en `true` (con `false`
  el arranque se rompe); después se vuelve a `false`.

## T-3. Regla de activación (única fuente: `utils/tiers.js`, función pura)
`lockedLotIds(lots)` → `Set` de ids bloqueados. Dentro de cada evento se ordenan los lotes por
`position, createdAt, id`; **un lote con `afterPrevious = true` está bloqueado si algún lote ANTERIOR de su
misma cadena (cabeza incluida) tiene `ticketsAvailable > 0`.** Los lotes con `afterPrevious = false` nunca
están bloqueados; el primer lote del evento se trata siempre como cabeza.

Consecuencias (todas deseadas y a testear):
- En cada cadena hay como mucho **una** tanda comprable: la primera con cupo. Si todas están en 0, la
  cadena está agotada.
- **Calculada en vivo, sin estado:** si una tanda agotada recupera cupo (el barrido libera una compra
  vencida, el admin sube la cantidad), esa tanda vuelve a ser la actual y **la siguiente se vuelve a
  bloquear** hasta que la anterior se agote otra vez. Se vende siempre la tanda más barata/antigua que
  tenga cupo; no queda cupo anterior «huérfano». Las compras pendientes o pagas de la tanda siguiente
  hechas mientras estuvo activa no se tocan.
- «Agotar» del panel (`soldOut: true`) pone `ticketsAvailable = 0` → es la forma manual de **adelantar**
  a la tanda siguiente. Poner `quantity` igual a lo vendido tiene el mismo efecto.
- Una tanda con `quantity = 0` cuenta como agotada (se saltea).
- Borrar una tanda (solo posible sin compras) acorta la cadena; reordenar cambia cuál es la actual en el
  momento.
- Compras `pending` retienen cupo: con la tanda 1 en 0 por pendientes, se habilita la tanda 2; si las
  pendientes vencen, la 1 vuelve a ser la actual. Es el mismo criterio que «Agotada» hoy.

## T-4. Validación en el servidor (checkout)
En `purchaseController.createCheckoutSession`, **dentro de la transacción** de reserva:
1. **Qué se bloquea:** una consulta liviana cuenta los lotes del evento con `afterPrevious = true`. Si no hay
   ninguno, se bloquean solo los lotes pedidos (como siempre). Si hay, se bloquean **TODOS los lotes del
   evento**, en un único conjunto ordenado por id (anti-deadlock). Las filas se re-verifican dentro de la
   transacción (si aparece un lote encadenado entre la consulta y el bloqueo, se bloquea todo el evento).
2. Con las filas bloqueadas (valores frescos) se calcula `lockedLotIds`. Si algún lote pedido (suelto o por
   pack) está bloqueado → la transacción termina sin reservar y responde
   **409** `{ success: false, code: "LOT_LOCKED", message: "La tanda «<nombre>» todavía no está a la venta. Actualizá la página y elegí de nuevo" }`.
   Es lo primero que se chequea tras bloquear, antes de los topes por email/lote y de `reserveItems`.
3. **Se evalúa contra el estado anterior a la compra** (no hay desborde automático): si a la tanda 1 le
   quedan 2 y el carrito pide 2 de la tanda 1 + 3 de la 2, se rechaza la 2 con 409. Si pide 5 de la 1,
   responde el «Solo quedan 2…» de siempre. El comprador compra las 2 y luego la siguiente.
4. Carritos con lotes de cadenas distintas o con lotes paralelos: cada lote se evalúa en su cadena; basta
   uno bloqueado para rechazar todo (la reserva ya es todo o nada).
5. **No se aplica a la aprobación tardía** (webhook de un pago aprobado tras vencer, `reserveItems` en
   ~l. 604): el comprador ya pagó el precio de esa tanda cuando estaba activa; solo se exige cupo, como hoy.
   Tampoco cambian `releaseStock`, el barrido, las cortesías (no usan lotes) ni las devoluciones.
6. Nunca se confía en el cliente: el flag `locked` que expone la API es solo para pintar; el servidor
   recalcula siempre.

## T-5. API
- **Pública (`withLots`, `GET /api/events` y `/api/events/:id`):** cada lote suma `locked: boolean`
  calculado con `lockedLotIds`. `afterPrevious` se **quita** para no-admin (público, staff, organizador).
  `ticketsAvailable` y `price` de una tanda bloqueada se siguen enviando. `Event.ticketsAvailable` no cambia.
- **Admin:** recibe `afterPrevious` y `locked` en cada lote.
- **Escritura (solo admin, rutas actuales `protect, admin`; sin cambios de permisos):**
  - `parseLotInput` acepta `afterPrevious`: debe ser **boolean** (si viene y no lo es → 400
    «afterPrevious tiene que ser verdadero o falso»; `null` también es 400). Ausente en el alta = `false`;
    ausente en la edición = no se toca. Lo usan `POST /api/events` (cada elemento de `lots`),
    `POST /api/events/:eventId/lots` y `PUT /api/events/:eventId/lots/:lotId`. La respuesta de esas rutas
    (lote / evento admin) incluye `afterPrevious`.
  - **`PUT /api/events/:eventId/lots-order`** `{ order: [...] }`: reordena en una transacción
    (`position` = índice). Exige exactamente todos los lotes del evento, sin repetidos; si no → 400.
    Auditoría `LOT_REORDER` (no estricta). `LOT_CREATE`/`LOT_DELETE` incluyen `afterPrevious` y
    `LOT_UPDATE` registra el cambio como `afterPrevious: { from, to }`.
  - Checkout: sin cambios de contrato; 409 `{ success:false, code:"LOT_LOCKED", message }` como antes.
- El organizador no edita lotes (hoy tampoco): sin cambios en `/api/organizer/*` ni en `/organizadorGt`.

## T-6. Interfaz
**Pública (`frontend/index.html`, `event.css`, `common.js`):**
- Tanda bloqueada: tarjeta `.ev-lot.locked` en gris (misma base visual que `.sold`), nombre y precio
  atenuados, etiqueta «Próximamente» y línea chica «Se habilita al agotarse la tanda anterior». Sin
  stepper; en el carrito se fuerza a 0 (igual que hoy con el cupo).
- Packs de un lote bloqueado: misma tarjeta gris con «Próximamente», sin stepper.
- Tanda agotada: «Agotada» como hoy. Orden: el de la API (`position`).
- Listado `/`: «Desde $…» y «Agotado» solo consideran lotes con cupo **y** `locked = false`.
- Ante un 409 `LOT_LOCKED` en el checkout: mensaje del servidor y recarga del evento (`viewBuy`), así se
  ve la tanda que quedó activa.
- Helper compartido `lotBuyable(l) = l.ticketsAvailable > 0 && !l.locked` en `common.js` para no repetir
  la condición en los ~6 lugares que hoy miran `ticketsAvailable`.

**Admin (`frontend/adminGt/index.html`):**
- En cada lote (crear evento y editar): selector de dos modos, «A la vez» / «Se activa después de que se agote la anterior» (`afterPrevious`), y botones ↑/↓ que llaman a `lots-order` con la lista completa.
- Etiqueta de estado por lote: «En venta» / «Próximamente» / «Agotada» (desde `locked` y el cupo).
- Ayuda corta bajo la lista: «Un lote que se activa después de la anterior se habilita cuando se agota el lote de arriba. "Agotar" adelanta al siguiente.»
- Sin cambios en `/organizadorGt` (solo muestra totales).

## T-7. Estructura (nuevo o modificado)
```
backend/models/Lot.js                 + afterPrevious
backend/utils/tiers.js                NUEVO: lockedLotIds(lots)
backend/utils/lots.js                 parseLotInput (afterPrevious) y withLots (locked, ocultar afterPrevious)
backend/controllers/lotController.js  afterPrevious en alta/edición, reorderLots
backend/controllers/eventController.js afterPrevious en los lotes iniciales
backend/controllers/purchaseController.js  bloqueo de lotes del evento + 409 LOT_LOCKED en el checkout
backend/routes/eventRoutes.js         PUT /:eventId/lots-order (protect, admin)
backend/test/tiersUnit, tiersCheckout, tiersAdmin, tiersApi, uiTiers, uiTiersAdmin .test.js   NUEVOS (+ tiersFixes.test.js)
frontend/common.js, index.html, event.css, adminGt/index.html
```

## T-8. Decisiones
- **DT-1** Opt-in por lote con `afterPrevious` (boolean; antes `tierGroup`, reemplazado en TT.11); false = como hoy. Ningún evento existente cambia.
- **DT-2** Orden = `position` existente + endpoint de reorden atómico.
- **DT-3** Activación calculada en vivo, sin estado: una tanda que recupera cupo vuelve a ser la actual y
  bloquea a las siguientes (pendiente de confirmar por el usuario, ver P-1).
- **DT-4** Validación dentro de la transacción, con las cadenas bloqueadas en orden por id; 409
  `LOT_LOCKED`. Sin desborde automático a la tanda siguiente (P-2).
- **DT-5** La aprobación tardía no revalida tandas.
- **DT-6** No es `[SEGURIDAD]`: no toca auth, permisos, secretos ni datos personales (las rutas de
  escritura siguen `protect, admin`). Sí toca qué se puede vender: se cubre con tests del servidor.

## T-9. Riesgos
| Riesgo | Mitigación |
|---|---|
| Concurrencia en el cambio de tanda (SQLite no bloquea filas) | Bloqueo de todos los lotes del evento en la transacción; prueba manual opcional en Postgres local (TT.08). |
| Admin se confunde con los nombres de grupo | Eliminado en TT.11: solo hay dos modos por lote. |
| La tanda 2 se vende y después la 1 recupera cupo (la 2 se vuelve a bloquear) | Comportamiento documentado (DT-3); se ve en el panel con la etiqueta de estado. |
| Columna nueva con `DB_SYNC_ALTER=false` | Nota de despliegue en `MEMORIA.md` (TT.09). |
