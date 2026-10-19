# ESPEC PORTABLE — WEBHOOKS SALIENTES a publicistas (registro / primera carga / carga / retiro)

> Para copiar TAL CUAL a otro repo de la misma familia (wrapper 1girox: `server.js` + panel
> `public/adminprivado2026/`). Origen: AUTOGIROXcompartido WORKLOG #334, #342, #344, #346
> (2026-10-08/09), replicado en CARGASGIROX como #197 (2026-10-19). Todo el código de abajo es
> el que está en producción en CARGASGIROX; los puntos de enganche se describen por ANCLA (texto
> a buscar con grep), no por número de línea.
>
> **Cómo usar este doc con Claude Code:** pegarle el prompt de la sección 0 y adjuntar/pegar este
> archivo entero. Claude tiene que copiar los bloques tal cual y SOLO adaptar los nombres que la
> sección 1 ("Requisitos") marca como variables del repo destino.

## 0) Prompt para pegarle a Claude en el repo destino

```
Leé el archivo docs/ESPEC-WEBHOOKS-SALIENTES.md (lo pego abajo) y aplicalo TAL CUAL en este repo,
que es un wrapper sobre 1girox igual que el de origen. Reglas:
1. Primero verificá los "Requisitos previos" (sección 1): decime qué helper falta y usá el
   fallback que indica la espec. No inventes helpers nuevos si ya existe uno equivalente.
2. Creá los 2 archivos nuevos (secciones 2 y 3) COPIADOS sin cambios.
3. Agregá resolveEventScope a src/services/metaCapiService.js (sección 4) o, si este repo no
   tiene ese servicio, creá el módulo mínimo que la sección indica.
4. En server.js aplicá los bloques de la sección 5 en el orden dado, buscando cada ANCLA con
   grep. Todas las rutas van DESPUÉS de `const authMiddleware` y de `adminMiddleware`.
5. Enganchá outboundWebhook.notify(...) en TODOS los flujos de registro, de carga acreditada y
   en el aviso de retiro pagado (sección 6). Listá cuáles encontraste antes de tocar.
6. Panel: sección 7 (HTML) y 8 (JS) + bump del CACHE_VERSION del admin-sw.
7. Validá con node --check en cada archivo tocado y, si existe, node scripts/check-tdz.js.
8. Actualizá WORKLOG.md (y ARCHITECTURE.md si existe) y commiteá. No deployes.
Al final decime: anclas que no encontraste, flujos de carga/registro sin hook y qué probar.
```

## Qué implementa

Además del pixel de Meta / fb-ads (que siguen igual, en paralelo), el sistema avisa por **webhook**
(POST JSON firmado) a uno, varios o TODOS los publicistas:

- **Eventos:** `registro` y `primera_carga` SIEMPRE; `carga` (todas) y `retiro` (pagado) OPCIONALES
  por destino. Datos de `attribution` (fbclid/fbc/fbp/UTM/landing/IP) y `contact` (mail/teléfono)
  OPCIONALES por destino. El payload **NO lleva username** (el publicista identifica al jugador por
  `user.id`, UUID interno; se pega en el buscador de Usuarios del panel).
- **Destinos** desde el panel (`Config['outboundWebhooks'].destinations[]`, hasta 10): nombre, URL
  https, secreto (cifrado), activo, alcance `all | publishers` (lista de publicistas = `Campaign.publisher`
  o códigos de campaña), eventos, campos, y **modo de autenticación** `hmac_ts` (default: HMAC-SHA256
  de `"{ts}.{body}"` en `X-Webhook-Signature`) | `hmac_body` (HMAC del body en un header a elección,
  estilo GitHub/Shopify) | `bearer` | `header` (API key fija).
- **Headers siempre:** `X-Webhook-Event`, `X-Webhook-Id` (= `event_id`, estable por evento →
  idempotencia del receptor), `X-Webhook-Timestamp`, `X-Webhook-Signature`.
- **Entrega:** fire-and-forget (nunca frena el handler). 3 reintentos inmediatos (1 s / 4 s / 16 s);
  si sigue fallando, cola en Mongo (`OutboundWebhookQueue`) reintentada cada 5 min hasta 10 intentos.
  4xx (salvo 408/429) NO se reintenta. El error guarda lo que respondió el receptor (160 chars).
- **Panel:** card "🔗 Webhooks salientes" en Configuración (solo admin general): lista con último
  resultado / en cola, editor, "Enviar prueba" (evento `prueba`, `test:true`), "📋 Copiar formato para
  pasarle" (solo lo que ese destino recibe) y el formato completo plegado (uso interno).

## 1) Requisitos previos en el repo destino

| Necesita | Para qué | Si NO existe |
|---|---|---|
| `axios`, `mongoose`, `crypto` | servicio | ya están en todos los repos de la familia |
| `Config` modelo con `Config.set(key, value, by)` y `getConfig(key, default)` | guardar destinos | usar el equivalente del repo (`setConfig`) |
| `_credKey()` / `_credEncrypt(plain)` / `_credDecrypt(blob)` (AES-256-GCM, clave derivada de `JWT_SECRET`; viene del feature "credenciales hgcash desde el panel") | secreto del destino cifrado | copiar el bloque de la sección 5.0 |
| `getPublicBaseUrl()` | campo `site` del payload | cualquier función que devuelva `https://dominio` |
| `metaCapi.resolveEventScope(userInfo, opts)` | publicista del usuario | sección 4 |
| `Campaign` (campo `publisher`), `User` (`acquisitionCampaign`, `giroxOwnerCampaign`, `acquisitionUtm`, `metaFbc/metaFbp`, `landingUrl`, `registrationIp`, `email`, `phone`, `phoneVerified`) | alcance y payload | los campos que falten salen `null`, no rompe |
| `Transaction` con `type:'deposit'` y `metadata.source` | `_isFirstDeposit` | sección 5.2 |
| `authMiddleware`, `adminMiddleware`, `logger`, `uuidv4` | rutas | ya existen |
| Panel: `authFetch`, `showToast`, `escapeHtml`, `fmtFechaHoraAR` | card | ya existen en la familia |

---

## 2) NUEVO `src/models/OutboundWebhookQueue.js` (copiar completo)

```js
/**
 * OutboundWebhookQueue (#334) — cola persistente de avisos salientes (registro /
 * primera carga / carga / retiro) que NO pudieron entregarse a un destino tras los
 * reintentos inmediatos. El worker de outboundWebhookService los reintenta cada
 * 5 min hasta MAX_TOTAL_ATTEMPTS y después los descarta.
 */
const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  destId: { type: String, required: true, index: true },   // id del destino (Config['outboundWebhooks'])
  event: { type: String, required: true },
  eventId: { type: String, required: true },
  payload: { type: Object, required: true },               // body exacto que se firma y se manda
  attempts: { type: Number, default: 0 },
  lastError: { type: String, default: null },
  nextRetryAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now }
});

schema.index({ nextRetryAt: 1 });

module.exports = mongoose.models['OutboundWebhookQueue']
  || mongoose.model('OutboundWebhookQueue', schema);
```

## 3) NUEVO `src/services/outboundWebhookService.js` (copiar completo)

