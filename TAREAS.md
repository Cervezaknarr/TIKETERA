# TAREAS — Endurecimiento SOC 2 / ISO 27001:2022

Tablero compartido. Plan, decisiones (D1..D13), matriz de trazabilidad y acciones manuales (M-xx): `PLAN.md`.

**Reglas del tablero**
- Rama `hardening-soc2-iso27001` (desde `main`). Sin push ni cambios en `prod` sin pedido explícito del usuario.
- Estados: `pendiente` → `en curso` → `hecha` (verificada por tester) → `cerrada` (revisada; si es `[SEGURIDAD]`, aprobada por el usuario).
- `[SEGURIDAD]` = toca autenticación, permisos, secretos o datos personales: el usuario la aprueba antes de cerrarla.
- `[MODELO]` = cambia el esquema de la base: respetar el orden de despliegue de `PLAN.md` §5.
- `‖` = se puede hacer en paralelo con las otras tareas `‖` de la misma ola. Dos tareas que tocan el mismo archivo no van en paralelo aunque tengan `‖` (se indica en «Dependencias»).
- Al terminar una tarea: actualizar su estado aquí y anotar el commit.
- Tests: desde `backend/`, `PURCHASE_HOLD_MINUTES= npm test`.

## Orden resumido

| Ola | Tareas | Despliegue al cerrar (lo ordena el usuario) |
|---|---|---|
| 0 Preparación | T0.01 → T0.02, T0.03 | — |
| 1 Crítico/alto | T1.01–T1.07 → **D0** → T1.08–T1.27 → T1.90–T1.93 | D0 (main + H-01 + H-04), D1 |
| 2 Media | T2.01–T2.23 → T2.90–T2.93 | D2 |
| 3 Baja | T3.01–T3.14 → T3.90–T3.93 | D3 |
| 4 Documental | T4.01–T4.13 → T4.90–T4.93 | — |

**Tareas que tocan el modelo de datos:** T1.03 (`PaymentAccount.collectorId`), T1.09 (baseline), T1.10 (índices), T1.11 (`AuditLog` nuevo), T1.14 (`User`: MFA/bloqueo), T2.11 (`PaymentAccount.webhookSecretEnc`), T3.08 (solo si hay que limpiar portadas). Todas en migraciones de Umzug desde T1.08; ninguna antes de D0.

---

## Ola 0 — Preparación

### T0.01 — Crear la rama de trabajo
- **Agente:** devops · **Hallazgos:** — · **Severidad:** — · **Dependencias:** — · **Estado:** pendiente
- **Descripción:** `git fetch`, revisar `git log main..origin/main` y `git log prod..main`; crear `hardening-soc2-iso27001` desde `main` actualizado. Anotar aquí los commits de `main` que no están en `prod` (insumo de D0).
- **Aceptación:** la rama existe en local, parte del último `main`, no se hizo push; lista de commits `prod..main` anotada en este archivo.

### T0.02 — Línea base de tests y dependencias
- **Agente:** tester · **Hallazgos:** I-07 · **Severidad:** — · **Dependencias:** T0.01 · **Estado:** pendiente
- **Descripción:** correr la suite completa y `npm audit` / `npm audit --omit=dev`; registrar resultados.
- **Aceptación:** cantidad de tests que pasan/fallan y salida resumida de `npm audit` anotadas aquí; cualquier falla previa queda identificada como preexistente.

### T0.03 — Borrar el log local con PII [SEGURIDAD]
- **Agente:** devops · **Hallazgos:** H-04 (datos locales), I-13 · **Severidad:** Alta · **Dependencias:** — ‖ · **Estado:** pendiente
- **Descripción:** borrar `/workspace/proyectos/tiketeraNew/datos-local/server.log` (contiene email y `accessToken` de prueba) **previa confirmación del usuario** (borrado irreversible). Buscar otros `*.log`/`*.sqlite` con datos fuera de git.
- **Aceptación:** el usuario confirmó; el archivo no existe; lista de otros archivos con datos encontrados (si hay) informada al usuario.

---

## Ola 1 — Crítico / alto

### T1.01 — Webhook: la cuenta sale de la compra, no de la URL [SEGURIDAD]
- **Agente:** dev-backend · **Hallazgos:** H-01, H-09 (acc inexistente) · **Severidad:** Crítica · **Dependencias:** T0.01 · **Estado:** hecho, pendiente de test T1.02
- **Descripción:** en `purchaseController.js` (webhook, ~l. 482-502) y `utils/payments/mercadopago.js` (~l. 217-219): rechazar `acc` que no exista en `PaymentAccount`; dentro de la transacción, con la compra bloqueada, exigir `String(acc ?? "") === String(purchase.paymentAccountId ?? "")` antes de cualquier rama (aprobación, aprobación tardía, devolución/anulación). Si no coincide: sin cambios, log de alerta `WEBHOOK_ACC_MISMATCH` (id de compra y de cuentas, sin email) y respuesta 200 sin efectos. Sin cambios de modelo.
- **Aceptación:** con `acc` ajeno, inexistente, presente en compra sin cuenta, o ausente en compra con cuenta, no se emiten ni anulan entradas ni cambia el estado; los flujos legítimos (cuenta del evento, cuenta general, compras viejas sin `acc`) siguen funcionando; la suite existente pasa.

### T1.02 — Tests de H-01 [SEGURIDAD]
- **Agente:** tester · **Hallazgos:** H-01 · **Severidad:** Crítica · **Dependencias:** T1.01 (los tests se pueden escribir antes y deben fallar con el código actual) · **Estado:** hecho (`backend/test/webhookAccount.test.js`, 9 casos; contra el código previo a T1.01 fallan 6 de 9 —los de ataque, acc faltante/sobrante y log—, con el arreglo pasan los 9)
- **Descripción:** nuevo `test/webhookAccount.test.js`: organizador A con cuenta propia crea un pago simulado cuyo `external_reference` es una compra del evento de B y llama al webhook con `?acc=<cuenta de A>`, con estado `approved` y con `refunded`; casos de `acc` inexistente y faltante; casos legítimos.
- **Aceptación:** los casos de ataque fallan contra el código anterior a T1.01 (comprobado y anotado) y pasan después; casos legítimos en verde.

### T1.03 — `PaymentAccount.collectorId` y verificación del cobrador [SEGURIDAD] [MODELO]
- **Agente:** dev-backend (migración revisada por dba) · **Hallazgos:** H-01 · **Severidad:** Crítica · **Dependencias:** T1.08, T1.09, T1.01 · **Estado:** pendiente
- **Descripción:** migración que agrega `collectorId` (nullable); al crear/verificar una cuenta contra `GET /users/me` guardar su `id`; en el webhook de MP exigir `payment.collector_id == account.collectorId` cuando esté cargado (si falta, log `WEBHOOK_NO_COLLECTOR` y se acepta, transición). Script o botón «Re-verificar» para completar cuentas existentes. La cuenta por defecto (`MERCADOPAGO_ACCESS_TOKEN`) obtiene su collector al arrancar.
- **Aceptación:** test: pago con `collector_id` distinto no emite entradas; cuentas nuevas guardan `collectorId`; migración con `down` probada en Postgres local.

### T1.04 — Logger estructurado con redacción; fuera PII y tokens de los logs [SEGURIDAD]
- **Agente:** dev-backend · **Hallazgos:** H-04, I-05 · **Severidad:** Alta · **Dependencias:** T0.01; en `purchaseController.js` después de T1.01 · **Estado:** hecho, pendiente de test T1.05 (parcial: ver nota)
- **Descripción:** `utils/logger.js` (JSON por línea: `ts`, `level`, `code`, `msg`, campos; helpers `maskEmail`, nunca serializa campos `token`/`accessToken`/`password`/`authorization`). Reemplazar `console.*` de `mailer.js` (l. 28-31: no loguear link ni email), del log de devoluciones (l. 496-499) y de los mensajes de pagos con códigos estables: `PAYMENT_NO_STOCK`, `PAYMENT_AMOUNT_MISMATCH`, `PURCHASE_REFUNDED`, `WEBHOOK_ACC_MISMATCH`. Con `NODE_ENV=production` y sin `RESEND_API_KEY`: log `EMAIL_DISABLED` nivel `alert` al arrancar y en cada envío omitido (decisión D10: no se cae).
- **Aceptación:** `grep` de `console.` en `backend/` (fuera de tests/scripts) sin resultados o justificados; los textos históricos de alerta siguen siendo encontrables (se mantienen en `msg`); suite en verde.
- **Nota dev-backend:** hecho solo el alcance reducido: `utils/redact.js` (`maskEmail`), `mailer.js` sin link/email en producción y aviso de arranque. No se creó `logger.js` ni códigos estables. El log de devoluciones (l. 496-499) no existe aún en `purchaseController.js`; `maskEmail` debe usarse cuando T1.01 lo agregue.

