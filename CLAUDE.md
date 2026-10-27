# CLAUDE.md — Contexto del proyecto VIPCARGASANTINO

> ⚠️ **LEER PRIMERO (continuidad entre sesiones).** El owner trabaja en **Tails sin
> almacenamiento persistente**: al reiniciar la PC se borra TODO lo local y vuelve a
> clonar este repo desde GitHub. Por eso el contexto vive ACÁ (en el repo), no en la
> memoria local del asistente.
>
> **REGLA PERMANENTE (los 3 docs vivos):** tras cada cambio significativo (feature,
> fix importante, decisión de diseño) mantené actualizados:
>   1. `WORKLOG.md` — QUÉ se hizo y por qué (diario de sesiones, entrada numerada).
>   2. `docs/ARCHITECTURE.md` — CÓMO funciona (si el cambio altera un flujo, modelo,
>      endpoint o agrega una trampa nueva, reflejalo ahí; corregí lo que quede stale).
>   3. `CLAUDE.md` (este archivo) — solo si cambió algo del CONTEXTO de arranque
>      (estructura, gotchas de primer nivel, reglas de trabajo).
> Commiteá y pusheá a GitHub para que la próxima sesión pueda seguir donde se dejó.
> Esta regla aplica siempre, sin que el owner tenga que pedirlo cada vez. El objetivo:
> que una sesión nueva en Tails sepa TODO leyendo estos docs, sin re-analizar el repo.
>
> Al iniciar una sesión nueva: leé `WORKLOG.md` (estado actual) y `docs/ARCHITECTURE.md`
> (mapa completo de modelos, flujos, front y trampas — actualizado 2026-07-09 tras una
> lectura de punta a punta del repo). Antes de modificar un flujo central, leé además
> el código puntual del área. El código es la verdad; los docs son el mapa.

---

## Qué es

Backend de una **sala de juegos** (mercado argentino) que opera como wrapper sobre la
plataforma externa **1girox** (Partner API REST/JSON; panel en `admin.1girox.com`).
Capta usuarios, los crea en la plataforma por API, gestiona cargas/retiros vía CBU,
reembolsos, ruleta, fueguito, referidos y campañas/publicistas. UX en PWA con
notificaciones push (FCM).

> **Migración 2026-07-31:** antes el wrapper era sobre **JUGAYGANA**
> (`admin.agentesadmin.bet`). Los 4 clientes viejos (`jugaygana.js`,
> `jugaygana-movements.js`, `src/services/jugayganaService.js`,
> `jugayganaPublisherSessions.js`) + `referralRevenueService.js` y
> `jugayganaUserLinkService.js` **siguen en el repo pero YA NADIE los importa**: se
> conservan sólo para poder revertir. No agregarles features ni tomarlos de referencia.

**Stack:** Node 20 · Express · MongoDB (Atlas) · Mongoose · Socket.IO (+ Redis adapter
para multi-instancia en AWS EB) · Firebase Admin (FCM) · AWS SNS (SMS OTP).
Deploy: AWS Elastic Beanstalk. Dominio público: vipcargas.com. Git user: jupedro2112-pixel.

## Estructura

- `server.js` (~15.7k líneas) — entry point. ~180 rutas, authMiddleware inline (~L2477),
  Socket.IO (~L7325), motores cron por setInterval (~L14100+), bootstrap async con SSM
  (final del archivo). Comentario dice "en migración" pero en la práctica sigue
  creciendo acá. (Los números de línea derivan con cada cambio — usar grep.)
- `config/database.js` — el `connectDB` que server.js realmente usa (TTL de mensajes,
  proxy a /src/models). **OJO: hay DOS connectDB** (este y `src/models/index.js`); el
  segundo NO se usa desde server.js. No tocar schemas en config/database.js (sólo
  define ExternalUser y UserActivity; el resto es proxy a /src/models).