```js
// ============================================
// WEBHOOKS SALIENTES (#334) — registro / primera carga / carga / retiro
// --------------------------------------------
// Owner 2026-10-08: además del pixel de Meta (que sigue igual, en paralelo),
// avisar por WEBHOOK a uno o varios destinos: un publicista, varios, o TODOS.
// Cada destino se configura desde el panel (Config['outboundWebhooks']):
//   { id, name, url, secret (cifrado), enabled,
//     scope: 'all' | 'publishers', publishers: ['Ok2026', 'PWAUTO', …]  // nombre del
//            publicista (Campaign.publisher) o código de campaña,
//     events: { registro, primera_carga, carga, retiro },               // qué recibe
//     fields: { atribucion, contacto } }                                 // opcionales
//
// Aviso (POST JSON):
//   headers: X-Webhook-Event, X-Webhook-Id, X-Webhook-Timestamp (unix seg),
//            X-Webhook-Signature = HMAC-SHA256 hex de `${timestamp}.${body}` con el
//            secreto del destino (mismo esquema que GH Wallet: el receptor valida con
//            el body EXACTO). Idempotencia: `event_id` fijo por evento (repetir un
//            reintento manda el MISMO id).
//   body: { event, event_id, sent_at, site, test, user:{…}, amount, currency,
//           first_deposit, transaction_id, occurred_at, attribution?, contact? }
//
// Entrega: 3 reintentos inmediatos (1s/4s/16s); si falla, cola en Mongo
// (OutboundWebhookQueue) reintentada cada 5 min hasta 10 intentos. 4xx (salvo
// 408/429) no se reintenta. Fire-and-forget: NUNCA frena el handler que lo llama.
// ============================================

const axios = require('axios');
const crypto = require('crypto');
const OutboundWebhookQueue = require('../models/OutboundWebhookQueue');

let logger = console;
try { logger = require('../utils/logger') || console; } catch (e) { /* fallback */ }

const RETRY_DELAYS_MS = [1000, 4000, 16000];
const MAX_TOTAL_ATTEMPTS = 10;
const QUEUE_RETRY_MS = 5 * 60 * 1000;
const POST_TIMEOUT_MS = 8000;
const EVENTS = ['registro', 'primera_carga', 'carga', 'retiro'];

// Inyectado desde server.js: cómo leer los destinos (con el secreto ya descifrado),
// cómo resolver publicista/campaña de un usuario y la URL pública del sitio.
let _cfg = { getDestinations: async () => [], resolveScope: async () => null, publicBaseUrl: () => '' };
function configure(opts) { _cfg = Object.assign({}, _cfg, opts || {}); }

// Estadísticas por destino (por instancia, desde el arranque): último resultado.
const _stats = new Map();
function _stat(destId, ok, err, event) {
  const st = _stats.get(destId) || { ok: 0, fail: 0, lastAt: null, lastOk: null, lastError: null, lastEvent: null };
  if (ok) st.ok++; else { st.fail++; st.lastError = String(err || '').slice(0, 200); }
  st.lastAt = new Date(); st.lastOk = !!ok; st.lastEvent = event || st.lastEvent;
  _stats.set(destId, st);
}
function getStats(destId) { return _stats.get(destId) || null; }

function sign(secret, timestamp, body) {
  return crypto.createHmac('sha256', String(secret)).update(String(timestamp) + '.' + body).digest('hex');
}

function _fbclidFromFbc(fbc) {
  const m = String(fbc || '').match(/^fb\.\d+\.\d+\.(.+)$/);
  return m ? m[1] : null;
}

function _scopeAllows(dest, scope) {
  if (!dest || dest.scope !== 'publishers') return true;
  const list = (dest.publishers || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);
  if (!list.length) return false;
  if (!scope) return false;
  const pub = String(scope.publisher || '').trim().toLowerCase();
  const code = String(scope.campaignCode || '').trim().toLowerCase();
  return (pub && list.includes(pub)) || (code && list.includes(code));
}

// Arma el body para un destino (respeta sus opcionales).
function buildPayload({ event, eventId, user, scope, opts, dest }) {
  const u = user || {};
  const o = opts || {};
  const body = {
    event,
    event_id: eventId,
    sent_at: new Date().toISOString(),
    site: _cfg.publicBaseUrl() || null,
    test: o.test === true,
    // Sin username (#344): el publicista identifica al jugador por `id` (UUID interno,
    // opaco y estable; el panel → Usuarios lo busca pegándolo en el buscador). Que no
    // sepa el usuario exacto de cada persona.
    user: {
      id: u.id || null,
      created_at: u.createdAt ? new Date(u.createdAt).toISOString() : null,
      campaign: scope && scope.campaignCode ? scope.campaignCode : (u.acquisitionCampaign || null),
      publisher: scope && scope.publisher ? scope.publisher : null,
      influencer: u.acquisitionInfluencer || null,
      // `source` = URL COMPLETA de origen (dominio + ruta + parámetros con la que entró el
      // jugador; la landing manda location.href). Lo pidió PulWin (#348) para asignar el
      // tráfico por dominio/ruta; antes iba 'landing'/'panel', que ahora es `channel`.
      source: u.landingUrl || null,
      channel: u.acquisitionSource || null
    },
    amount: o.amount != null ? Number(o.amount) : null,
    currency: o.amount != null ? 'ARS' : null,
    first_deposit: o.firstDeposit === true,
    transaction_id: o.transactionId || null,
    occurred_at: (o.occurredAt ? new Date(o.occurredAt) : new Date()).toISOString()
  };
  if (dest && dest.fields && dest.fields.atribucion) {
    const utm = u.acquisitionUtm && typeof u.acquisitionUtm === 'object' ? u.acquisitionUtm : {};
    body.attribution = {
      fbclid: _fbclidFromFbc(u.metaFbc),
      fbc: u.metaFbc || null,
      fbp: u.metaFbp || null,
      utm_source: utm.source || utm.utm_source || null,
      utm_medium: utm.medium || utm.utm_medium || null,
      utm_campaign: utm.campaign || utm.utm_campaign || null,
      utm_content: utm.content || utm.utm_content || null,
      utm_term: utm.term || utm.utm_term || null,
      landing_url: u.landingUrl || null,
      registration_ip: u.registrationIp || null
    };
  }
  if (dest && dest.fields && dest.fields.contacto) {
    body.contact = { email: u.email || null, phone: u.phone || null, phone_verified: u.phoneVerified === true };
  }
  return body;
}

async function _post(dest, payload) {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'vipcargas-webhook/1.0',
    'X-Webhook-Event': payload.event,
    'X-Webhook-Id': payload.event_id,
    'X-Webhook-Timestamp': ts,
    'X-Webhook-Signature': sign(dest.secret || '', ts, body)
  };
  // Modo de autenticación extra según lo que pide el receptor (#346; ver _normalizeOutboundDest).
  const auth = dest.auth || {};
  const secret = dest.secret || '';
  if (auth.mode === 'hmac_body') {
    const h = crypto.createHmac('sha256', String(secret)).update(body).digest('hex');
    headers[auth.header || 'X-Signature'] = (auth.prefix || '') + h;
  } else if (auth.mode === 'bearer') {
    headers['Authorization'] = 'Bearer ' + secret;
  } else if (auth.mode === 'header' && auth.header) {
    headers[auth.header] = (auth.prefix || '') + secret;
  }
  return _send(dest.url, body, headers);
}
async function _send(url, body, headers) {
  const resp = await axios.post(url, body, { headers, timeout: POST_TIMEOUT_MS, maxRedirects: 0, validateStatus: () => true });
  if (resp.status >= 200 && resp.status < 300) return { ok: true, status: resp.status };
  const retryable = resp.status >= 500 || resp.status === 408 || resp.status === 429;
  // Lo que respondió el receptor (recortado) para que el panel diga POR QUÉ rechazó
  // (401 "invalid signature" vs "missing token" cambia qué hay que arreglar).
  let detail = '';
  try {
    const d = resp.data;
    const txt = d == null ? '' : (typeof d === 'string' ? d : JSON.stringify(d));
    detail = txt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  } catch (_) {}
  return { ok: false, status: resp.status, retryable, error: `HTTP ${resp.status}${detail ? ': ' + detail : ''}` };
}

async function _deliver(dest, payload, attemptsSoFar) {
  let attempts = attemptsSoFar || 0;
  let lastErr = null;
  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    attempts++;
    try {
      const r = await _post(dest, payload);
      if (r.ok) { _stat(dest.id, true, null, payload.event); return { ok: true, attempts }; }
      lastErr = r.error;
      if (!r.retryable) { _stat(dest.id, false, lastErr, payload.event); return { ok: false, attempts, fatal: true, error: lastErr }; }
    } catch (e) {
      lastErr = e.code === 'ECONNABORTED' ? 'timeout' : e.message;
    }
    if (i < RETRY_DELAYS_MS.length - 1) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
  }
  _stat(dest.id, false, lastErr, payload.event);
  return { ok: false, attempts, fatal: false, error: lastErr };
}

async function _enqueue(dest, payload, attempts, lastError) {
  try {
    await OutboundWebhookQueue.create({ destId: dest.id, event: payload.event, eventId: payload.event_id, payload, attempts, lastError: String(lastError || '').slice(0, 200), nextRetryAt: new Date(Date.now() + QUEUE_RETRY_MS) });
  } catch (e) { logger.warn(`[webhooks] no se pudo encolar (${dest.name || dest.id}): ${e.message}`); }
}

async function _sendToDest(dest, payload) {
  const r = await _deliver(dest, payload, 0);
  if (r.ok) return;
  if (r.fatal) { logger.warn(`[webhooks] ${dest.name || dest.id}: ${payload.event} rechazado (${r.error}) — no se reintenta`); return; }
  logger.warn(`[webhooks] ${dest.name || dest.id}: ${payload.event} no entregado (${r.error}) — a la cola`);
  await _enqueue(dest, payload, r.attempts, r.error);
}

/**
 * Notifica un evento. `event`: 'registro' | 'carga' | 'retiro'. Para 'carga', opts.firstDeposit
 * decide si el destino lo recibe como 'primera_carga'. `user` = doc (o {id}) del usuario.
 * opts: { amount, firstDeposit, transactionId, occurredAt, campaignCode, publisher, test }.
 * Fire-and-forget: devuelve enseguida; todo corre en background.
 */
function notify(event, user, opts) {
  setImmediate(() => { _notify(event, user, opts).catch((e) => logger.warn(`[webhooks] notify ${event} falló: ${e.message}`)); });
}
async function _notify(event, user, opts) {
  const o = opts || {};
  let dests = [];
  try { dests = (await _cfg.getDestinations()) || []; } catch (e) { return; }
  dests = dests.filter((d) => d && d.enabled && d.url);
  if (!dests.length) return;
  let u = user;
  if (u && u.id && (!u.username || u.acquisitionCampaign === undefined)) {
    try {
      const User = require('../models/User');
      u = (await User.findOne({ id: String(u.id) }).select('id username createdAt acquisitionCampaign acquisitionInfluencer acquisitionSource lastTouchCampaign giroxOwnerCampaign acquisitionUtm metaFbc metaFbp landingUrl registrationIp email phone phoneVerified').lean()) || u;
    } catch (_) {}
  }
  if (!u) return;
  let scope = null;
  try { scope = await _cfg.resolveScope({ externalId: u.id }, { campaignCode: o.campaignCode, publisher: o.publisher }); } catch (_) {}
  const outEvent = event === 'carga' ? (o.firstDeposit ? 'primera_carga' : 'carga') : event;
  const baseId = o.eventKey || `${outEvent}_${u.id}_${o.transactionId || o.payoutId || (event === 'registro' ? 'reg' : Date.now())}`;
  for (const dest of dests) {
    const ev = dest.events || {};
    const wants = outEvent === 'primera_carga' ? (ev.primera_carga || ev.carga) : ev[outEvent];
    if (!wants) continue;
    if (!_scopeAllows(dest, scope)) continue;
    const payload = buildPayload({ event: outEvent, eventId: baseId, user: u, scope, opts: o, dest });
    _sendToDest(dest, payload).catch(() => {});
  }
}

/** Manda un aviso de PRUEBA a un destino (desde el panel). Devuelve el resultado del POST. */
async function sendTest(dest) {
  const payload = buildPayload({
    event: 'prueba', eventId: 'prueba_' + Date.now(),
    user: { id: 'prueba-0000-0000-0000-000000000000', createdAt: new Date(), acquisitionCampaign: 'PRUEBA', acquisitionSource: 'landing', landingUrl: (_cfg.publicBaseUrl() || 'https://ejemplo.com') + '/PRUEBA', email: 'prueba@ejemplo.com', phone: '+5491100000000', metaFbc: 'fb.1.1700000000000.AbCdEf', metaFbp: 'fb.1.1700000000000.123456' },
    scope: { publisher: 'Publicista de prueba', campaignCode: 'PRUEBA' },
    opts: { amount: 5000, firstDeposit: true, transactionId: 'tx_prueba', test: true }, dest
  });
  try {
    const r = await _post(dest, payload);
    _stat(dest.id, r.ok, r.error, 'prueba');
    return Object.assign({ payload }, r);
  } catch (e) {
    const err = e.code === 'ECONNABORTED' ? 'timeout' : e.message;
    _stat(dest.id, false, err, 'prueba');
    return { ok: false, error: err, payload };
  }
}

// Worker: reintenta lo encolado. Un item se descarta si pasó MAX_TOTAL_ATTEMPTS o si
// el destino ya no existe / está apagado.
async function processQueue() {
  let dests = [];
  try { dests = (await _cfg.getDestinations()) || []; } catch (_) { return; }
  const byId = new Map(dests.map((d) => [d.id, d]));
  let items = [];
  try { items = await OutboundWebhookQueue.find({ nextRetryAt: { $lte: new Date() } }).sort({ nextRetryAt: 1 }).limit(50).lean(); } catch (_) { return; }
  for (const it of items) {
    const dest = byId.get(it.destId);
    if (!dest || !dest.enabled || !dest.url || it.attempts >= MAX_TOTAL_ATTEMPTS) {
      await OutboundWebhookQueue.deleteOne({ _id: it._id }).catch(() => {});
      continue;
    }
    const r = await _deliver(dest, it.payload, it.attempts);
    if (r.ok || r.fatal) { await OutboundWebhookQueue.deleteOne({ _id: it._id }).catch(() => {}); continue; }
    await OutboundWebhookQueue.updateOne({ _id: it._id }, { $set: { attempts: r.attempts, lastError: String(r.error || '').slice(0, 200), nextRetryAt: new Date(Date.now() + QUEUE_RETRY_MS) } }).catch(() => {});
  }
}
let _worker = null;
function startWorker() {
  if (_worker) return;
  setTimeout(() => { processQueue().catch(() => {}); }, 60 * 1000);
  _worker = setInterval(() => { processQueue().catch(() => {}); }, QUEUE_RETRY_MS);
  if (_worker.unref) _worker.unref();
}
async function pendingCount(destId) {
  try { return await OutboundWebhookQueue.countDocuments(destId ? { destId } : {}); } catch (_) { return 0; }
}

module.exports = { EVENTS, configure, notify, sendTest, processQueue, startWorker, getStats, pendingCount, sign, buildPayload };
```