### T1.05 — Tests de logs sin PII [SEGURIDAD]
- **Agente:** tester · **Hallazgos:** H-04 · **Severidad:** Alta · **Dependencias:** T1.04 · **Estado:** pendiente
- **Descripción:** capturar stdout/stderr durante compra completa, envío sin Resend, reenvío, devolución y login fallido.
- **Aceptación:** ningún `accessToken`, link `#/entradas/<token>`, contraseña ni email completo aparece en la salida; `EMAIL_DISABLED` aparece en modo producción sin clave.

### T1.06 — Checklist de despliegue D0
- **Agente:** devops · **Hallazgos:** I-01, H-10, I-03 · **Severidad:** Alta · **Dependencias:** T0.01 ‖ · **Estado:** pendiente
- **Descripción:** `docs/operacion/despliegue.md`: pasos de D0 (export de la base, ventana sin ventas, `DB_SYNC_ALTER` ≠ false, merge a `prod` solo por orden del usuario, verificación de logs y de la migración de staff, `DB_SYNC_ALTER=false` después, asignar eventos al staff general, rollback). Incluir los cambios de esquema de `prod..main` (de T0.01).
- **Aceptación:** checklist con cada paso verificable y su responsable (usuario / agente); revisado por el usuario.

### T1.07 — Ensayo de D0 en Postgres local
- **Agente:** tester · **Hallazgos:** I-01, H-10 · **Severidad:** Alta · **Dependencias:** T1.01, T1.04, T1.06 · **Estado:** pendiente
- **Descripción:** como en `MEMORIA.md` (2026-10-23): Postgres local con SSL, base armada con el código de `prod` y datos de ejemplo; arrancar la rama con `NODE_ENV=production` y alter activo.
- **Aceptación:** arranque sin errores; enum `organizer` creado; tablas/columnas nuevas presentes; datos previos intactos; staff general migrado según lo esperado; resultado anotado aquí. **Después de esto, D0 queda a decisión del usuario.**

### T1.08 — Infraestructura de migraciones (Umzug) [MODELO]
- **Agente:** devops · **Hallazgos:** I-01, H-10 · **Severidad:** Alta · **Dependencias:** D0 desplegado (o decisión explícita del usuario de no hacerlo) · **Estado:** pendiente
- **Descripción:** agregar `umzug`; `backend/migrations/`, `backend/scripts/migrate.js`, scripts `migrate`, `migrate:down`, `migrate:status`. En `server.js`: con `NODE_ENV=production` no llamar a `sync` (si `DB_SYNC_ALTER` está definida, log de aviso de que se ignora); en test/desarrollo se mantiene `sync`. `render.yaml`: `preDeployCommand: npm run migrate`.
- **Aceptación:** `npm run migrate` sobre Postgres vacío no falla (con T1.09 crea el esquema); producción no ejecuta `sync` (test o inspección); tests en verde; `CLAUDE.md` marcado para actualizar en T1.92.

### T1.09 — Migración base y control de deriva [MODELO]
- **Agente:** dba · **Hallazgos:** I-01, H-10 · **Severidad:** Alta · **Dependencias:** T1.08 · **Estado:** pendiente
- **Descripción:** `0001-baseline`: si las tablas existen, verifica tablas y columnas esperadas (falla con mensaje claro si falta algo) y se marca aplicada; si la base está vacía, crea el esquema completo de los modelos post-D0. Script `scripts/schema-diff.js` que compara el esquema resultante de las migraciones con el de `sync` en una base limpia (lo usa CI).
- **Aceptación:** baseline aplicada sobre la base del ensayo T1.07 no cambia nada; sobre base vacía, `schema-diff` sin diferencias; `down` documentado (baseline no se revierte).

### T1.10 — Eliminar índices duplicados [MODELO]
- **Agente:** dba · **Hallazgos:** I-01 · **Severidad:** Alta · **Dependencias:** T1.09 · **Estado:** pendiente
- **Descripción:** `0002-dedupe-indices`: en Postgres, detectar índices únicos duplicados (misma tabla y columnas) en `Purchases`, `Tickets`, `Users` y demás; conservar uno y borrar el resto. Sin efecto en SQLite.
- **Aceptación:** en una base con duplicados generados por varios arranques con `alter`, queda un índice por restricción; las restricciones de unicidad siguen activas (test de inserción duplicada falla).

### T1.11 — Tabla `AuditLog` append-only [SEGURIDAD] [MODELO]
- **Agente:** dba · **Hallazgos:** H-02 · **Severidad:** Alta · **Dependencias:** T1.09 ‖ con T1.14 · **Estado:** hecho (modelo `backend/models/AuditLog.js` con hooks append-only + trigger Postgres idempotente `ensureAppendOnlyTrigger()` llamado tras el sync en `server.js`; tabla creada por `sync`, sin migración Umzug todavía; test `backend/test/auditModel.test.js`. Pendiente para T4.04: la purga de 1 año es un procedimiento manual que deshabilita el trigger `audit_log_append_only`, no está automatizada)
- **Descripción:** modelo `AuditLog` (`id`, `at`, `actorUserId`, `actorRole`, `action`, `targetType`, `targetId`, `eventId`, `ip`, `requestId`, `meta` JSON sin PII ni secretos, `result`) + migración `0003`; índices por `at`, `actorUserId`, `eventId`, `action`; en Postgres trigger que rechaza UPDATE y DELETE.
- **Aceptación:** migración ida/vuelta en Postgres local; UPDATE/DELETE fallan en Postgres; el modelo no expone métodos de actualización en el helper.

### T1.12 — Helper `audit()` e instrumentación [SEGURIDAD]
- **Agente:** dev-backend · **Hallazgos:** H-02 · **Severidad:** Alta · **Dependencias:** T1.11, T1.04; en `authController.js` después de T1.15 · **Estado:** hecho, testeado en T1.13
- **Descripción:** `utils/audit.js` que inserta en `AuditLog` (dentro de la transacción si la hay) y emite la misma línea por el logger (`code: AUDIT`). Instrumentar: login ok/fallido/bloqueado, MFA alta/baja/reset, logout; alta/baja/cambio de usuario, clave y `eventIds`; staff del organizador; cuentas de pago (alta, activación, borrado, re-verificación); pausa/reanudación de ventas (general y por evento); evento (alta, edición, estado, borrado, organizador); lotes y packs (precio, cupo, agotado, borrado); anulación manual (con autor); reenvío de mail y copia de link; anulaciones automáticas por webhook y `WEBHOOK_ACC_MISMATCH`. `GET /api/audit` solo admin, paginado y filtrable (fecha, acción, evento, actor).
- **Notas dev-backend:** `utils/audit.js` nunca lanza (AUDIT_WRITE_FAILED) y emite `{"audit":true,...}` por stdout. Ampliado: EVENT_CREATE/UPDATE/DELETE, PURCHASE_VOID_AUTO, PAYMENT_AMOUNT_MISMATCH, PAYMENT_NO_STOCK, fallos de TICKETS_RESEND; lote/pack también auditan alta y borrado. Sin instrumentar aún: MFA, logout, desbloqueo (dependen de T1.15/T1.16/T2.03); login sin estado de bloqueo; no existe re-verificación de cuenta ni endpoint de copia de link.
- **Aceptación:** cada acción listada genera exactamente un registro con autor, IP y fecha; ningún `meta` contiene email completo, token ni contraseña; un organizador recibe 403 en `/api/audit`.

### T1.13 — Tests de auditoría [SEGURIDAD]
- **Agente:** tester · **Hallazgos:** H-02 · **Severidad:** Alta · **Dependencias:** T1.12 · **Estado:** hecho
- **Descripción:** `test/audit.test.js` con una aserción por acción instrumentada y el control de acceso de `/api/audit`.
- **Aceptación:** todos los casos en verde; tabla «acción → test» anotada aquí como evidencia.
- **Evidencia (tester):** `backend/test/audit.test.js`, 40 casos en verde. Acción → test: LOGIN_OK/LOGIN_FAIL (failure, denied, email enmascarado, sin 400) → tests 1-5; USER_CREATE/UPDATE/DELETE (sin clave ni hash) → 6-8; STAFF_CREATE/UPDATE/DELETE → 9; PAYMENT_ACCOUNT_CREATE/ACTIVATE/DELETE (admin y organizador, sin token ni hint) → 10-12; SALES_PAUSE/RESUME (general y por evento) → 13-14; PURCHASE_VOID → 15-16; PURCHASE_VOID_AUTO, PAYMENT_AMOUNT_MISMATCH, WEBHOOK_ACC_MISMATCH, PAYMENT_NO_STOCK → 17-21; TICKETS_RESEND (éxito, 429, 502) → 22-23; EVENT_CREATE/UPDATE/DELETE → 24-26; LOT_*/PACK_* → 27; GET /api/audit (401/403/200, paginación, tope, filtros, fechas, 400, inyección) → 28-32; append-only → 33-34; fallo de escritura/AUDIT_WRITE_FAILED y `audit()` → 35-38; barrido final de secretos en toda la tabla → 39-40. Sin cubrir: MFA, logout, desbloqueo (no instrumentados aún) y TICKETS_RESEND 503 (mail no configurado).