- `src/services/hgcashService.js` y `src/services/finproService.js` — los DOS bancos con API
  (hgcash y **Finpro**, #217–#219, réplica de #368–#370 de AUTOGIROXcompartido). Comparten el
  pipeline de matcheo/auto-carga de server.js (`hgcashMatch*`, `hgcashAutoCarga`, bandeja y
  cierre del #183); `Config['bankProvider']` elige por cuál salen los retiros y la sección
  "🏦 Bancos automáticos" del panel por cuál(es) entran las cargas.
- `src/services/giroxService.js` — **cliente ÚNICO de la Partner API** (altas, saldo,
  cargas, retiros, bonos, cambio de clave y login único/SSO).
- `src/services/giroxUserLinkService.js` — resuelve y cachea `User.giroxUserId`.
- `src/services/giroxPublisherKeys.js` — alta de jugadores con la API key del publicista.
- `src/utils/periodRanges.js` — rangos de fecha (ayer / semana / mes) en hora argentina.
- `jugaygana*.js` + `referralRevenueService.js` + `jugayganaUserLinkService.js` —
  **muertos**, sin consumidores. Ver la nota de migración arriba.
- `src/models/` — schemas Mongoose canónicos (fuente de verdad). Banco: BankMovement,
  BankSweep (bajadas), DailyClose (cierre), CashierSnapshot (saldo cajero 1girox — hoy
  vacío, la API no lo informa).
- `src/services/` — lógica (referidos, notificaciones, otp, metaCapi, fbAds, hgcash,
  comprobantes IA, analítica publicistas…).
- `public/` — PWA del cliente (namespace global `window.VIP`, SW único
  `firebase-messaging-sw.js`). `public/adminprivado2026/` — panel admin (~12k líneas
  de admin.js, cookie httpOnly, SW propio `admin-sw.js` con scope /adminprivado2026/).

## Cosas que NO hay que romper (gotchas)

- **Credenciales de hgcash (#192):** además de SSM, se pueden cargar desde el panel (cifradas
  en Config con clave derivada de JWT_SECRET; panel > SSM). Cambio de cuenta hgcash = panel →
  Comandos → Banco automático, sin tocar AWS. No volver a leer `process.env.HGCASH_API_TOKEN`
  directo: usar `hgcashPay.getToken()` y `_hgcashWebhookSecrets()`. **Reenvío a otras
  páginas:** también desde el panel (`Config['hgcashFanout']`, hasta 5 URLs; sin config vale
  `HGCASH_FANOUT_URL`). Un aviso ya reenviado (`X-Forwarded-By`) no se vuelve a reenviar.
- **Finpro (#217–#220), segundo banco con API paralelo a hgcash:** mismo pipeline. **Entrantes =
  WEBHOOK primero (#220), comprobante como respaldo:** `POST /api/finpro/webhook` (secundario,
  firmado HMAC-SHA256 de `timestamp.rawBody` — hace falta `req.rawBody`, que ya deja el
  `express.json({ verify })` global: no cambiar el parser) → dedupe por `fp:<notification_id>` y por
  COELSA → titular del pagador por `accounts/information` (cache 24 h) → `_finproIngestIncoming(n,
  'webhook')` → `hgcashMatchFromMovement`. La MISMA URL recibe entrantes y salientes (Finpro pide
  dos URLs: darle esta en las dos) y un Cliente API puede tener VARIOS CVUs (`finpro.ourCvus()`:
  principal + "Otros CVUs" del panel / `FINPRO_EXTRA_CVUS` — no asumir uno solo). Sin el alta del
  webhook Finpro no manda nada (la transferencia queda en su portal); sin secreto en prod el webhook se rechaza (503) y la carga
  nace del COMPROBANTE → `transfers/verify/incoming` (coelsa → monto+fecha) → `_finproIngestIncoming`
  (BankMovement `provider:'finpro'`) → `hgcashAutoCarga` (candados, bonos pendientes y vínculos del
  #183 de siempre: "toda carga del banco deja el vínculo en las dos direcciones" aplica a Finpro
  igual). `not_found_yet` se re-consulta cada 2 min hasta 90 min (`_finproReverifyTick`);
  `ambiguous`/confianza media NO carga. Ni webhook ni verify informan reversiones → no hay débito
  automático. **Secreto de firma:** panel (`Config['finproCredentials'].webhookSecretEnc`) > SSM
  `FINPRO_WEBHOOK_SECRET`, vía `_finproWebhookSecrets()` (acepta los dos). El callback de retiros
  (`/api/finpro/callback`, webhook principal) con firma válida decide desde el payload; sin ella
  sigue confirmando por consulta — nunca plata por un body sin firma. Test: `node
  scripts/test-finpro-webhook.js`.
  **Retiros:** un pago = UN `process_id` (`PendingPayout.fpProcessId`): se reusa solo si el lote fue
  aceptado (`fpAccepted`); tras un timeout NO se reenvía (el poll pregunta); transferencias del mismo
  CVU de a UNA (`finpro.withCvuLock`, error 2454); `transaction_id` ≤ 11 chars. El comprobante del
  pago es el `coelsa_id` (`fpCoelsaId`); no hay PDF. **Token 1 h** solo para `accounts/information`;
  el resto va con `X-API-Key`/`X-API-Secret`. **La URL default es la de DESARROLLO**
  (`mw-dev.finpro.com.ar`): la de producción se carga en el panel (aviso rojo). Credenciales +
  bankId/cuenta/CVU/URL: panel (`Config['finproCredentials']`, cifrado con `_credEncrypt`) > SSM
  (`FINPRO_*`). Arranca APAGADO para cargas y hgcash sigue pagando los retiros hasta que el owner lo
  cambie en "🏦 Bancos automáticos". Un cambio en `hgcashAutoCarga`/`hgcashMatch*` afecta a los DOS bancos.
- **JWT_SECRET y otros secrets** se cargan desde AWS SSM en el bootstrap async, NO al
  `require()`. Por eso hay lazy getters en `src/middlewares/auth.js` y rutas.
- **IDEMPOTENCIA POR `reference` (lo más importante de la plataforma nueva).** Cargas,
  retiros y bonos llevan una `reference` única por operación. Reintentar con la MISMA
  no duplica (la API devuelve `duplicate:true`). Se rompe plata en las dos direcciones:
  si dos operaciones DISTINTAS comparten reference, la segunda **no se acredita** (el
  cliente transfiere y no recibe fichas); si la reference **cambia** entre reintentos
  del mismo pago, se paga **dos veces**. Por eso cada flujo la deriva de una llave que
  ya es única y estable (id de Transaction, periodKey del reembolso, movimiento
  bancario, id del giro/payout). Ver la tabla de prefijos `vip-*` en ARCHITECTURE §.
- **Rate limit: 60 req/min** en la Partner API. Hay un limitador local (`GIROX_MAX_RPM`,
  default 55) pero es **por proceso** → con N instancias en EB el techo real es N×55 y
  el 429 sigue siendo posible (se reintenta respetando `Retry-After`).
- **Rollover ACTIVO en la plataforma:** el jugador puede tener saldo que NO puede
  retirar. Validar retiros contra `wagering.available`, **nunca** contra `balance`.
- **El netwin sale de la Partner API** (`GET /players/{username}/stats`, v1.8), por
  username y con la misma API key. ⚠️ `netwin` POSITIVO = el jugador PERDIÓ (es la base
  del reembolso); negativo = ganó. Máximo 92 días por consulta, y el rango se evalúa
  en hora argentina del lado de la plataforma. Para varios jugadores está el batch
  (`POST /players/stats/batch`, hasta 100) — es lo que hace viable el cálculo de
  comisiones de referidos sin comerse el límite de 60 req/min.
- **Reembolsos por RANGO** (Bronce 3% / Plata 6% / Oro 10%), según lo perdido EN EL
  PERÍODO que se reclama — no un acumulado. Ver `src/utils/refundTiers.js`. Desde
  2026-09-11 la base del período es `casinoNetwin − bonus.granted` y se descuenta
  lo ya cobrado como reembolso en vivo.
- **REEMBOLSO EN VIVO acumulativo (2026-09-11):** espec en
  `docs/ESPEC-REEMBOLSO-1GIROX.md` (leerla antes de tocar reembolsos). Fórmula pura
  en `src/utils/cashbackFormula.js` + test `scripts/test-cashback-formula.js`
  (correrlo tras cualquier cambio); motor `_cashbackStateToday` en server.js; modelo
  `CashbackClaim`; reference `vip-cbk-<userId>-<día>-<seq>`. La base descuenta
  TODO lo regalado (incluidos los reembolsos ya cobrados) → todo regalo nuevo tiene
  que quedar en Transaction con tipo de regalo o en `deposit.bonus`. Config en el
  panel (`Config['instantCashback']`, default apagado).
- **Regalos = BONO 0 "regalo directo" (2026-09-07, Partner API v1.10+/manual v1.15 en
  `docs/`):** `creditUserBalance` sin `multiplier` va por `POST /players/{u}/bonus`
  con `multiplier: 0` → disponible/retirable al instante, SIN reclamo, NO pisa el bono
  en curso, y en el panel de 1girox figura como **Bono** (antes iba por `/deposit` y
  reembolsos/ruleta/rakeback/VIP/referidos salían como "Carga"). Fallback automático
  a depósito libre con la MISMA reference si el bono suelto está apagado, 0 no está
  permitido o el monto sale de `fixed_min/fixed_max`. Kill switch `GIROX_GIFT_AS_BONUS=0`.
  Un `multiplier` EXPLÍCITO (>0) sí usa `/bonus` con rollover: puede quedar "a reclamar"
  (`girox.claimPendingBonus()`) y PISA un bono activo. El **fueguito** con rollover >0
  va por `/bonus` con ese multiplier (`_creditFireReward`) salvo que el jugador ya
  tenga bono activo → cae al depósito con `multiplier` de antes. **La ruleta escribe
  `Transaction type:'roulette'`**; tipo de Transaction nuevo ⇒ etiqueta + filtro +
  case del resumen en el panel (§6 de ARCHITECTURE). La devolución de retiro
  rechazado sigue como depósito (no es regalo).
- **ROLLOVER GLOBAL de bonos (2026-09-16):** espec en
  `docs/ESPEC-ROLLOVER-GLOBAL-Y-MULTICUENTA-TITULAR.md`. Se aplica en el CLIENTE
  (`giroxService`: `creditGift`, `creditUserBalance` con multiplier, `bonus_multiplier`
  de `depositToUser`) con un resolver inyectado desde server.js; default ENCENDIDO x3
  (decisión del owner 2026-09-16: TODO con x3; x3 habilitado en la cuenta). Un bono
  nuevo no resuelve el
  rollover a mano; solo referidos y devoluciones pasan `ignoreGlobalRollover:true`.
  Test en frío: `node scripts/test-rollover-multicuenta.js`. La misma espec (§B)
  cruza el TITULAR del comprobante (`Comprobante.originHolderKey`) contra otras
  cuentas: avisa, no bloquea.
- **Ruleta diaria y bono por instalar (2026-09-18, réplica del gemelo PAUTANUEVAsantino
  2026-10-21 #206):** los premios de la ruleta (tipo dinero/bonificación %, valor, rollover,
  peso) y la elegibilidad (`enabled`, `requireDeposits` cargas en los últimos `depositDays`
  días, `requireAppInstalled`) viven en `Config['dailyRoulette']`; giro cada 24 h; el % EXTRA
  vence a las 24 h; todo bono aplicado dentro de una carga deja su Transaction 'bonus' propia
  con `metadata.appliedOnDeposit:true` (`_recordAppliedBonusTx`; excluida de la base del
  reembolso en vivo). La regla
  del bono por instalar (% hasta un tope + % del excedente) en `Config['installBonus']`.
  No hardcodear "100%", "$5.000" ni "10 cargas": salen de la config y de las variables
  `{pct} {tope} {excedente} {regla}` de `/sys_install_bonus`. Un premio "%" de la
  ruleta y el bono de instalación los APLICA EL SERVER solo en la carga (hgcash y
  manual, pisando el bono del agente si hay pendientes; nunca en multicuenta) vía
  `_pendingBonusFor` + `_settlePendingBonuses`. Un flujo de carga nuevo tiene que
  pasar por ahí. **Lotes con regalo (#191, 2026-10-07):** si no hubo bono pendiente ni
  bonus del agente, la carga (manual y hgcash) suma el % AUTOMÁTICO de un lote vigente
  (`claimAutoPromoPercent` → bonus de la MISMA operación con tope `_loteBonusAmount` →
  `settle`/`revert`). Una carga = como mucho UN bono automático. Las fichas de un lote
  por tiempo se acreditan recién cuando el cliente toca 🎁 RECLAMAR (`/api/gift/claim`).
- **Funciones replicadas de PICA ROJA (#208, 2026-10-26):** TODAS arrancan APAGADAS y se prenden desde COMANDOS →
  "🧩 Funciones" (`src/services/featureFlags.js`, `Config['features']`). Toda ruta/cron de Datos IA, Alertas de
  estafa, Centro de avisos, piloto automático e historias tiene que consultar `featureFlags.isOn(...)`; un ítem nuevo
  del menú del panel lleva `data-feature="x"`. El sistema de notificaciones automáticas ANTERIOR (reglas, encuesta,
  `ScheduledNotif`) corre sólo con `legacyNotifs` ON. El registro es `Config['registrationMode']` `'open'|'invite'`
  (`_inviteOnlyBlocks`; también en el envío del OTP). **Historias (#210):** `Story` + `storyAutopilot`/`storyImage`;
  el bono "+X%" de una historia se aplica en la carga por el MISMO pipeline de la ruleta (`_pendingBonusFor` /
  `_settlePendingBonuses` → `_consumeStoryBonus`, source `story_bonus`). En el panel `deleteStory`/`loadStories` son de
  las historias de INFLUENCERS: las de la app se llaman `*AppStory`. **Centro de avisos / piloto (#211):** todo aviso
  automático nuevo sale como lote por `_createNotifBatchFromBody` (así cuenta para el tope `dailyCap`/`monthlyCap`) y toda
  push nueva lleva `data.kind` ('promo' masivo · 'personal' lo del cliente) para respetar `User.notifPrefs`. El piloto
  pre-programa `ScheduledCampaign.autoKey 'ap-*'`: no borrar ese índice único.
- **Pushes con la RULETA** (2026-09-07 → #206): `notificationService.isRouletteText` bloquea el
  envío en las 5 funciones (`blocked:'roulette'`) y el seed del boot migra reglas/plantillas
  SOLO si la ruleta diaria está APAGADA en el panel (`setRouletteActive`, lo setea
  `getDailyRouletteConfig()`). Con la ruleta ACTIVADA (default) las pushes pasan.
- **Username tomado en 1girox por OTRA estructura** (2026-09-07):
  `syncUserToPlatform` devuelve `code:'username_taken_foreign'` y TODAS las altas
  rebotan sin dejar cuenta local (una cuenta así "vinculada" es inoperable para
  siempre: username nuevo).
- **Roles:** `user`, `admin` (todo), `depositor` (solo cargas), `withdrawer` (solo
  retiros), `publisher_admin` (solo crea usuarios de su publicista — lockdown via
  `PUBLISHER_ADMIN_ALLOWED_PATHS`).
- **Auth:** JWT por header Authorization O por cookie httpOnly `admin_api_session`
  (el panel admin usa cookie).
- **Mensajes automáticos al usuario** son editables desde la sección COMANDOS
  (comandos `/sys_*`). Usar el helper `renderSystemCommand(name, fallback, vars)` para
  cualquier mensaje automático nuevo.
- **Transaction** (cargas/retiros) es permanente (sin TTL). **Message** tiene TTL de 3
  días. La analítica de clientes se basa en Transaction.
- **Montos en PESOS.** ⚠️ Ojo si mirás código o docs viejos: JUGAYGANA trabajaba en
  centavos y todo se multiplicaba ×100. **1girox NO** — se manda el monto tal cual, con
  decimales si hace falta. Multiplicar por 100 sería cargar 100 veces de más.
- **No hay NINGUNA sesión que renovar.** Auth por `X-Api-Key` fija en todo, incluido
  el netwin. Se fueron `ensureSession`, el mutex de login, `isHtmlBlocked` y el Bearer
  del panel (con `giroxReportsService`, eliminado el 2026-07-31).
- **Bonos automáticos APAGADOS por flags** (owner 2026-06-24): `INACTIVIDAD_DISABLED`
  y `BONUS_STRATEGY_DISABLED` (server.js) + `CHARGE_BONUSES_DISABLED`
  (notificationRulesService) + bonos de encuesta con `bDays=[]`. Tope 30% en TODO lo
  automático (cap de lectura en `_getActivePromoBonus` incluido).
- **Bandeja del banco / cierre diario (#183, réplica 1:1 del #155 del gemelo
  AUTOREEMBOLSOS):** una transferencia hgcash = UNA acreditación. Toda carga que venga
  del banco deja el vínculo en las dos direcciones (`BankMovement.transactionId` +
  `chargeSource` y `Transaction.metadata.movementId`), y la carga ASIGNADA desde la
  bandeja va SIEMPRE por `hgcashAutoCarga({assign})` (misma reference `vip-hg-*`, mismo
  candado por coelsa). Si no, el cierre diario (`src/services/bankCloseService.js`,
  Telegram 00:05 ART) lo marca. Mismos nombres de modelos/endpoints/funciones del panel
  que el gemelo: no renombrar. El cruce con el cajero queda `sin_datos` hasta que 1girox
  informe el saldo del agente.
- **Multi-instancia (AWS EB):** los crons son `setInterval` en CADA instancia; su
  idempotencia depende de índices únicos (EncuestaFire.slotKey, InactividadFire.fireKey,
  HgcashCharge.chargeKey, DailyRouletteSpin userId+dateKey). No quitar esos índices.
- **Front frágil:** cientos de `onclick` inline dependen de funciones en `window.*`
  (no renombrar exports sin actualizar el HTML/strings). Tabla de usuarios del panel
  acoplada a `USERS_LIST_FIELDS` del backend (columna nueva ⇒ sumar campo al select).
  Detalle completo de trampas en `docs/ARCHITECTURE.md` §7.

- **Píxeles de Meta (#214):** se cargan desde COMANDOS → "📣 Píxeles de Meta por publicista" (`Config['metaPixels']`, token cifrado)
  además de SSM. Un evento de Meta nuevo SIEMPRE lleva `externalId` (User.id) para que vaya al píxel del publicista del cliente; la
  carga automática del banco manda `Purchase` (#213). Un "código de prueba" cargado convierte TODOS los eventos de ese píxel en
  eventos de prueba (no cuentan): vacío fuera de las pruebas.
- **Webhooks salientes y prefijo (#197, réplica del gemelo AUTOGIROXcompartido):** todo flujo
  NUEVO de registro o carga llama `outboundWebhook.notify('registro'|'carga', user, {...})` al lado
  de su `fbAdsWebhook.notify` (fire-and-forget). El username de la landing y las altas del panel
  salen de `getUsernamePrefix()` (`Config['usernamePrefix']`): no hardcodear "gx"/"g1"/"girox".
  `GET /api/config/access` es público y lo piden el panel y la PWA al arrancar.

- **iPhone instalada CON SESIÓN (#207):** `GET /manifest.json` es una ruta dinámica (antes de
  `express.static`) que mete el token de instalación en `start_url` (`?instal=`); la PWA lo canjea
  en `/api/auth/install-token/redeem`. El token (`User.installTokenHash`, 7 días, reutilizable) es
  DISTINTO del access link de un solo uso: no reusar `accessLinkHash` para esto. Todo flujo que
  cambie la clave tiene que borrar `installTokenHash`. El diagnóstico vive en
  `GET /api/admin/install-diag`.

- **Landing externa (#198):** `landing/` es la landing de PAUTANUEVAsantino apuntando a
  `https://cargas1girox.com` (NUNCA vipcargas.com: Cloudflare le mete challenge al preflight y la
  landing muestra "Sin conexión"). Todo endpoint que la landing llame cross-origin va en
  `LANDING_OPEN_CORS_PATHS`. El alta devuelve `accessUrl` con `ir=creds` (recuadro usuario+clave
  en la PWA) y `metaEventId`; `ir=casino` es legacy.

- **Lotes y Cronograma (#195):** el POST `/api/admin/notif-batches` es un wrapper de
  `_createNotifBatchFromBody(body, user)`; cualquier validación/efecto nuevo del lote va en esa
  función (así lo heredan las campañas programadas). Las rutas del cronograma son
  `/api/admin/cronograma*` porque `/api/admin/campaigns` YA es de publicistas: no reusar ese path.
  El compositor push (`/api/notifications/send-batch`) es un wrapper de `sendBatchPush` en
  `notificationRoutes.js` (misma regla: lo nuevo del envío va en la función).

## Flujo de trabajo del asistente

1. Leer `WORKLOG.md` al iniciar.
2. Hacer el cambio. Validar sintaxis (`node --check` en archivos tocados) **y, si se
   tocó `server.js`, correr `node scripts/check-tdz.js`** (detecta usos de nivel
   superior antes de su `require` y rutas antes de `const authMiddleware`: `node
   --check` NO los ve y tumban el server al arrancar — pasó el 2026-09-16). No hay
   node_modules local, así que no se puede correr el server; sólo syntax check).
3. Actualizar `WORKLOG.md`.
4. Commitear y pushear a `main` cuando el owner lo pida (o si pidió "todo seguido").