## 4) `src/services/metaCapiService.js` — agregar `resolveEventScope` y exportarlo

Pegar ANTES de `function isConfigured() {` (o al final del archivo, antes del `module.exports`) y
sumar `resolveEventScope` al `module.exports`. Si el repo NO tiene `metaCapiService`, crear
`src/services/eventScopeService.js` con este mismo bloque + `module.exports = { resolveEventScope }`
y en server.js usar ese módulo en el `configure` de la sección 5.1. Si el `User` del repo tiene
`lastTouchCampaign` (última campaña por la que volvió), queda primero en la prioridad; si no, se ignora.

```js
// ---- Resolución del "dueño" de un evento (publicista + campaña) — #197 (réplica
// del #334 del gemelo AUTOGIROXcompartido). Lo usan los WEBHOOKS SALIENTES para
// decidir qué destino recibe cada aviso. Lookup lazy (los modelos ya están
// registrados por el server) con cache corto para no pegarle a Mongo en cada
// evento. Orden para el usuario: campaña de alta → campaña dueña de la key.
// (`lastTouchCampaign` queda primero por compatibilidad con el gemelo: en este
// repo el campo no existe y el select lo ignora.)
const _campaignPubCache = new Map(); // code → { publisher, ts }
const CAMPAIGN_CACHE_MS = 5 * 60 * 1000;
async function _publisherOfCampaign(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  const hit = _campaignPubCache.get(c);
  if (hit && Date.now() - hit.ts < CAMPAIGN_CACHE_MS) return hit.publisher;
  let publisher = null;
  try {
    const Campaign = require('../models/Campaign');
    const doc = await Campaign.findOne({ code: c }).select('publisher').lean();
    publisher = doc && doc.publisher ? String(doc.publisher) : null;
  } catch (_) {}
  _campaignPubCache.set(c, { publisher, ts: Date.now() });
  return publisher;
}
// Devuelve { publisher, campaignCode } o null. Acepta opts.publisher /
// opts.campaignCode explícitos (evita el lookup) o resuelve por el usuario
// (`userInfo.externalId` = User.id).
async function resolveEventScope(userInfo, opts) {
  const o = opts || {};
  if (o.publisher || o.campaignCode) {
    const publisher = o.publisher || await _publisherOfCampaign(o.campaignCode);
    return { publisher: publisher || null, campaignCode: o.campaignCode || null };
  }
  const userId = userInfo && userInfo.externalId != null ? String(userInfo.externalId) : null;
  if (!userId) return null;
  try {
    const User = require('../models/User');
    const u = await User.findOne({ id: userId }).select('lastTouchCampaign acquisitionCampaign giroxOwnerCampaign').lean();
    if (!u) return null;
    const code = u.lastTouchCampaign || u.acquisitionCampaign || u.giroxOwnerCampaign || null;
    if (!code) return null;
    return { publisher: await _publisherOfCampaign(code), campaignCode: code };
  } catch (_) { return null; }
}

```