### T1.14 — Columnas de `User` para MFA y bloqueo [SEGURIDAD] [MODELO]
- **Agente:** dba · **Hallazgos:** H-03 · **Severidad:** Alta · **Dependencias:** T1.09 ‖ con T1.11 · **Estado:** pendiente
- **Descripción:** migración `0004`: `mfaSecretEnc`, `mfaEnabledAt`, `mfaLastStep`, `mfaRecoveryCodes` (hashes), `failedLoginCount`, `lockedUntil`, `lastLoginAt`, `passwordChangedAt`.
- **Aceptación:** ida/vuelta en Postgres local; `schema-diff` sin diferencias; los usuarios existentes quedan con valores por defecto válidos.

### T1.15 — Política de contraseñas, bloqueo por cuenta y anti-enumeración [SEGURIDAD]
- **Agente:** dev-backend · **Hallazgos:** H-03 · **Severidad:** Alta · **Dependencias:** T1.14 · **Estado:** pendiente
- **Descripción:** `utils/passwordPolicy.js` (12 caracteres mínimo, 72 bytes máximo, lista `data/common-passwords.txt`, no contener el email) aplicado en `userController.js`, staff del organizador, cambio de clave y `utils/admin.js`. Bcrypt coste 12 con rehash al iniciar sesión. Login (`authController.js` l. 38-66): hash ficticio si el usuario no existe, **401 con el mismo mensaje** para inexistente, clave errónea, rol `user` y cuenta bloqueada. Bloqueo progresivo por cuenta (5 fallos → 15 min, se duplica hasta 24 h; se resetea al entrar); el admin puede desbloquear (`PUT /api/users/:id`, auditado).
- **Aceptación:** criterios cubiertos por T1.18; el límite por IP existente sigue funcionando.

### T1.16 — MFA TOTP para admin y organizador [SEGURIDAD]
- **Agente:** dev-backend · **Hallazgos:** H-03 · **Severidad:** Alta · **Dependencias:** T1.14, T1.15 · **Estado:** pendiente
- **Descripción:** `utils/totp.js` (RFC 6238 con `node:crypto`, SHA-1, 30 s, 6 dígitos, ventana ±1, anti-replay con `mfaLastStep`). Login en dos pasos: clave correcta → token temporal (5 min, `purpose: "mfa"`) → `POST /api/auth/mfa/verify` → JWT. Admin/organizador sin MFA: el token temporal solo permite `POST /api/auth/mfa/setup` (devuelve `otpauth://` y QR con `qrcode`) y `/mfa/enable` (confirma con un código; entrega 10 códigos de recuperación, se guardan hasheados). Secreto cifrado con `utils/secrets.js`. El admin puede resetear el MFA de un organizador (auditado). Staff: MFA opcional.
- **Aceptación:** criterios cubiertos por T1.18; ningún endpoint protegido acepta el token temporal.

### T1.17 — Interfaz de MFA y mensajes de contraseña [SEGURIDAD]
- **Agente:** dev-frontend · **Hallazgos:** H-03 · **Severidad:** Alta · **Dependencias:** T1.16 · **Estado:** pendiente
- **Descripción:** en `/admin` y `/organizador`: segundo paso de login, alta de MFA con QR y códigos de recuperación mostrados una vez (con «Copiar»), uso de código de recuperación; en formularios de alta/cambio de clave, requisitos de la política. `/staff`: mensaje genérico de error. **Código nuevo en archivos `.js`, sin scripts ni `onclick` en línea** (prepara T2.01).
- **Aceptación:** recorrido manual en navegador (alta de MFA, login con código, con código de recuperación, clave débil rechazada) anotado aquí; sin errores en consola.

### T1.18 — Tests de autenticación [SEGURIDAD]
- **Agente:** tester · **Hallazgos:** H-03 · **Severidad:** Alta · **Dependencias:** T1.15, T1.16 · **Estado:** pendiente
- **Descripción:** `test/auth-mfa.test.js`: vectores del RFC 6238, replay, ventana, códigos de recuperación de un solo uso, MFA obligatorio, token temporal sin acceso, bloqueo y desbloqueo, mismo status y cuerpo en los 4 casos de fallo, política de claves, rehash a coste 12.
- **Aceptación:** todos en verde; `roles.test.js` y demás adaptados sin perder cobertura.

### T1.19 — Procedimiento de recuperación de acceso del admin [SEGURIDAD]
- **Agente:** documentador · **Hallazgos:** H-03 · **Severidad:** Alta · **Dependencias:** T1.16 ‖ · **Estado:** pendiente
- **Descripción:** `docs/runbooks/recuperar-acceso-admin.md` («break-glass»): pérdida del teléfono, códigos agotados, quién lo autoriza, cómo resetear MFA desde la consola de Render, registro posterior en auditoría.
- **Aceptación:** `revisor-docs` lo verifica contra el código de T1.16.

_(T1.20: número reservado, sin tarea asignada.)_

### T1.21 — CI en GitHub Actions, CODEOWNERS y despliegue con checks
- **Agente:** devops · **Hallazgos:** I-02, H-10 · **Severidad:** Alta · **Dependencias:** T0.01 ‖ (el paso de migraciones se suma cuando exista T1.09) · **Estado:** pendiente
- **Descripción:** `.github/workflows/ci.yml` en PR y push a `main`/`prod`: Node 24, `npm ci`, `PURCHASE_HOLD_MINUTES= npm test`, servicio Postgres con `npm run migrate` + `schema-diff`, `npm audit --omit=dev --audit-level=high`. `.github/CODEOWNERS` (usuario como dueño de todo; obligatorio en `backend/controllers`, `middleware`, `utils/secrets.js`, `utils/payments/`, `migrations/`, `render.yaml`, `.github/`). `render.yaml`: `branch: prod`, `autoDeployTrigger: checksPass`.
- **Aceptación:** YAML válido (`actionlint` sin errores); los mismos comandos pasan en local; la protección de rama queda como M-01.

### T1.22 — Verificación de CI
- **Agente:** tester · **Hallazgos:** I-02 · **Severidad:** Alta · **Dependencias:** T1.21 · **Estado:** pendiente
- **Descripción:** reproducir localmente los pasos del workflow; romper a propósito un test y una migración en una copia y comprobar que los pasos fallan.
- **Aceptación:** resultados anotados aquí; tras M-01 y el primer push autorizado, enlace a la primera ejecución en verde.

### T1.23 — Backups, export previo y RPO/RTO
- **Agente:** devops · **Hallazgos:** I-03 · **Severidad:** Alta · **Dependencias:** — ‖ · **Estado:** pendiente
- **Descripción:** `backend/scripts/db-export.sh` (`pg_dump -Fc` con la URL por variable de entorno, archivo con fecha, nunca dentro del repo); `docs/operacion/backups.md`: qué ofrece el plan de Render (a confirmar por el usuario, M-04), RPO ≤ 24 h / RTO ≤ 4 h propuestos, frecuencia de simulacros (trimestral y antes de cambios de esquema), dónde se guardan los exports y por cuánto.
- **Aceptación:** script probado contra Postgres local; documento con RPO/RTO pendiente de aprobación del usuario.

### T1.24 — Simulacro de restauración
- **Agente:** devops · **Hallazgos:** I-03 · **Severidad:** Alta · **Dependencias:** T1.23 · **Estado:** pendiente
- **Descripción:** `docs/runbooks/restauracion.md`; restaurar un export en una base nueva local, arrancar la app contra ella y verificar conteos de eventos/compras/entradas; medir tiempos. El simulacro sobre Render lo hace el usuario con el runbook (M-04).
- **Aceptación:** registro en `docs/evidencias/restauracion-AAAA-MM-DD.md` con tiempos medidos (RTO real) y verificaciones.