---

## 5) `server.js`

### 5.0 (solo si faltan) helpers de cifrado `_credKey / _credEncrypt / _credDecrypt`

Van cerca del resto de helpers de nivel superior (antes de usarse). Clave = sha256(JWT_SECRET + sal).
Si el repo ya los tiene (feature de credenciales hgcash desde el panel), NO duplicarlos.

```js
function _credKey() {
  const base = process.env.JWT_SECRET || JWT_SECRET || '';
  if (!base) return null;
  return crypto.createHash('sha256').update(base + ':hgcash-credentials:v1').digest();
}
function _credEncrypt(plain) {
  const key = _credKey(); if (!key) throw new Error('JWT_SECRET no disponible para cifrar');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
function _credDecrypt(blob) {
  const key = _credKey(); if (!key || !blob) return null;
  const [iv, tag, data] = String(blob).split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
```

### 5.1 Requires + `configure` — ANCLA: la línea `const fbAdsWebhook = require(...)` (o el último require de servicios). Pegar DESPUÉS.

`_getOutboundWebhooks` y `getPublicBaseUrl` se usan dentro de arrow functions, así que pueden estar
definidos más abajo (no hay TDZ). `metaCapi` tiene que estar requerido antes de este bloque.

```js
// #197 (réplica del #334 del gemelo AUTOGIROXcompartido): webhooks SALIENTES
// configurables desde el panel (registro / primera carga / carga / retiro) a uno,
// varios o todos los publicistas. En PARALELO al pixel de Meta y a fb-ads.
const outboundWebhook = require('./src/services/outboundWebhookService');
const OutboundWebhookQueue = require('./src/models/OutboundWebhookQueue');
outboundWebhook.configure({
  getDestinations: () => _getOutboundWebhooks(),
  resolveScope: (userInfo, opts) => metaCapi.resolveEventScope(userInfo, opts),
  publicBaseUrl: () => getPublicBaseUrl()
});
```

### 5.2 `_isFirstDeposit` — helper de nivel superior (junto a otros helpers, después de que `Transaction` y `logger` existan)

```js
// ¿Es la PRIMERA carga real del cliente (FTD)? Se llama DESPUÉS de crear el
// Transaction del depósito, así que la primera carga = exactamente 1 depósito
// real. Excluye devoluciones de retiro (payout_refund), que no son cargas
// genuinas. Lo usan los webhooks salientes (#197): el destino recibe 'carga' con
// firstDeposit como 'primera_carga'. `opts.unrecorded` = el flujo que llama NO
// escribe Transaction (self-service): entonces FTD = ningún depósito previo.
// Ante error → false (no marcar FTD de más).
async function _isFirstDeposit(userId, opts) {
  try {
    const n = await Transaction.countDocuments({
      userId: String(userId),
      type: 'deposit',
      'metadata.source': { $ne: 'payout_refund' }
    });
    return opts && opts.unrecorded ? n === 0 : n === 1;
  } catch (e) {
    logger.warn(`[webhooks] _isFirstDeposit falló: ${e.message}`);
    return false;
  }
}
```

### 5.3 Config de destinos — ANCLA: pegar junto a los helpers de hgcash fan-out / credenciales (donde ya están `_credEncrypt`/`_credDecrypt`), ANTES de las rutas

```js
// ===== #197 Webhooks salientes (Config['outboundWebhooks']) — réplica del #334/#346 del gemelo =====
// Lista de destinos; el secreto se guarda cifrado (misma clave que las credenciales
// de hgcash, #192: _credEncrypt/_credDecrypt) y se descifra sólo en memoria para firmar.
const OUTBOUND_WEBHOOKS_KEY = 'outboundWebhooks';
const OUTBOUND_WEBHOOKS_MAX = 10;
const OUTBOUND_WEBHOOKS_TTL_MS = 60 * 1000;
let _outboundWebhooksCache = null;
function _normalizeOutboundDest(d, cur) {
  const c = cur || {};
  const events = d.events && typeof d.events === 'object' ? d.events : (c.events || {});
  const fields = d.fields && typeof d.fields === 'object' ? d.fields : (c.fields || {});
  const url = d.url !== undefined ? String(d.url || '').trim() : (c.url || '');
  return {
    id: c.id || d.id || ('wh_' + crypto.randomBytes(5).toString('hex')),
    name: d.name !== undefined ? String(d.name || '').trim().slice(0, 60) : (c.name || ''),
    url,
    secretEnc: (typeof d.secret === 'string' && d.secret.trim()) ? _credEncrypt(d.secret.trim()) : (c.secretEnc || null),
    enabled: typeof d.enabled === 'boolean' ? d.enabled : (c.enabled !== false),
    scope: d.scope === 'publishers' ? 'publishers' : (d.scope === 'all' ? 'all' : (c.scope || 'all')),
    publishers: Array.isArray(d.publishers) ? d.publishers.map((p) => String(p || '').trim()).filter(Boolean).slice(0, 50) : (c.publishers || []),
    events: {
      registro: events.registro !== false,           // siempre por defecto
      primera_carga: events.primera_carga !== false, // siempre por defecto
      carga: events.carga === true,                  // OPCIONAL
      retiro: events.retiro === true                 // OPCIONAL
    },
    fields: { atribucion: fields.atribucion === true, contacto: fields.contacto === true }, // OPCIONALES
    // Cómo se autentica el aviso ante el receptor. Siempre van los headers
    // X-Webhook-*; `auth` agrega lo que pide cada plataforma:
    //   hmac_ts   (default) X-Webhook-Signature = HMAC(ts.body)  — nuestro esquema
    //   hmac_body <header> = <prefix>HMAC-SHA256 hex del body solo (estilo GitHub/Shopify)
    //   bearer    Authorization: Bearer <secreto>
    //   header    <header>: <secreto>  (API key fija)
    auth: (() => {
      const a = d.auth && typeof d.auth === 'object' ? d.auth : (c.auth || {});
      const mode = ['hmac_ts', 'hmac_body', 'bearer', 'header'].includes(a.mode) ? a.mode : 'hmac_ts';
      const header = String(a.header || '').trim().replace(/[^A-Za-z0-9-]/g, '').slice(0, 60);
      const prefix = String(a.prefix || '').trim().slice(0, 20);
      return { mode, header: header || null, prefix: prefix || null };
    })(),
    createdAt: c.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}
async function _getOutboundWebhooks(opts) {
  const now = Date.now();
  if (!(opts && opts.fresh) && _outboundWebhooksCache && (now - _outboundWebhooksCache.at) < OUTBOUND_WEBHOOKS_TTL_MS) return _outboundWebhooksCache.value;
  const raw = await getConfig(OUTBOUND_WEBHOOKS_KEY, null);
  const list = raw && Array.isArray(raw.destinations) ? raw.destinations : [];
  const value = list.map((d) => {
    let secret = null, decryptError = false;
    if (d.secretEnc) { try { secret = _credDecrypt(d.secretEnc); } catch (_) { decryptError = true; } }
    return Object.assign({}, d, { secret, decryptError });
  });
  _outboundWebhooksCache = { at: now, value };
  return value;
}
async function _saveOutboundWebhooks(list, by) {
  const clean = list.map((d) => { const o = Object.assign({}, d); delete o.secret; delete o.decryptError; return o; });
  await Config.set(OUTBOUND_WEBHOOKS_KEY, { destinations: clean }, by);
  _outboundWebhooksCache = null;
}
function _outboundDestPublic(d, stats, pending) {
  const o = Object.assign({}, d);
  delete o.secretEnc; delete o.secret;
  o.hasSecret = !!d.secretEnc;
  o.stats = stats || null;
  o.pending = pending || 0;
  return o;
}

```