### T1.25 — Log de requests y manejo de errores
- **Agente:** dev-backend · **Hallazgos:** I-05, H-02 · **Severidad:** Alta · **Dependencias:** T1.04 · **Estado:** pendiente
- **Descripción:** middleware con `requestId` (cabecera `X-Request-Id`), método, ruta **con tokens redactados** (`/api/purchases/tickets/:token` y similares), status, duración, IP; handlers de `unhandledRejection`/`uncaughtException` que loguean con `code: CRASH`; errores 5xx con `code: HTTP_5XX` sin stack al cliente.
- **Aceptación:** test: una request a la página de entradas no deja el token en el log; un error forzado produce `HTTP_5XX` y respuesta genérica.

### T1.26 — Monitoreo y alertas (documento operativo)
- **Agente:** devops · **Hallazgos:** I-05, H-02 · **Severidad:** Alta · **Dependencias:** T1.04, T1.25 ‖ · **Estado:** pendiente
- **Descripción:** `docs/operacion/monitoreo.md`: opciones de proveedor de log stream con retención ≥ 1 año (comparativa breve), paso a paso para Render (M-06), reglas de alerta por código (`PAYMENT_NO_STOCK`, `PAYMENT_AMOUNT_MISMATCH`, `PURCHASE_REFUNDED`, `WEBHOOK_ACC_MISMATCH`, `WEBHOOK_SIGNATURE_INVALID`, `LOGIN_LOCKED` repetido, `EMAIL_DISABLED`, `CRASH`, tasa de `HTTP_5XX`), monitor de uptime sobre `/health` (M-07), quién recibe cada alerta y qué runbook aplica.
- **Aceptación:** cada código emitido por el código tiene regla y runbook; el usuario elige proveedor.

### T1.27 — Plan de respuesta a incidentes y runbooks de pagos
- **Agente:** documentador · **Hallazgos:** I-04 · **Severidad:** Alta · **Dependencias:** T1.04 (códigos) ‖ · **Estado:** pendiente
- **Descripción:** `docs/seguridad/plan-incidentes.md` (roles, severidades, detección, contención, comunicación a compradores/organizadores, notificación a la AAIP según Ley 25.326 cuando aplique, conservación de evidencia, lecciones aprendidas, registro de incidentes). Runbooks en `docs/runbooks/`: `pago-aprobado-sin-cupo.md`, `pago-monto-distinto.md`, `compra-devuelta-contracargo.md`, `webhook-cuenta-no-coincide.md`, `credencial-comprometida.md`.
- **Aceptación:** cada runbook indica cómo se detecta (código de log), pasos en el panel de MP y en `/admin`, cómo se verifica la resolución y qué se registra; `revisor-docs` lo contrasta con el código.

### T1.28 — Webhook fail-closed ante cuenta desconocida [SEGURIDAD]
- **Agente:** dev-backend · **Severidad:** Alta · **Estado:** hecha, pendiente de aprobación [SEGURIDAD]
- **Descripción:** `handlePaymentWebhook` trataba la falta de `accountId` como válida. Ahora, si la pasarela (que no sea `mock`) no devuelve la clave `accountId`, es mismatch (404, `WEBHOOK_ACC_MISMATCH`, auditoría). `mock` y `nave` devuelven `accountId: null` explícito.
- **Decisión/deuda:** los stubs de `payments.test.js` y el `deepEqual` de Nave se ajustaron (añaden `accountId: null`); cualquier pasarela nueva debe informar `accountId`. Tests en `audit.test.js`.

### T1.29 — Auditoría estricta en acciones de dinero [SEGURIDAD]
- **Agente:** dev-backend · **Severidad:** Alta · **Estado:** hecha, pendiente de aprobación [SEGURIDAD]
- **Descripción:** `audit(req, { strict: true, transaction })` inserta dentro de la transacción y lanza si falla (sin `transaction` también lanza). Aplicado a `PURCHASE_VOID` (movido dentro de la transacción), `PURCHASE_VOID_AUTO` (webhook) y `PAYMENT_ACCOUNT_CREATE/ACTIVATE/DELETE` (admin y organizador, mutación + audit en una transacción). Si el audit falla: rollback y 500. Tests en `audit.test.js` y `refunds.test.js`.
- **Deuda:** el resto de las acciones sigue siendo no estricto (SALES_PAUSE, USER_*, etc.).

### T1.30 — Ampliar auditoría: check-in, accesos denegados, pago confirmado [SEGURIDAD]
- **Agente:** dev-backend · **Severidad:** Media · **Estado:** hecha, pendiente de aprobación [SEGURIDAD]
- **Descripción:** `CHECKIN_OK` / `CHECKIN_REJECTED` (result success / denied para duplicada o anulada / failure para código inválido; un solo insert por sync, sin lecturas extra; los reenvíos idempotentes no se re-auditan; sin código ni datos del comprador). `ACCESS_DENIED` en cada 403 de `authMiddleware.js` (actor + `details.method` y `details.route` = patrón de la ruta, p. ej. `/api/organizer/events/:eventId/payments`, o `<baseUrl>/*` si no hay `req.route`; nunca la URL concreta). El check-in audita con un único `AuditLog.bulkCreate` al final del sync (fuera de transacciones, no estricto). En modo strict la línea de stdout sale en `afterCommit`. `PAYMENT_CONFIRMED` (actor null) tras el commit del webhook.
- **Pendiente:** logout — no existe endpoint de logout (JWT sin estado en el cliente), no se inventó; si se agrega, auditar `LOGOUT`.

### T1.31 — Anulación manual con motivo obligatorio [SEGURIDAD]
- **Agente:** dev-backend · **Severidad:** Media · **Estado:** hecha, pendiente de aprobación [SEGURIDAD]
- **Descripción:** `POST /api/purchases/event/:eventId/:purchaseId/void` exige body `{ reason: string }` (trim, 3 a 200 caracteres); si no, 400 «Indicá el motivo de la anulación (entre 3 y 200 caracteres)». La validación 3 a 200 va sobre el texto original; en `details.reason` de `PURCHASE_VOID` se guarda enmascarado (`scrubFreeText`: emails con `maskEmail` y toda secuencia de 7 o más dígitos, aunque lleve puntos, guiones o espacios, pasa a `***`). El frontend ya pide el motivo.

### T1.32 — Enmascarar el email en la respuesta del reenvío [SEGURIDAD]
- **Agente:** dev-backend · **Severidad:** Baja · **Estado:** hecha, pendiente de aprobación [SEGURIDAD]
- **Descripción:** `resendPurchaseEmail` responde «Entradas enviadas a a***@dominio.com» (`maskEmail`). Ojo: si el frontend mostraba el mensaje esperando el email completo, ahora ve el enmascarado.

### T1.33 — Cuentas de pago: chequeos de borrado dentro de la transacción
- **Agente:** dev-backend · **Severidad:** Media · **Estado:** pendiente
- **Descripción:** en `organizerController.js` (`deleteAccount`, ~345-353) y `paymentAccountController.js` (`deletePaymentAccount`, ~175) los chequeos (cuenta activa, compras que la usan) se hacen antes y fuera de la transacción: mover dentro con lock `UPDATE` para evitar la carrera con un checkout/activación concurrente.

### T1.34 — Auditar PAYMENT_REJECTED
- **Agente:** dev-backend · **Severidad:** Baja · **Estado:** pendiente
- **Descripción:** registrar los pagos rechazados/cancelados del webhook (hoy solo se auditan confirmados, anulaciones, monto distinto, sin cupo y cuenta distinta).

### T1.35 — Auditoría de logout [SEGURIDAD]
- **Agente:** dev-backend · **Severidad:** Baja · **Estado:** pendiente (bloqueada: no existe endpoint de logout)
- **Descripción:** auditar `LOGOUT` cuando exista el endpoint.

### T1.36 — Auditoría estricta para SALES_* y USER_* [SEGURIDAD]
- **Agente:** dev-backend · **Severidad:** Media · **Estado:** pendiente
- **Descripción:** pasar `SALES_PAUSE/RESUME` (general y por evento) y `USER_CREATE/UPDATE/DELETE` a `strict` con la mutación en la misma transacción.

### T1.37 — Documentar que PAYMENT_CONFIRMED no es estricta
- **Agente:** documentador · **Severidad:** Baja · **Estado:** pendiente
- **Descripción:** dejar asentado en la documentación de auditoría que `PAYMENT_CONFIRMED` se registra tras el commit y no es strict por decisión: no se debe revertir un pago ya cobrado ni emitir entradas por un fallo del log; el aviso queda en `AUDIT_WRITE_FAILED`.