### 5.4 Rutas del panel — ANCLA: después de `const authMiddleware` y al lado de los endpoints `/api/admin/hgcash/*` (o de cualquier ruta admin). Solo admin general.

```js
// #197 Webhooks salientes — CRUD desde el panel (solo admin general).
app.get('/api/admin/webhooks', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin general' });
    const list = await _getOutboundWebhooks({ fresh: true });
    const out = [];
    for (const d of list) out.push(_outboundDestPublic(d, outboundWebhook.getStats(d.id), await outboundWebhook.pendingCount(d.id)));
    let publishers = [];
    try { publishers = (await Campaign.distinct('publisher')).map((p) => String(p || '').trim()).filter(Boolean).sort(); } catch (_) {}
    res.json({ destinations: out, publishers, max: OUTBOUND_WEBHOOKS_MAX });
  } catch (e) { res.status(500).json({ error: 'Error del servidor' }); }
});
app.post('/api/admin/webhooks', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin general' });
    if (!_credKey()) return res.status(503).json({ error: 'No se puede cifrar ahora (falta JWT_SECRET).' });
    const b = req.body || {};
    const list = await _getOutboundWebhooks({ fresh: true });
    const idx = b.id ? list.findIndex((d) => d.id === b.id) : -1;
    const cur = idx >= 0 ? list[idx] : null;
    if (!cur && list.length >= OUTBOUND_WEBHOOKS_MAX) return res.status(400).json({ error: `Máximo ${OUTBOUND_WEBHOOKS_MAX} destinos` });
    const next = _normalizeOutboundDest(b, cur);
    if (!/^https:\/\/[^\s]+$/i.test(next.url)) return res.status(400).json({ error: 'La URL tiene que empezar con https://' });
    if (!next.name) return res.status(400).json({ error: 'Poné un nombre (ej: el publicista o el sistema que recibe)' });
    if (!next.secretEnc) return res.status(400).json({ error: 'Falta el secreto: con él el receptor comprueba que el aviso es tuyo' });
    if (next.scope === 'publishers' && !next.publishers.length) return res.status(400).json({ error: 'Elegí al menos un publicista, o marcá TODOS' });
    if (idx >= 0) list[idx] = next; else list.push(next);
    await _saveOutboundWebhooks(list, req.user.username);
    logger.info(`[webhooks] ${req.user.username} ${cur ? 'editó' : 'creó'} destino ${next.name} (${next.id}) scope=${next.scope}`);
    res.json({ success: true, destination: _outboundDestPublic(next) });
  } catch (e) { logger.error(`[webhooks] guardar: ${e.message}`); res.status(500).json({ error: 'Error del servidor' }); }
});
app.delete('/api/admin/webhooks/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin general' });
    const list = await _getOutboundWebhooks({ fresh: true });
    const next = list.filter((d) => d.id !== req.params.id);
    if (next.length === list.length) return res.status(404).json({ error: 'No existe' });
    await _saveOutboundWebhooks(next, req.user.username);
    try { await OutboundWebhookQueue.deleteMany({ destId: req.params.id }); } catch (_) {}
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Error del servidor' }); }
});
app.post('/api/admin/webhooks/:id/test', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin general' });
    const list = await _getOutboundWebhooks({ fresh: true });
    const d = list.find((x) => x.id === req.params.id);
    if (!d) return res.status(404).json({ error: 'No existe' });
    if (d.decryptError) return res.status(400).json({ error: 'El secreto guardado no se pudo leer (¿cambió JWT_SECRET?). Volvé a cargarlo.' });
    const r = await outboundWebhook.sendTest(d);
    res.json({ ok: r.ok, status: r.status || null, error: r.error || null, payload: r.payload });
  } catch (e) { res.status(500).json({ error: 'Error del servidor' }); }
});

```

### 5.5 Worker — ANCLA: cada `fbAdsWebhook.startWorker();` (suele haber 2: rama Vercel y arranque normal). Pegar DEBAJO.

```js
    outboundWebhook.startWorker(); // cola de webhooks salientes
```

---

## 6) Hooks (fire-and-forget) — buscar TODOS los flujos y agregar la línea al lado del `fbAdsWebhook.notify` o del `metaCapi.track`

| Flujo | ANCLA típica | Línea a agregar |
|---|---|---|
| Registro normal, registro rápido por pauta, alta por landing (3 lugares) | `fbAdsWebhook.notify('CompleteRegistration', newUser);` | `try { outboundWebhook.notify('registro', newUser); } catch (_) {}` |
| Carga manual del agente (`POST /api/admin/deposit`), DESPUÉS de crear la Transaction del depósito | `fbAdsWebhook.notify('Purchase', user, ...)` | (A) |
| Auto-carga por banco (`hgcashAutoCarga` / GH Wallet), tras `Transaction.create` y antes del `_emitHgcashUpdate('cargado', ...)` | `_emitHgcashUpdate('cargado', movement.movementId);` | (B) |
| Depósito self-service (`POST /api/movements/deposit`) si existe | `fbAdsWebhook.notify('Purchase', u, ...)` | (C) |
| Retiro pagado | primera línea de `async function notifyPayoutPaid(payout) {` | (D) |

```js
// (A) carga manual — _depTxId = uuid que se usó como reference vip-dep-<id> y Transaction.id
      try {
        const _isFTD = await _isFirstDeposit(user.id);
        outboundWebhook.notify('carga', user, { amount: parseFloat(amount), firstDeposit: _isFTD, transactionId: _depTxId });
      } catch (_) {}

// (B) auto-carga banco — txId = Transaction.id de la acreditación
    try {
      const _hgFTD = await _isFirstDeposit(user.id);
      outboundWebhook.notify('carga', user, { amount: Number(amount), firstDeposit: _hgFTD, transactionId: txId });
    } catch (_) {}

// (C) self-service — SOLO si ese flujo NO escribe Transaction (entonces FTD = sin depósitos previos).
//     Si escribe Transaction, usar _isFirstDeposit(id) sin opts como en (A).
        const _isFTD = await _isFirstDeposit(req.user.userId, { unrecorded: true });
        outboundWebhook.notify('carga', u, { amount: parseFloat(amount), firstDeposit: _isFTD, transactionId: _selfDepTxId });

// (D) retiro pagado
  try { if (payout && payout.userId) outboundWebhook.notify('retiro', { id: payout.userId }, { amount: Number(payout.amount), payoutId: payout.id, occurredAt: payout.paidAt || new Date() }); } catch (_) {}
```

Reglas: `firstDeposit:true` hace que el destino lo reciba como `primera_carga`. `transactionId` /
`payoutId` arman el `event_id` estable (`<evento>_<userId>_<txId>`): si falta, se usa `Date.now()` y
el receptor no puede deduplicar reintentos. `user` puede ser el doc completo o `{ id }` (el
servicio completa los campos con un `findOne`). Un flujo de registro o carga NUEVO que se agregue
después también tiene que llamar al hook.

---

## 7) Panel — `public/adminprivado2026/index.html` (dentro de la sección Configuración, al lado de las otras cards `cbu-form`)

```html
                        <!-- #197 WEBHOOKS SALIENTES (réplica del #334/#346 del gemelo): registro / primera carga / carga / retiro a publicistas (solo admin general) -->
                        <div class="panel-subheader" style="margin-top: 24px;" id="webhooksHeader">
                            <h3>🔗 Webhooks salientes (avisos a publicistas)</h3>
                        </div>
                        <div class="cbu-form" id="webhooksForm">
                            <p style="color:#aaa;font-size:12px;line-height:1.5;margin:0 0 10px;">
                                Además del pixel (que sigue igual, en paralelo), el sistema puede avisar por <b>webhook</b> (un POST con JSON firmado)
                                cada <b>registro</b> y <b>primera carga</b>, y si lo marcás, también cada <b>carga</b> y cada <b>retiro</b>. Cada destino
                                recibe solo lo de <b>sus publicistas</b> o de <b>todos</b>, y vos elegís por destino si van los datos de atribución
                                (fbclid / UTM) y el mail/teléfono. Si el receptor está caído se reintenta solo (hasta 10 veces, cada 5 min).
                            </p>
                            <div id="webhooksList" style="display:grid;gap:8px;margin-bottom:12px;">Cargando…</div>
                            <button type="button" class="btn-primary btn-small" onclick="webhookEdit()">+ Nuevo destino</button>
                            <div id="webhookEditor" style="display:none;margin-top:12px;padding:12px;border:1px solid rgba(212,175,55,0.35);border-radius:10px;background:rgba(255,255,255,0.03);">
                                <input type="hidden" id="whId">
                                <div style="display:flex;gap:10px;flex-wrap:wrap;">
                                    <div class="form-group" style="flex:1;min-width:200px;">
                                        <label>Nombre (para vos):</label>
                                        <input type="text" id="whName" placeholder="Ej: Publicista Juan / CRM propio" style="width:100%;">
                                    </div>
                                    <div class="form-group" style="flex:2;min-width:260px;">
                                        <label>URL que recibe (https):</label>
                                        <input type="text" id="whUrl" placeholder="https://..." style="width:100%;">
                                    </div>
                                </div>
                                <div class="form-group">
                                    <label>Secreto (lo compartís con quien recibe; firma cada aviso):</label>
                                    <input type="password" id="whSecret" placeholder="Dejá vacío para no cambiarlo" style="width:100%;" autocomplete="new-password">
                                    <small style="color:#aaa;font-size:11px;">Se guarda cifrado y no se vuelve a mostrar. <a href="#" onclick="webhookGenSecret();return false;" style="color:#d4af37;">Generar uno al azar</a></small>
                                </div>
                                <div class="form-group" id="whAuthBox">
                                    <label>Cómo se autentica el aviso (lo que pida la plataforma que recibe):</label>
                                    <select id="whAuthMode" style="width:100%;" onchange="webhookAuthChanged()">
                                        <option value="hmac_ts">Firma HMAC de "{timestamp}.{body}" en X-Webhook-Signature (nuestro formato, default)</option>
                                        <option value="hmac_body">Firma HMAC-SHA256 del body solo, en un header a elección (estilo GitHub / Shopify)</option>
                                        <option value="bearer">Token fijo: Authorization: Bearer &lt;secreto&gt;</option>
                                        <option value="header">Token fijo en un header a elección (API key)</option>
                                    </select>
                                    <div id="whAuthExtra" style="display:none;gap:12px;flex-wrap:wrap;margin-top:8px;">
                                        <div style="flex:1;min-width:200px;"><label style="font-size:12px;">Nombre del header</label><input type="text" id="whAuthHeader" placeholder="ej. X-Signature o X-Api-Key" style="width:100%;"></div>
                                        <div style="flex:1;min-width:160px;"><label style="font-size:12px;">Prefijo del valor (opcional)</label><input type="text" id="whAuthPrefix" placeholder="ej. sha256=" style="width:100%;"></div>
                                    </div>
                                    <small style="color:#aaa;font-size:11px;">Si el receptor responde 401 "firma inválida" aunque ya cargó el secreto, es que calcula la firma de otra forma: pedile cómo (header y qué firma) y elegilo acá. Los headers X-Webhook-* van siempre, además.</small>
                                </div>
                                <div style="display:flex;gap:12px;flex-wrap:wrap;">
                                    <div style="flex:1;min-width:240px;">
                                        <div style="font-weight:bold;font-size:13px;margin-bottom:6px;">👥 Recibe los eventos de</div>
                                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;margin:4px 0;"><input type="radio" name="whScope" value="all" style="width:auto;" onchange="webhookScopeChanged()"> <b>TODOS</b> los usuarios (también orgánicos)</label>
                                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;margin:4px 0;"><input type="radio" name="whScope" value="publishers" style="width:auto;" onchange="webhookScopeChanged()"> Solo estos publicistas:</label>
                                        <div id="whPublishers" style="margin-left:24px;display:grid;gap:2px;max-height:160px;overflow:auto;font-size:12px;"></div>
                                        <small style="color:#aaa;font-size:11px;display:block;margin-left:24px;margin-top:4px;">Un usuario pertenece al publicista de la campaña por la que entró.</small>
                                    </div>
                                    <div style="flex:1;min-width:240px;">
                                        <div style="font-weight:bold;font-size:13px;margin-bottom:6px;">📨 Qué avisos manda</div>
                                        <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:4px 0;color:#aaa;"><input type="checkbox" checked disabled style="width:auto;"> Registro (siempre)</label>
                                        <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin:4px 0;color:#aaa;"><input type="checkbox" checked disabled style="width:auto;"> Primera carga (siempre)</label>
                                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;margin:4px 0;"><input type="checkbox" id="whEvCarga" style="width:auto;"> Todas las cargas (opcional)</label>
                                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;margin:4px 0;"><input type="checkbox" id="whEvRetiro" style="width:auto;"> Retiros pagados (opcional)</label>
                                        <div style="font-weight:bold;font-size:13px;margin:10px 0 6px;">🧩 Datos extra (opcionales)</div>
                                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;margin:4px 0;"><input type="checkbox" id="whFAtrib" style="width:auto;"> Atribución (fbclid, _fbc/_fbp, UTM, landing, IP)</label>
                                        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;margin:4px 0;"><input type="checkbox" id="whFContacto" style="width:auto;"> Mail y teléfono del usuario</label>
                                    </div>
                                </div>
                                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;margin:10px 0;"><input type="checkbox" id="whEnabled" checked style="width:auto;"> Destino activo</label>
                                <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
                                    <button type="button" class="btn-primary" onclick="webhookSave()">💾 Guardar destino</button>
                                    <button type="button" class="btn-secondary" onclick="webhookCancel()">Cancelar</button>
                                    <span id="whMsg" style="font-size:12px;color:#aaa;"></span>
                                </div>
                            </div>
                            <details style="margin-top:12px;font-size:12px;color:#aaa;">
                                <summary style="cursor:pointer;color:#d4af37;">📄 Formato completo (TODO lo que el sistema puede mandar — uso interno)</summary>
                                <div style="margin-top:6px;color:#ffb74d;">⚠️ No le pases este bloque al publicista: lista también lo que NO le mandás (teléfono, atribución, retiros…). Usá el botón <b>📋 Copiar formato para pasarle</b> del destino: arma el texto solo con lo que ese destino recibe.</div>
                                <pre style="white-space:pre-wrap;background:rgba(0,0,0,0.35);padding:10px;border-radius:8px;font-size:11px;line-height:1.45;margin-top:8px;">POST {URL}   Content-Type: application/json
Headers: X-Webhook-Event (registro | primera_carga | carga | retiro | prueba)
         X-Webhook-Id (único por evento: si se repite, ignorar)
         X-Webhook-Timestamp (unix, segundos)
         X-Webhook-Signature = HMAC-SHA256 hex de "{timestamp}.{body}" con el secreto
Body: { "event", "event_id", "sent_at", "site", "test",
        "user": { "id", "created_at", "campaign", "publisher", "influencer", "source", "channel" },   (id = UUID interno, NUNCA va el username; source = URL completa de origen; channel = landing | panel…)
        "amount", "currency", "first_deposit", "transaction_id", "occurred_at",
        "attribution": { "fbclid", "fbc", "fbp", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "landing_url", "registration_ip" },   (si está marcado)
        "contact": { "email", "phone", "phone_verified" } }   (si está marcado)
Responder 2xx. Con 5xx / timeout se reintenta; con 4xx no.</pre>
                            </details>
                        </div>

```

## 8) Panel — `public/adminprivado2026/admin.js`

Pegar el bloque completo a nivel superior (por ejemplo después de la función de login) y agregar
`loadWebhooksCard();` donde se cargan las demás cards de Configuración (junto a `loadBonusRolloverCfg()`
o equivalente). Después, bump de `CACHE_VERSION` en `public/admin-sw.js`.