### Cierre de la Ola 1
- **T1.90** tester — regresión completa, criterios de T1.01–T1.27, ensayo de D1 en Postgres local (baseline + 0002–0004 sobre la base de T1.07). Deps: todas las anteriores. Estado: pendiente.
- **T1.91** revisor — revisión del diff de la ola, con foco en T1.01, T1.03, T1.12, T1.15, T1.16. Deps: T1.90. Estado: pendiente.
- **T1.92** documentador — `CLAUDE.md` (migraciones, fin de `DB_SYNC_ALTER`, logger, MFA), `MEMORIA.md`, `backend/.env.example`, checklist de D1 en `docs/operacion/despliegue.md`. Deps: T1.91. Estado: pendiente.
- **T1.93** revisor-docs — documentación contra el código. Deps: T1.92. Estado: pendiente.
- Al cerrar: aprobación del usuario de las tareas `[SEGURIDAD]` y decisión sobre D1.

---

## Ola 2 — Media

### T2.01 — Sacar el JavaScript en línea de los cuatro sitios [SEGURIDAD]
- **Agente:** dev-frontend · **Hallazgos:** H-05, H-16 (`esc()` en `onclick`), I-10 · **Severidad:** Media · **Dependencias:** cierre de Ola 1 · **Estado:** pendiente
- **Descripción:** mover los `<script>` en línea de `frontend/index.html`, `staff/`, `admin/`, `organizador/` a archivos `.js`; reemplazar todos los atributos `on*` por `addEventListener` con delegación y `data-*` (elimina el uso de `esc()` dentro de handlers).
- **Aceptación:** `grep` sin `<script>` con contenido ni atributos `on[a-z]+=` en `frontend/` (salvo `vendor/`); recorrido completo de los 4 sitios sin errores.