```js
// ====== #197 WEBHOOKS SALIENTES (réplica del #334/#346 del gemelo; Configuración, solo admin general) ======
let _whDests = [];
let _whPublishers = [];
function _whEvTxt(d) {
    const ev = d.events || {}; const out = ['registro', 'primera carga'];
    if (ev.carga) out.push('cargas'); if (ev.retiro) out.push('retiros');
    return out.join(' · ');
}
// Texto del formato SOLO con lo que ese destino recibe (eventos y campos marcados): es lo
// que se le pasa al publicista. El bloque genérico de la card lista TODO lo posible y no
// se comparte (si el publicista ve que podemos mandar teléfono/atribución, lo pide).
function _whFormatText(d) {
    const ev = d.events || {}; const f = d.fields || {};
    const events = ['registro', 'primera_carga']; if (ev.carga) events.push('carga'); if (ev.retiro) events.push('retiro'); events.push('prueba');
    const lines = [];
    lines.push('WEBHOOK — ' + (d.name || '') + '\nURL: ' + d.url + '\n');
    lines.push('Cada aviso es un POST con JSON (Content-Type: application/json).');
    lines.push('Eventos: ' + events.join(' | ') + ' (el "prueba" es solo para verificar la recepcion).\n');
    const au = d.auth || {}; const am = au.mode || 'hmac_ts';
    lines.push('Headers:');
    lines.push('  X-Webhook-Event      tipo de evento');
    lines.push('  X-Webhook-Id         id unico del evento (si se repite, es un reintento: ignorar)');
    lines.push('  X-Webhook-Timestamp  unix time en segundos');
    lines.push('  X-Webhook-Signature  HMAC-SHA256 hex de "{timestamp}.{body crudo}" con el secreto compartido');
    if (am === 'hmac_body') lines.push('  ' + (au.header || 'X-Signature') + '  ' + (au.prefix || '') + 'HMAC-SHA256 hex del body crudo con el secreto compartido');
    if (am === 'bearer') lines.push('  Authorization        Bearer <token acordado>');
    if (am === 'header' && au.header) lines.push('  ' + au.header + '  ' + (au.prefix || '') + '<token acordado>');
    lines.push('');
    if (am === 'hmac_ts') {
        lines.push('Validacion: tomar el body tal cual llega (sin reformatear), armar timestamp + "." + body,');
        lines.push('calcular HMAC-SHA256 con el secreto y comparar con X-Webhook-Signature. Rechazar si el');
        lines.push('timestamp tiene mas de 5 minutos.\n');
    } else if (am === 'hmac_body') {
        lines.push('Validacion: HMAC-SHA256 del body crudo con el secreto, comparar con el header ' + (au.header || 'X-Signature') + '.\n');
    } else {
        lines.push('Validacion: comparar el token del header con el acordado.\n');
    }
    lines.push('Body:');
    lines.push('  event, event_id, sent_at, site, test');
    lines.push('  user: { id, created_at, campaign, publisher, influencer, source, channel }');
    lines.push('    id = identificador unico y estable del jugador; source = URL completa de origen (dominio, ruta y parametros) con la que entro el jugador');
    lines.push('  (en primera_carga' + (ev.carga ? ' / carga' : '') + (ev.retiro ? ' / retiro' : '') + ') amount, currency, first_deposit, transaction_id, occurred_at');
    if (f.atribucion) lines.push('  attribution: { fbclid, fbc, fbp, utm_source, utm_medium, utm_campaign, utm_content, utm_term, landing_url, registration_ip }');
    if (f.contacto) lines.push('  contact: { email, phone, phone_verified }');
    lines.push('\nResponder 2xx. Con 5xx o timeout se reintenta (hasta 10 veces); con 4xx no se reintenta.');
    return lines.join('\n');
}
async function webhookCopyFormat(id) {
    const d = _whDests.find(function (x) { return x.id === id; }); if (!d) return;
    const txt = _whFormatText(d);
    try { await navigator.clipboard.writeText(txt); showToast('📋 Formato copiado: solo lo que recibe ' + (d.name || 'ese destino'), 'success'); }
    catch (_) { window.prompt('Copiá el formato:', txt); }
}
function _whRenderList() {
    const box = document.getElementById('webhooksList'); if (!box) return;
    if (!_whDests.length) { box.innerHTML = '<span style="color:#aaa;font-size:12px;">Todavía no hay destinos. Agregá uno con "+ Nuevo destino".</span>'; return; }
    box.innerHTML = _whDests.map(function (d) {
        const st = d.stats;
        const scope = d.scope === 'publishers' ? '👥 ' + escapeHtml((d.publishers || []).join(', ')) : '👥 <b>TODOS</b>';
        const extra = [d.fields && d.fields.atribucion ? 'atribución' : null, d.fields && d.fields.contacto ? 'mail/tel' : null].filter(Boolean).join(' + ');
        const am = (d.auth && d.auth.mode) || 'hmac_ts';
        const authTxt = am === 'hmac_body' ? '🔑 HMAC del body en ' + escapeHtml((d.auth.header || 'X-Signature')) : am === 'bearer' ? '🔑 Bearer' : am === 'header' ? '🔑 token en ' + escapeHtml(d.auth.header || '?') : '';
        let last = '';
        if (st && st.lastAt) last = (st.lastOk ? '<span style="color:#66ff99;">✅ último OK</span>' : '<span style="color:#ff8080;">❌ ' + escapeHtml(st.lastError || 'falló') + '</span>') + ' (' + escapeHtml(st.lastEvent || '') + ', ' + fmtFechaHoraAR(st.lastAt) + ') · ' + st.ok + ' ok / ' + st.fail + ' fallos desde el arranque';
        if (d.pending) last += ' · <span style="color:#ffb74d;">' + d.pending + ' en cola</span>';
        if (d.decryptError) last += ' · <span style="color:#ff8080;">⚠️ secreto ilegible (¿cambió JWT_SECRET?): volvé a cargarlo</span>';
        return '<div style="padding:10px;border-radius:8px;background:rgba(255,255,255,0.04);border-left:4px solid ' + (d.enabled ? '#66ff99' : '#777') + ';font-size:12px;line-height:1.6;">' +
            '<div><b>' + escapeHtml(d.name || '(sin nombre)') + '</b> ' + (d.enabled ? '' : '<span style="color:#aaa;">(apagado)</span>') + ' · <code style="font-size:11px;">' + escapeHtml(d.url) + '</code></div>' +
            '<div>' + scope + ' · 📨 ' + _whEvTxt(d) + (extra ? ' · 🧩 ' + extra : '') + (authTxt ? ' · ' + authTxt : '') + '</div>' +
            (last ? '<div style="color:#aaa;">' + last + '</div>' : '') +
            '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">' +
            '<button type="button" class="btn-secondary btn-small" onclick="webhookEdit(\'' + d.id + '\')">✏️ Editar</button>' +
            '<button type="button" class="btn-secondary btn-small" onclick="webhookTest(\'' + d.id + '\')">📤 Enviar prueba</button>' +
            '<button type="button" class="btn-secondary btn-small" onclick="webhookCopyFormat(\'' + d.id + '\')" title="Copia el formato con SOLO los eventos y campos marcados para este destino">📋 Copiar formato para pasarle</button>' +
            '<button type="button" class="btn-secondary btn-small" onclick="webhookDelete(\'' + d.id + '\')" style="color:#ff8080;">🗑 Borrar</button>' +
            '</div></div>';
    }).join('');
}
async function loadWebhooksCard() {
    const form = document.getElementById('webhooksForm'); const header = document.getElementById('webhooksHeader');
    try {
        const r = await authFetch('/api/admin/webhooks');
        if (!r.ok) { if (form) form.style.display = 'none'; if (header) header.style.display = 'none'; return; }
        if (form) form.style.display = ''; if (header) header.style.display = '';
        const j = await r.json();
        _whDests = j.destinations || []; _whPublishers = j.publishers || [];
        _whRenderList();
    } catch (_) {}
}
function _whRenderPublishers(selected) {
    const box = document.getElementById('whPublishers'); if (!box) return;
    const sel = (selected || []).map(function (x) { return String(x).toLowerCase(); });
    if (!_whPublishers.length) { box.innerHTML = '<span style="color:#aaa;">No hay campañas con publicista todavía (creá una en PUBLICISTAS Y PAUTAS).</span>'; return; }
    box.innerHTML = _whPublishers.map(function (pub) {
        return '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" class="whPub" value="' + escapeHtml(pub) + '" style="width:auto;"' + (sel.indexOf(pub.toLowerCase()) >= 0 ? ' checked' : '') + '> ' + escapeHtml(pub) + '</label>';
    }).join('');
}
function webhookScopeChanged() {
    const pubs = document.querySelector('input[name="whScope"]:checked');
    const box = document.getElementById('whPublishers');
    if (box) box.style.opacity = pubs && pubs.value === 'publishers' ? '1' : '0.45';
}
function webhookEdit(id) {
    const d = id ? _whDests.find(function (x) { return x.id === id; }) : null;
    const ed = document.getElementById('webhookEditor'); if (!ed) return;
    document.getElementById('whId').value = d ? d.id : '';
    document.getElementById('whName').value = d ? (d.name || '') : '';
    document.getElementById('whUrl').value = d ? (d.url || '') : '';
    document.getElementById('whSecret').value = '';
    document.getElementById('whSecret').placeholder = d && d.hasSecret ? 'Dejá vacío para no cambiarlo' : 'Pegá o generá un secreto';
    const scope = d ? (d.scope || 'all') : 'all';
    const rb = document.querySelector('input[name="whScope"][value="' + scope + '"]'); if (rb) rb.checked = true;
    _whRenderPublishers(d ? d.publishers : []);
    webhookScopeChanged();
    document.getElementById('whEvCarga').checked = !!(d && d.events && d.events.carga);
    document.getElementById('whEvRetiro').checked = !!(d && d.events && d.events.retiro);
    document.getElementById('whFAtrib').checked = !!(d && d.fields && d.fields.atribucion);
    document.getElementById('whFContacto').checked = !!(d && d.fields && d.fields.contacto);
    document.getElementById('whEnabled').checked = d ? d.enabled !== false : true;
    const au = (d && d.auth) || {};
    document.getElementById('whAuthMode').value = au.mode || 'hmac_ts';
    document.getElementById('whAuthHeader').value = au.header || '';
    document.getElementById('whAuthPrefix').value = au.prefix || '';
    webhookAuthChanged();
    const m = document.getElementById('whMsg'); if (m) m.textContent = '';
    ed.style.display = '';
    ed.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function webhookAuthChanged() {
    const mode = document.getElementById('whAuthMode').value;
    const extra = document.getElementById('whAuthExtra'); if (!extra) return;
    const show = mode === 'hmac_body' || mode === 'header';
    extra.style.display = show ? 'flex' : 'none';
    const pr = document.getElementById('whAuthPrefix'); if (pr) pr.placeholder = mode === 'header' ? 'ej. Bearer ' : 'ej. sha256=';
}
function webhookCancel() { const ed = document.getElementById('webhookEditor'); if (ed) ed.style.display = 'none'; }
function webhookGenSecret() {
    const a = new Uint8Array(24); (window.crypto || window.msCrypto).getRandomValues(a);
    const hex = Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    const el = document.getElementById('whSecret'); el.type = 'text'; el.value = 'whsec_' + hex;
    showToast('Secreto generado: copialo AHORA y pasáselo a quien recibe (no se vuelve a mostrar)', 'success');
}
async function webhookSave() {
    const m = document.getElementById('whMsg');
    const scope = (document.querySelector('input[name="whScope"]:checked') || {}).value || 'all';
    const publishers = Array.prototype.map.call(document.querySelectorAll('.whPub:checked'), function (c) { return c.value; });
    const body = {
        id: document.getElementById('whId').value || undefined,
        name: document.getElementById('whName').value, url: document.getElementById('whUrl').value.trim(),
        secret: document.getElementById('whSecret').value, scope, publishers,
        events: { registro: true, primera_carga: true, carga: document.getElementById('whEvCarga').checked, retiro: document.getElementById('whEvRetiro').checked },
        fields: { atribucion: document.getElementById('whFAtrib').checked, contacto: document.getElementById('whFContacto').checked },
        enabled: document.getElementById('whEnabled').checked,
        auth: { mode: document.getElementById('whAuthMode').value, header: document.getElementById('whAuthHeader').value.trim(), prefix: document.getElementById('whAuthPrefix').value }
    };
    if ((body.auth.mode === 'header') && !body.auth.header) { if (m) { m.style.color = '#ff8080'; m.textContent = '❌ Poné el nombre del header para el token'; } return; }
    if (body.fields.contacto && !confirm('Vas a mandar el MAIL y el TELÉFONO de los usuarios a ' + (body.name || body.url) + '. ¿Confirmás?')) return;
    try {
        const r = await authFetch('/api/admin/webhooks', { method: 'POST', body: JSON.stringify(body) });
        const j = await r.json().catch(function () { return {}; });
        if (!r.ok) { if (m) { m.style.color = '#ff8080'; m.textContent = '❌ ' + (j.error || 'No se pudo guardar'); } return; }
        showToast('Destino guardado', 'success');
        webhookCancel(); loadWebhooksCard();
    } catch (_) { if (m) { m.style.color = '#ff8080'; m.textContent = '❌ Error de conexión'; } }
}
async function webhookDelete(id) {
    const d = _whDests.find(function (x) { return x.id === id; });
    if (!confirm('¿Borrar el destino "' + (d ? d.name : id) + '"? Deja de recibir avisos y se descarta lo que tenga en cola.')) return;
    try {
        const r = await authFetch('/api/admin/webhooks/' + encodeURIComponent(id), { method: 'DELETE' });
        const j = await r.json().catch(function () { return {}; });
        if (!r.ok) { showToast(j.error || 'No se pudo borrar', 'error'); return; }
        showToast('Destino borrado', 'success'); loadWebhooksCard();
    } catch (_) { showToast('Error de conexión', 'error'); }
}
async function webhookTest(id) {
    showToast('Enviando aviso de prueba…', 'info');
    try {
        const r = await authFetch('/api/admin/webhooks/' + encodeURIComponent(id) + '/test', { method: 'POST' });
        const j = await r.json().catch(function () { return {}; });
        if (!r.ok) { showToast(j.error || 'No se pudo probar', 'error'); return; }
        if (j.ok) showToast('✅ El receptor respondió ' + j.status, 'success');
        else showToast('❌ No llegó: ' + (j.error || 'sin respuesta'), 'error');
        loadWebhooksCard();
    } catch (_) { showToast('Error de conexión', 'error'); }
}
window.loadWebhooksCard = loadWebhooksCard; window.webhookCopyFormat = webhookCopyFormat; window.webhookAuthChanged = webhookAuthChanged; window.webhookEdit = webhookEdit; window.webhookCancel = webhookCancel; window.webhookGenSecret = webhookGenSecret;
window.webhookScopeChanged = webhookScopeChanged; window.webhookSave = webhookSave; window.webhookDelete = webhookDelete; window.webhookTest = webhookTest;
```

---

## 9) Pruebas

1. `node --check` en server.js, los 2 archivos nuevos, metaCapiService, admin.js, admin-sw.
2. Deploy. Panel → Configuración → card "🔗 Webhooks salientes" → "+ Nuevo destino": nombre, URL
   de https://webhook.site, "Generar uno al azar", TODOS → Guardar → "📤 Enviar prueba" → la lista
   muestra "✅ último OK (prueba)" y en webhook.site llega el POST con los 4 headers `X-Webhook-*`.
3. Registrar un usuario de prueba → llega `registro`. Cargarle → llega `primera_carga` con
   `first_deposit:true` y `transaction_id`. Segunda carga → NO llega (salvo tildar "Todas las cargas").
4. Apagar webhook.site / URL inválida → el aviso queda "en cola" (contador en la lista) y el worker
   lo reintenta cada 5 min; borrar el destino descarta su cola.
5. Si el receptor responde 401 con el secreto bien cargado: cambiar el "modo de autenticación" del
   destino a lo que pida su plataforma (HMAC del body / Bearer / header).