### T2.02 — CSP estricta [SEGURIDAD]
- **Agente:** dev-backend · **Hallazgos:** H-05, I-10 · **Severidad:** Media · **Dependencias:** T2.01 · **Estado:** pendiente
- **Descripción:** en `server.js`: `script-src 'self'`, `script-src-attr 'none'`, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`; `style-src` sin `'unsafe-inline'` si es viable (si no, documentar por qué queda).
- **Aceptación:** test de cabeceras; navegación de los 4 sitios sin violaciones CSP en consola (lo verifica T2.23).

### T2.03 — JWT: algoritmos, emisor, audiencia, duración por rol, logout [SEGURIDAD]
- **Agente:** dev-backend · **Hallazgos:** H-05 · **Severidad:** Media · **Dependencias:** cierre de Ola 1 ‖ · **Estado:** pendiente
- **Descripción:** firmar y verificar con `algorithms: ["HS256"]`, `issuer`, `audience`; duración admin/organizador 8 h y staff 12 h (variables de entorno); `POST /api/auth/logout` (auditado) y `POST /api/auth/logout-all` (`tokenVersion++`, auditado).
- **Aceptación:** token con `alg` distinto, sin `iss`/`aud` o vencido → 401; logout-all invalida otras sesiones (test).

### T2.04 — Botones de cierre de sesión [SEGURIDAD]
- **Agente:** dev-frontend · **Hallazgos:** H-05 · **Severidad:** Media · **Dependencias:** T2.03, T2.01 · **Estado:** pendiente
- **Descripción:** «Salir» y «Cerrar todas mis sesiones» en `/admin`, `/organizador`, `/staff`; ante 401, borrar la sesión local y volver al login.
- **Aceptación:** recorrido manual anotado; la sesión local queda vacía tras salir.

### T2.05 — Verificar la conexión a Postgres de Render
- **Agente:** devops · **Hallazgos:** H-06, I-09 · **Severidad:** Media · **Dependencias:** — ‖ · **Estado:** pendiente
- **Descripción:** confirmar si `fromDatabase.connectionString` es la URL interna (red privada) y si el certificado del servidor valida con la CA del sistema o hace falta una CA propia; documentar en `docs/operacion/` y proponer configuración (`DB_SSL_MODE`, `DB_CA_CERT`).
- **Aceptación:** conclusión escrita con fuentes; el usuario confirma lo que requiera el panel (M-08).

### T2.06 — TLS verificado hacia Postgres [SEGURIDAD]
- **Agente:** dev-backend · **Hallazgos:** H-06, I-09 · **Severidad:** Media · **Dependencias:** T2.05 · **Estado:** pendiente
- **Descripción:** en `config/database.js`, en producción `rejectUnauthorized: true` (CA del sistema o `DB_CA_CERT`); excepción solo para red privada interna si T2.05 lo justifica, explícita por variable y documentada.
- **Aceptación:** test de configuración por entorno; `test/database.test.js` actualizado; conexión probada contra Postgres local con certificado propio y CA.

### T2.07 — Sync del escáner sin datos personales [SEGURIDAD]
- **Agente:** dev-backend · **Hallazgos:** H-07 · **Severidad:** Media · **Dependencias:** cierre de Ola 1 ‖ · **Estado:** hecha parcial, pendiente de aprobación [SEGURIDAD]
- **Descripción:** `checkinController.js` l. 318-326 y 491-494: el sync devuelve solo código, estado, lote y hashes necesarios para validar sin conexión; sin nombre ni email. El escaneo en línea puede devolver solo el nombre de pila del titular de esa entrada (sin email).
- **Aceptación:** `checkin.test.js` verifica que ninguna respuesta de `/api/checkin/*` incluye `buyerEmail` y que el sync no incluye `buyerName`.
- **Nota (otro dev, 2026-11-04):** El sync del escáner ya no envía `buyerEmail` (commit `e4877c1`, `checkin.test.js`). `buyerName` SE MANTIENE por decisión del usuario (el staff lo ve en la puerta para comprobar el DNI): el criterio «el sync no incluye `buyerName`» no se aplica. Falta revisar las demás respuestas de `/api/checkin/*` y T2.08 (el escáner no guarda emails).

### T2.08 — Escáner adaptado al sync sin PII
- **Agente:** dev-frontend · **Hallazgos:** H-07 · **Severidad:** Media · **Dependencias:** T2.07, T2.01 · **Estado:** pendiente
- **Descripción:** ajustar `/staff` para no esperar ni guardar nombre/email; borrar datos de sync viejos guardados en el dispositivo.
- **Aceptación:** escaneo en línea y manual funcionan; el almacenamiento local del navegador no contiene emails.

### T2.09 — `secrets.js` v2: KDF, AAD y rotación [SEGURIDAD]
- **Agente:** dev-backend · **Hallazgos:** H-08, I-12 · **Severidad:** Media · **Dependencias:** cierre de Ola 1 ‖ · **Estado:** pendiente
- **Descripción:** según D9: formato `v2:<kid>:<iv>:<tag>:<ct>`; clave de 32 bytes en base64 o scrypt sobre la frase; AAD `paymentAccount:<id>` y `user:<id>:mfa`; `PAYMENT_ACCOUNTS_KEY_PREVIOUS` solo para descifrar; lectura de v1; re-cifrado perezoso; `scripts/rotate-secrets.js` con `--dry-run`. Las cuentas con id autogenerado se cifran con el id ya asignado.
- **Aceptación:** criterios de T2.10.

### T2.10 — Tests de `secrets.js` v2 [SEGURIDAD]
- **Agente:** tester · **Hallazgos:** H-08 · **Severidad:** Media · **Dependencias:** T2.09 · **Estado:** pendiente
- **Descripción:** ida y vuelta v2; v1 legible y re-cifrada; cambiar el AAD (mover el cifrado a otra cuenta) falla; rotación con clave anterior; clave corta rechazada en producción; `--dry-run` no escribe.
- **Aceptación:** todos en verde; `paymentAccounts.test.js` y tests de MFA siguen pasando.

### T2.11 — Firma `x-signature` de Mercado Pago [SEGURIDAD] [MODELO]
- **Agente:** dev-backend (migración revisada por dba) · **Hallazgos:** H-09 · **Severidad:** Media · **Dependencias:** T2.09, T1.03 · **Estado:** pendiente
- **Descripción:** migración `PaymentAccount.webhookSecretEnc` (cifrado v2) y variable `MERCADOPAGO_WEBHOOK_SECRET` para la cuenta por defecto. Verificar HMAC-SHA256 del manifiesto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` con comparación en tiempo constante y tolerancia de `ts`. Si la cuenta no tiene secreto: aceptar con log `WEBHOOK_UNSIGNED`; con `MP_WEBHOOK_SIGNATURE_REQUIRED=true`, rechazar. Firma inválida: 401 y `WEBHOOK_SIGNATURE_INVALID`.
- **Aceptación:** tests de firma válida, inválida, `ts` viejo, sin secreto y modo obligatorio; migración ida/vuelta.

### T2.12 — Campo de secreto de webhook en Pagos [SEGURIDAD]
- **Agente:** dev-frontend · **Hallazgos:** H-09 · **Severidad:** Media · **Dependencias:** T2.11, T2.01 · **Estado:** pendiente
- **Descripción:** en `/admin` > Pagos y `/organizador`: cargar/reemplazar el secreto (nunca se muestra; indicador «configurado / falta»).
- **Aceptación:** recorrido manual; la API nunca devuelve el secreto.

### T2.13 — Límite de pedidos al webhook
- **Agente:** dev-backend · **Hallazgos:** H-09 · **Severidad:** Media · **Dependencias:** T2.11 (mismo archivo de rutas) · **Estado:** hecha parcial
- **Descripción:** límite por IP generoso para `/api/purchases/webhook` (p. ej. 300/min, `RATE_LIMIT_WEBHOOK_MAX`, 0 = sin límite) en `middleware/rateLimit.js`; cuerpo máximo chico.
- **Aceptación:** test de 429 al superar el límite; webhooks normales no se afectan.
- **Nota (otro dev, 2026-11-04):** Webhook 300/min (`RATE_LIMIT_WEBHOOK_MAX`) y link privado de la compra 120 cada 10 min (`RATE_LIMIT_TICKETS_MAX`), 0 = sin límite; `webhookLimit.test.js` (commit `e4877c1`). Falta el cuerpo máximo chico por ruta (también pendiente en T3.06).

### T2.14 — Versión de Node fijada
- **Agente:** devops · **Hallazgos:** I-06 · **Severidad:** Media · **Dependencias:** — ‖ · **Estado:** pendiente
- **Descripción:** `engines.node` en `backend/package.json`, `.node-version`, `NODE_VERSION` en `render.yaml`, misma versión en CI (D13).
- **Aceptación:** `npm ci` y tests pasan con esa versión; las cuatro referencias coinciden.

### T2.15 — Dependencias vulnerables y Dependabot
- **Agente:** devops · **Hallazgos:** I-07, H-10 · **Severidad:** Media · **Dependencias:** T2.14 ‖ · **Estado:** pendiente
- **Descripción:** `uuid` directo a ≥ 11.1.1 o reemplazo por `crypto.randomUUID`; `overrides` para el `uuid` de `sequelize` si la última 6.x no lo resuelve; `nodemon` 3.x; `.github/dependabot.yml` (npm en `/backend` y github-actions, semanal); CI con `npm audit --omit=dev --audit-level=moderate`.
- **Aceptación:** `npm audit --omit=dev` sin vulnerabilidades moderadas o superiores; tests en verde.

### T2.16 — CodeQL, gitleaks y ESLint
- **Agente:** devops · **Hallazgos:** I-08 · **Severidad:** Media · **Dependencias:** T1.21 ‖ · **Estado:** pendiente
- **Descripción:** `.github/workflows/codeql.yml` (JavaScript), `.github/workflows/gitleaks.yml` (historial completo en el primer run), ESLint flat config (`recommended` + `no-eval`, `no-implied-eval`) con `npm run lint` en CI; corregir lo que marque o justificarlo.
- **Aceptación:** `npm run lint` sin errores; gitleaks local sobre el historial sin hallazgos; `CLAUDE.md` deja de decir «no hay linter» (T2.92).

### T2.17 — `render.yaml` completo [SEGURIDAD]
- **Agente:** devops · **Hallazgos:** I-10 · **Severidad:** Media · **Dependencias:** T1.21, T2.14, M-08 · **Estado:** pendiente
- **Descripción:** `region` explícita (la real, la informa el usuario), `branch: prod`, `autoDeployTrigger: checksPass`, `NODE_VERSION`, `preDeployCommand`; quitar `ADMIN_PASSWORD`; nuevas variables con `sync: false` (`MERCADOPAGO_WEBHOOK_SECRET`, `PAYMENT_ACCOUNTS_KEY_PREVIOUS`, etc.).
- **Aceptación:** YAML válido contra el esquema de Blueprint; ningún secreto con valor en el archivo; el usuario revisa antes de cualquier sync del Blueprint.

### T2.18 — Prueba de carga reproducible
- **Agente:** devops · **Hallazgos:** I-11 · **Severidad:** Media · **Dependencias:** — ‖ · **Estado:** pendiente
- **Descripción:** `backend/scripts/load-test.js` (sin dependencias, `fetch` concurrente) que reproduce los escenarios de `MEMORIA.md` (compras simultáneas, webhooks repetidos, edición de cupo) contra Postgres local con pasarela simulada; reporte de latencias y errores.
- **Aceptación:** reporte en `docs/evidencias/carga-AAAA-MM-DD.md`; cupo cuadra exacto y no hay entradas duplicadas.

### T2.19 — Plan de continuidad
- **Agente:** documentador · **Hallazgos:** I-11, I-03 · **Severidad:** Media · **Dependencias:** T1.23, T2.18 ‖ · **Estado:** pendiente
- **Descripción:** `docs/operacion/continuidad.md`: escenarios (caída de Render, de la base, de Mercado Pago, de Resend, pérdida de la tarjeta de pago del hosting, día del evento sin conexión), RPO/RTO, decisiones pendientes del usuario (instancia única, escalar plan, M-09).
- **Aceptación:** cada escenario con detección, acción y responsable; aprobado por el usuario.

### T2.20 — Validación de secretos al arrancar [SEGURIDAD]
- **Agente:** dev-backend · **Hallazgos:** I-12, H-08 · **Severidad:** Media · **Dependencias:** T2.09 · **Estado:** pendiente
- **Descripción:** con `NODE_ENV=production`, no arrancar si `JWT_SECRET` < 32 bytes o falta `PAYMENT_ACCOUNTS_KEY` válida; avisar (`alert`) si faltan secretos de webhook.
- **Aceptación:** tests de arranque con valores inválidos; los tests existentes no se ven afectados.

### T2.21 — Procedimiento de rotación de secretos [SEGURIDAD]
- **Agente:** documentador · **Hallazgos:** I-12 · **Severidad:** Media · **Dependencias:** T2.09, T2.03 ‖ · **Estado:** pendiente
- **Descripción:** `docs/runbooks/rotacion-secretos.md` (inventario de secretos, dueño, custodia, frecuencia, pasos para `JWT_SECRET`, `PAYMENT_ACCOUNTS_KEY`, tokens de MP, secretos de webhook, `RESEND_API_KEY`, verificación posterior). Corregir en `MEMORIA.md` lo de tokens de 30 días (hoy 3 días; luego 8/12 h).
- **Aceptación:** `revisor-docs` lo verifica contra el código; base de M-10.

### T2.22 — `/health` con comprobación de base
- **Agente:** dev-backend · **Hallazgos:** I-14 · **Severidad:** Baja · **Dependencias:** — ‖ · **Estado:** hecha
- **Descripción:** `server.js` l. 93: `SELECT 1` con timeout de 2 s; 200 `{status:"ok"}` o 503 `{status:"degraded"}`; sin `environment` ni versión.
- **Aceptación:** test con base disponible y simulando caída.
- **Nota (otro dev, 2026-11-04):** `/health` hace `SELECT 1` con tope de 2 s; 200 `{status:"ok"}` o 503 `{status:"degraded"}`, sin entorno ni versión (commit `e4877c1`). Falta confirmar que hay un test que simule la caída de la base.

### T2.23 — Tests y verificación de la ola [SEGURIDAD]
- **Agente:** tester · **Hallazgos:** H-05, H-06, H-07, H-09, I-12, I-14 · **Severidad:** Media · **Dependencias:** T2.01–T2.22 · **Estado:** pendiente
- **Descripción:** completar tests faltantes de T2.03, T2.06, T2.07, T2.11, T2.13, T2.20, T2.22; recorrido manual de los 4 sitios con la consola abierta (CSP).
- **Aceptación:** suite en verde; recorrido sin violaciones CSP anotado aquí.

### Cierre de la Ola 2
- **T2.90** tester — regresión completa y ensayo de D2 en Postgres local (migración de `webhookSecretEnc`, re-cifrado v2). Estado: pendiente.
- **T2.91** revisor — diff de la ola, foco en T2.02, T2.03, T2.09, T2.11. Estado: pendiente.
- **T2.92** documentador — `CLAUDE.md` (CSP, sesión, lint, Node), `MEMORIA.md`, `.env.example`, checklist de D2 (aviso de cierre de sesiones). Estado: pendiente.
- **T2.93** revisor-docs. Estado: pendiente.

---

## Ola 3 — Baja

### T3.01 — Listado de compradores sin `accessToken` ni ids de pasarela [SEGURIDAD]
- **Agente:** dev-backend · **Hallazgos:** H-11 · **Severidad:** Baja · **Dependencias:** cierre de Ola 2 ‖ · **Estado:** pendiente
- **Descripción:** `GET /api/purchases/event/:id` deja de devolver `accessToken`, `paymentGatewayId` y similares; nuevo `POST /api/purchases/event/:eventId/:purchaseId/link` (`eventManager`, auditado) que devuelve el link de una compra pagada.
- **Aceptación:** test de que el listado no contiene esos campos y de que el organizador no obtiene links de eventos ajenos.

### T3.02 — «Copiar link» usando el endpoint nuevo
- **Agente:** dev-frontend · **Hallazgos:** H-11 · **Severidad:** Baja · **Dependencias:** T3.01 · **Estado:** pendiente
- **Descripción:** adaptar `/admin` y `/organizador`; el export CSV no incluye tokens.
- **Aceptación:** recorrido manual; CSV sin tokens.

### T3.03 — Sin promoción a admin por `ADMIN_EMAIL` [SEGURIDAD]
- **Agente:** dev-backend · **Hallazgos:** H-12 · **Severidad:** Baja · **Dependencias:** cierre de Ola 2 ‖ · **Estado:** hecha parcial, pendiente de aprobación [SEGURIDAD]
- **Descripción:** `utils/admin.js`: crear el admin solo si no existe ningún admin y el email no existe; nunca promover una cuenta existente; registrar en auditoría. Habilita M-05 (borrar `ADMIN_EMAIL`/`ADMIN_PASSWORD`).
- **Aceptación:** tests: con admin existente no hace nada; con email de un staff no lo promueve.
- **Nota (otro dev, 2026-11-04):** `ensureAdmin` solo crea el primer admin y nunca asciende cuentas existentes (commit `e4877c1`, test en `roles.test.js`). Falta registrar la creación en el AuditLog. M-05 (borrar `ADMIN_EMAIL`/`ADMIN_PASSWORD` de Render) queda habilitada.

### T3.04 — API pública sin datos de usuarios [SEGURIDAD]
- **Agente:** dev-backend · **Hallazgos:** H-13 · **Severidad:** Baja · **Dependencias:** ‖ · **Estado:** hecha, pendiente de aprobación [SEGURIDAD]
- **Descripción:** quitar `userId` y nombre del admin de las respuestas públicas de eventos (`withLots` y relacionados).
- **Aceptación:** test sobre `GET /api/events` y `GET /api/events/:id` sin esos campos.
- **Nota (otro dev, 2026-11-04):** La API pública de eventos ya no expone `userId` ni el nombre del admin; el admin sí los ve (commit `e4877c1`, test en `roles.test.js`).

### T3.05 — Scan acotado por evento [SEGURIDAD]
- **Agente:** dev-backend · **Hallazgos:** H-14 · **Severidad:** Baja · **Dependencias:** ‖ (no en paralelo con otras tareas sobre `checkinController.js`) · **Estado:** hecha, pendiente de aprobación [SEGURIDAD]
- **Descripción:** `checkinController.js` l. 333-337: buscar el `Scan` por `id` **y** `eventId`.
- **Aceptación:** test: un scan de otro evento no se encuentra ni se modifica.
- **Nota (otro dev, 2026-11-04):** Un escaneo que ya existe en otro evento no se devuelve ni se modifica (resultado `invalid`); test en `checkin.test.js` (commit `e4877c1`). Tras el merge con la auditoría se registra como `CHECKIN_REJECTED`, no como reenvío.

### T3.06 — Validación de entradas
- **Agente:** dev-backend · **Hallazgos:** H-15 · **Severidad:** Baja · **Dependencias:** ‖ · **Estado:** hecha parcial
- **Descripción:** `express.json` de 2 MB solo en alta/edición de evento (100 kB en el resto); `deviceId` ≤ 64; `buyerEmail` con formato y largo ≤ 254; `status` contra lista blanca.
- **Aceptación:** tests de 413/400 por cada caso.
- **Nota (otro dev, 2026-11-04):** Hecho: `deviceId` ≤ 64 y `buyerEmail` con formato y ≤ 254 (commit `e4877c1`). Falta el límite de cuerpo JSON por ruta (2 MB solo en eventos, 100 kB en el resto) y la lista blanca de `status`.

### T3.07 — Fin de `ticketera_api` en localStorage
- **Agente:** dev-frontend · **Hallazgos:** H-16 · **Severidad:** Baja · **Dependencias:** T2.01 · **Estado:** pendiente
- **Descripción:** el frontend usa siempre su propio origen; borrar la clave si existe; confirmar que no quedan `esc()` en handlers.
- **Aceptación:** `grep` sin `ticketera_api` en `frontend/` (salvo la limpieza).

### T3.08 — Portada solo como data URL [MODELO solo si hay datos a limpiar]
- **Agente:** dev-backend · **Hallazgos:** H-17 · **Severidad:** Baja · **Dependencias:** T2.02 · **Estado:** pendiente
- **Descripción:** aceptar solo `data:image/(png|jpeg|webp);base64,` con tamaño máximo; CSP `img-src 'self' data:`. Antes, consultar si en prod hay portadas `https` (pedírselo al usuario); si hay, migración de datos que las anula.
- **Aceptación:** tests de rechazo de URL externa y de tipo no permitido.

### T3.09 — Formulario de portada sin URL externa
- **Agente:** dev-frontend · **Hallazgos:** H-17 · **Severidad:** Baja · **Dependencias:** T3.08 · **Estado:** pendiente
- **Descripción:** el admin solo sube archivo (ya se reduce en el navegador); quitar la opción de URL.
- **Aceptación:** recorrido manual.

### T3.10 — Limpieza de `lastResend`
- **Agente:** dev-backend · **Hallazgos:** H-18 · **Severidad:** Baja · **Dependencias:** ‖ · **Estado:** pendiente
- **Descripción:** borrar entradas vencidas del `Map` (en el barrido de 5 min o al consultar) y tope de tamaño.
- **Aceptación:** test de que las entradas vencidas desaparecen.

### T3.11 — `.gitignore` de la raíz
- **Agente:** devops · **Hallazgos:** I-13 · **Severidad:** Baja · **Dependencias:** ‖ · **Estado:** pendiente
- **Descripción:** agregar `*.sqlite`, `datos-local/`, `*.log`, `.env*` (salvo `.env.example`), exports `*.dump`.
- **Aceptación:** `git status` no muestra esos archivos al crearlos de prueba.

### T3.12 — Higiene de ramas y autores
- **Agente:** devops · **Hallazgos:** I-15 · **Severidad:** Baja · **Dependencias:** ‖ · **Estado:** pendiente
- **Descripción:** `.mailmap` para unificar autores; lista de ramas remotas con último commit y si están fusionadas, con propuesta (conservar `integracionPagos`). **No borra nada** (M-11).
- **Aceptación:** lista entregada al usuario; `git shortlog -se` sin duplicados.

### T3.13 — Vista «Auditoría» en /admin (opcional) [SEGURIDAD]
- **Agente:** dev-frontend · **Hallazgos:** H-02 · **Severidad:** Baja · **Dependencias:** T1.12, T2.01 · **Estado:** pendiente
- **Descripción:** tabla paginada y filtrable sobre `GET /api/audit`, con export CSV. Hacer solo si el usuario la quiere (la evidencia ya se puede obtener del log stream).
- **Aceptación:** recorrido manual; el organizador no ve la pestaña.

### T3.14 — Tests de la ola
- **Agente:** tester · **Hallazgos:** H-11..H-18 · **Severidad:** Baja · **Dependencias:** T3.01–T3.13 · **Estado:** pendiente
- **Descripción:** completar los tests faltantes y recorrido manual de lo visual.
- **Aceptación:** suite en verde; resultados anotados aquí.

### Cierre de la Ola 3
- **T3.90** tester — regresión completa. **T3.91** revisor — diff. **T3.92** documentador — `CLAUDE.md`, `MEMORIA.md`, checklist de D3 y recordatorio de M-05. **T3.93** revisor-docs. Estado: pendiente.

---

## Ola 4 — Documental

Todos los documentos en `docs/seguridad/`, con encabezado (versión, fecha, dueño, aprobado por, próxima revisión) y referencias a los controles SOC 2 / ISO de `PLAN.md` §6. Pueden escribirse en paralelo; se cierran tras la Ola 3.

### T4.01 — Política de control de acceso [SEGURIDAD]
- **Agente:** documentador · **Hallazgos:** I-16, H-03, H-12 · **Severidad:** Baja · **Dependencias:** T1.16 ‖ · **Estado:** pendiente
- **Descripción:** roles (admin, organizador, staff), mínimo privilegio, alta/baja/cambio, MFA, contraseñas, bloqueo, sesiones, revisión trimestral de accesos (app, GitHub, Render, MP, Resend) con registro.
- **Aceptación:** coincide con el código; plantilla de revisión de accesos incluida.

### T4.02 — Política de gestión de cambios
- **Agente:** documentador · **Hallazgos:** I-16, I-02, I-15 · **Severidad:** Baja · **Dependencias:** T1.21 ‖ · **Estado:** pendiente
- **Descripción:** ramas (`main`, `prod`, de trabajo), PR, CI, CODEOWNERS, revisión, migraciones, despliegue con aprobación del usuario, cambios de emergencia (hotfix) y su registro posterior.
- **Aceptación:** coincide con `.github/` y `render.yaml`.

### T4.03 — Política de secretos y rotación [SEGURIDAD]
- **Agente:** documentador · **Hallazgos:** I-16, I-12 · **Severidad:** Baja · **Dependencias:** T2.21 ‖ · **Estado:** pendiente
- **Descripción:** clasificación, custodia, frecuencia de rotación, rotación ante incidente o salida de una persona; remite al runbook.
- **Aceptación:** inventario de secretos completo y consistente con `.env.example` y `render.yaml`.

### T4.04 — Política de retención y borrado de datos personales [SEGURIDAD]
- **Agente:** documentador · **Hallazgos:** I-16, H-04, H-07 · **Severidad:** Baja · **Dependencias:** ‖ · **Estado:** pendiente
- **Descripción:** qué PII se trata (nombre y email del comprador, emails de usuarios, IPs en auditoría/logs), base legal (Ley 25.326), plazos propuestos (p. ej. anonimizar compradores N meses después del evento; logs y auditoría ≥ 1 año), derechos de acceso/rectificación/supresión, borrado en backups. **Plazos a decidir por el usuario.**
- **Aceptación:** plazos aprobados por el usuario; si implican código, habilita T4.13.

### T4.05 — Política de proveedores
- **Agente:** documentador · **Hallazgos:** I-16 · **Severidad:** Baja · **Dependencias:** ‖ · **Estado:** pendiente
- **Descripción:** criterios de selección, revisión anual (informes SOC 2 / ISO de cada proveedor cuando existan), alta y baja de proveedores, datos que reciben.
- **Aceptación:** aprobada por el usuario.

### T4.06 — Registro de proveedores
- **Agente:** documentador · **Hallazgos:** I-16 · **Severidad:** Baja · **Dependencias:** T4.05, T1.26 ‖ · **Estado:** pendiente
- **Descripción:** `docs/seguridad/registro-proveedores.md`: GitHub, Render (región), Mercado Pago, Resend, proveedor de logs y de uptime, Nave (inactivo); para cada uno: servicio, datos, ubicación, certificaciones, contacto, fecha de revisión.
- **Aceptación:** sin proveedores en uso fuera del registro (contrastado con el código y `render.yaml`).

### T4.07 — Política de continuidad y backups
- **Agente:** documentador · **Hallazgos:** I-16, I-03, I-11 · **Severidad:** Baja · **Dependencias:** T1.23, T2.19 ‖ · **Estado:** pendiente
- **Descripción:** nivel de política sobre `docs/operacion/backups.md` y `continuidad.md`: RPO/RTO aprobados, frecuencia de simulacros, responsables.
- **Aceptación:** consistente con los documentos operativos.

### T4.08 — Política de gestión de incidentes
- **Agente:** documentador · **Hallazgos:** I-16, I-04 · **Severidad:** Baja · **Dependencias:** T1.27 ‖ · **Estado:** pendiente
- **Descripción:** política corta que formaliza el plan de T1.27: obligación de reportar, registro, revisión post-incidente, simulacro anual.
- **Aceptación:** consistente con el plan y los runbooks.

### T4.09 — Política de desarrollo seguro
- **Agente:** documentador · **Hallazgos:** I-16, I-08 · **Severidad:** Baja · **Dependencias:** T2.16 ‖ · **Estado:** pendiente
- **Descripción:** requisitos (OWASP ASVS nivel 1 como referencia), revisión de código, tests obligatorios en cambios de seguridad, dependencias, SAST/secret scanning, datos de prueba sin PII real, separación de entornos.
- **Aceptación:** coincide con lo que CI realmente ejecuta.

### T4.10 — Inventario de activos
- **Agente:** documentador · **Hallazgos:** I-16 · **Severidad:** Baja · **Dependencias:** ‖ · **Estado:** pendiente
- **Descripción:** `docs/seguridad/inventario-activos.md`: servicios, bases, repositorio, dominios, cuentas de terceros, secretos (por nombre), datos (con clasificación pública/interna/confidencial/PII), dispositivos del staff; dueño de cada uno.
- **Aceptación:** contrastado con `render.yaml`, `.env.example` y modelos.

### T4.11 — Catálogo de evidencias
- **Agente:** documentador · **Hallazgos:** I-16 · **Severidad:** Baja · **Dependencias:** T4.01–T4.10 · **Estado:** pendiente
- **Descripción:** `docs/evidencias/README.md`: por control, qué evidencia (ejecuciones de CI, capturas de protección de ramas y 2FA, simulacros de restauración, revisiones de accesos, export de `AuditLog`, reportes de Dependabot/CodeQL, prueba de carga), dónde se guarda, frecuencia y responsable. Las capturas de M-01..M-13 se archivan aquí.
- **Aceptación:** cada fila de la matriz de `PLAN.md` §6 tiene al menos una evidencia definida.

### T4.12 — Declaración de aplicabilidad (SoA) simplificada
- **Agente:** documentador · **Hallazgos:** I-16 · **Severidad:** Baja · **Dependencias:** T4.11 · **Estado:** pendiente
- **Descripción:** tabla de los 93 controles del Anexo A: aplica / no aplica (con justificación, p. ej. controles físicos delegados en Render y GitHub), estado e implementación (referencia a tarea o documento).
- **Aceptación:** los controles de la matriz aparecen como «aplica» con referencia; aprobada por el usuario.

### T4.13 — Anonimización de compradores según la política (condicional) [SEGURIDAD]
- **Agente:** dev-backend · **Hallazgos:** I-16, H-04 · **Severidad:** Baja · **Dependencias:** T4.04 aprobada · **Estado:** pendiente
- **Descripción:** solo si el usuario aprueba plazos: script `scripts/anonymize-buyers.js` (con `--dry-run`) que reemplaza nombre y email de compras de eventos vencidos según el plazo; auditado.
- **Aceptación:** tests con `--dry-run` y ejecución real sobre SQLite; las entradas y estadísticas no se alteran.

### Cierre de la Ola 4
- **T4.90** tester — verifica T4.13 (si se hizo) y que los comandos citados en los documentos funcionan. **T4.91** revisor — diff de T4.13. **T4.92** documentador — `MEMORIA.md` final, índice `docs/README.md`. **T4.93** revisor-docs — todas las políticas contra el código y la configuración. Estado: pendiente.

---

## Acciones manuales del usuario (seguimiento)

Detalle en `PLAN.md` §9. Estado: todas pendientes.

| ID | Acción | Cuándo |
|---|---|---|
| M-01 | Protección de `prod` y `main` en GitHub | Tras T1.21 |
| M-02 | 2FA y revisión de colaboradores en GitHub | Ya |
| M-03 | Secret scanning, push protection, Dependabot, code scanning | Ya / tras T2.16 |
| M-04 | Backups de Render: confirmar, retención, exports previos, simulacro | Antes de D0 y T1.24 |
| M-05 | Borrar `ADMIN_PASSWORD` (ya), `DB_SYNC_ALTER` (tras D1), `ADMIN_EMAIL` (tras D3) | Según despliegue |
| M-06 | Log stream con retención ≥ 1 año y alertas | Tras T1.26 |
| M-07 | Monitor de uptime externo sobre `/health` | Tras T1.26 |
| M-08 | Confirmar región; `preDeployCommand` y `NODE_VERSION` | Antes de D1 / T2.17 |
| M-09 | Reactivar tarjeta; decidir escalado | Ya |
| M-10 | Rotación de claves y contraseñas existentes | Tras D2 |
| M-11 | Decidir ramas a borrar | Tras T3.12 |
| M-12 | Aprobar despliegues, tareas `[SEGURIDAD]` y políticas | Cada ola |
| M-13 | Secretos de webhook de MP y verificación de `collector_id` | Tras D2 |
