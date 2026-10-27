/**
 * Servicio Finpro (banco con API, #217) — segundo banco, paralelo a hgcash.
 * Copia 1:1 del servicio del gemelo AUTOGIROXcompartido (#368): no divergir — los
 * parches se portan entre páginas tal cual. Acá no hubo GH Wallet: Finpro es el PRIMER
 * segundo banco de esta página.
 *
 * Doc oficial: app.finpro.com.ar/docs (transcripción del owner, 2026-10-27). Todo lo que
 * la doc no aclara está marcado como DECISIÓN en los comentarios y en ARCHITECTURE §5.
 *
 * Auth: TODAS las llamadas llevan `X-API-Key` + `X-API-Secret` (el secret Finpro lo
 * muestra UNA vez; regenerarlo invalida el anterior). Algunas operaciones (consulta de
 * titular `accounts/information`) piden además un token de cliente (`x-access-token`,
 * `POST /auth/token/client`, dura `expires_in` s = 1 h): se cachea en memoria y se
 * renueva cuando le quedan < 120 s o ante un 401.
 *
 * Qué se usa:
 *   • Retiros: `POST /transfers/cvu` — UN lote = UNA transferencia (process_id uuid,
 *     transaction_id ≤ 11 chars). `code '0201'` = lote aceptado; el resultado real
 *     (coelsa_id, response_code) sale después por `processes/{id}/result`. La doc pide
 *     mandar las transferencias de un mismo from_cvu de a UNA (si no, error 2454):
 *     `withCvuLock` las encola por proceso.
 *   • Cargas: Finpro NO nos avisa (todavía) cuando entra plata: se CONSULTA con
 *     `POST /transfers/verify/incoming` (coelsa_id | authorization_code | monto+fecha+
 *     ventana+CVU) a partir del comprobante del cliente. Solo valida acreditadas: NO
 *     detecta reversiones. Webhooks y "listado para conciliación" quedan para cuando el
 *     owner mande esa parte de la doc (`_finproIngestIncoming` en server.js).
 *   • Titular/CVU de un alias o CVU: `POST /accounts/information` (Coelsa).
 *   • Saldo: `POST /accounts/balance` (campos no documentados → parseo defensivo + raw).
 *
 * Configuración (lazy: SSM carga después del require). PANEL > SSM/env:
 *   FINPRO_API_KEY / FINPRO_API_SECRET   credenciales (respaldo del panel, cifrado)
 *   FINPRO_API_URL      base URL. Default `https://mw-dev.finpro.com.ar` = host de
 *                       DESARROLLO de la doc; el de producción no está documentado →
 *                       el panel avisa en rojo cuando la URL contiene "dev".
 *   FINPRO_BANK_ID      `{bankId}` de los paths (doc: `creedence`)
 *   FINPRO_ACCOUNT      número de cuenta interno de Finpro (para el saldo)
 *   FINPRO_FROM_CVU     nuestro CVU (origen de los retiros / destino de las cargas)
 *   FINPRO_TIMEOUT_MS   (default 20000)
 *
 * ⚠️ Nunca loguear ni devolver la key/secret/token: los helpers solo exponen last4.
 */

const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');

const DEFAULT_BASE_URL = 'https://mw-dev.finpro.com.ar';
const DEFAULT_BANK_ID = 'creedence';
const TOKEN_RENEW_MARGIN_SEC = 120;

// ───────────────────────── credenciales y settings (panel > env) ─────────────────────────
let _credsOverride = null;   // { apiKey, apiSecret } cargados desde el panel (server.js)
let _settingsOverride = {};  // { baseUrl, bankId, account, fromCvu } del panel

function setCredentialsOverride(c) {
  const k = c && typeof c.apiKey === 'string' ? c.apiKey.trim() : '';
  const s = c && typeof c.apiSecret === 'string' ? c.apiSecret.trim() : '';
  const next = (k && s) ? { apiKey: k, apiSecret: s } : null;
  const changed = _keyTag(next || _envCreds()) !== _keyTag(_credsOverride || _envCreds());
  _credsOverride = next;
  if (changed) _token = { token: null, expiresAt: 0, keyTag: null }; // credenciales nuevas → token nuevo
}
function setSettingsOverride(s) {
  const o = s && typeof s === 'object' ? s : {};
  _settingsOverride = {
    baseUrl: typeof o.baseUrl === 'string' ? o.baseUrl.trim() : '',
    bankId: typeof o.bankId === 'string' ? o.bankId.trim() : '',
    account: typeof o.account === 'string' ? o.account.trim() : '',
    fromCvu: typeof o.fromCvu === 'string' ? o.fromCvu.replace(/\D/g, '') : ''
  };
}
function _envCreds() {
  const k = String(process.env.FINPRO_API_KEY || '').trim();
  const s = String(process.env.FINPRO_API_SECRET || '').trim();
  return (k && s) ? { apiKey: k, apiSecret: s } : null;
}
function getCredentials() { return _credsOverride || _envCreds(); }
function getCredentialSource() { return _credsOverride ? 'panel' : (_envCreds() ? 'ssm' : 'none'); }
function isEnabled() { return !!getCredentials(); }
function baseUrl() { return String(_settingsOverride.baseUrl || process.env.FINPRO_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''); }
function bankId() { return String(_settingsOverride.bankId || process.env.FINPRO_BANK_ID || DEFAULT_BANK_ID).trim(); }
function account() { return String(_settingsOverride.account || process.env.FINPRO_ACCOUNT || '').trim(); }
function fromCvu() { return String(_settingsOverride.fromCvu || process.env.FINPRO_FROM_CVU || '').replace(/\D/g, ''); }
/** ¿La URL apunta al ambiente de DESARROLLO? (host de la doc: mw-dev.finpro.com.ar) */
function isDevUrl(u) {
  try { return /dev|sandbox|test|staging/i.test(new URL(u || baseUrl()).hostname); } catch (_) { return /dev/i.test(String(u || baseUrl())); }
}
/** Listo para PAGAR retiros: credenciales + nuestro CVU de 22 dígitos. */
function isReadyForPayouts() { return isEnabled() && fromCvu().length === 22; }
/** Listo para VERIFICAR cargas: credenciales + (CVU o cuenta) para acotar la búsqueda. */
function isReadyForIncoming() { return isEnabled() && (fromCvu().length === 22 || !!account()); }
function settingsPublic() {
  return {
    baseUrl: baseUrl(), bankId: bankId(), account: account(), fromCvu: fromCvu(),
    dev: isDevUrl(), source: _settingsOverride.baseUrl || _settingsOverride.bankId || _settingsOverride.account || _settingsOverride.fromCvu ? 'panel' : 'env'
  };
}

// ───────────────────────── diagnóstico (ring buffer por instancia) ─────────────────────────
const _lastCalls = [];
function _logCall(entry) {
  _lastCalls.unshift(Object.assign({ at: new Date() }, entry));
  if (_lastCalls.length > 40) _lastCalls.length = 40;
}
function getDiag() {
  return {
    credentials: getCredentialSource(),
    settings: settingsPublic(),
    token: { has: !!_token.token, expiresAt: _token.expiresAt ? new Date(_token.expiresAt) : null, secondsLeft: _token.token ? Math.max(0, Math.round((_token.expiresAt - Date.now()) / 1000)) : 0 },
    queue: Array.from(_cvuQueues.keys()).map((k) => ({ fromCvu: '…' + k.slice(-6), inFlight: _cvuInFlight.get(k) || 0 })),
    lastCalls: _lastCalls.slice(0, 25)
  };
}

// ───────────────────────── request genérico ─────────────────────────
function _path(p) { return `/api/banks/${encodeURIComponent(bankId())}${p}`; }
/**
 * Devuelve SIEMPRE un objeto (nunca tira):
 *   { ok, httpStatus, data, code, description, error, ms }
 * `code`/`description` salen del body de Finpro (`code`, `description` / `message`).
 */
async function _request(method, path, { body, creds, token, timeoutMs, kind } = {}) {
  const c = creds || getCredentials();
  if (!c) return { ok: false, httpStatus: 0, data: null, code: null, description: null, error: 'Finpro sin credenciales (panel → Finpro, o FINPRO_API_KEY/SECRET en SSM)' };
  const headers = { 'X-API-Key': c.apiKey, 'X-API-Secret': c.apiSecret, 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers['x-access-token'] = token;
  const t0 = Date.now();
  let out;
  try {
    const resp = await axios({
      method, url: baseUrl() + path, data: body === undefined ? {} : body, headers,
      timeout: Number(timeoutMs || process.env.FINPRO_TIMEOUT_MS || 20000),
      validateStatus: () => true, maxRedirects: 0
    });
    const d = resp.data && typeof resp.data === 'object' ? resp.data : {};
    const code = d.code != null ? String(d.code) : (d.status_code != null ? String(d.status_code) : null);
    const description = d.description || d.message || d.detail || (typeof d.error === 'string' ? d.error : null) || null;
    out = {
      ok: resp.status >= 200 && resp.status < 300,
      httpStatus: resp.status, data: d, code, description,
      error: resp.status >= 400 ? (description || `HTTP ${resp.status}`) : null,
      ms: Date.now() - t0
    };
  } catch (e) {
    out = { ok: false, httpStatus: 0, data: null, code: null, description: null, error: e.code === 'ECONNABORTED' ? 'timeout' : (e.message || 'red'), network: true, ms: Date.now() - t0 };
  }
  _logCall({ kind: kind || path, method, path, ok: out.ok, httpStatus: out.httpStatus, code: out.code, error: out.error ? String(out.error).slice(0, 160) : null, ms: out.ms });
  return out;
}

// ───────────────────────── token de cliente (1 h) ─────────────────────────
let _token = { token: null, expiresAt: 0, keyTag: null };
function _keyTag(c) { return c ? crypto.createHash('sha256').update(c.apiKey + ':' + c.apiSecret).digest('hex').slice(0, 12) : null; }
/** Token de cliente (`x-access-token`). Cacheado; se renueva si quedan < 120 s o con force. */
async function getClientToken({ creds, force } = {}) {
  const c = creds || getCredentials();
  if (!c) return { ok: false, error: 'sin credenciales' };
  const tag = _keyTag(c);
  if (!force && _token.token && _token.keyTag === tag && _token.expiresAt - Date.now() > TOKEN_RENEW_MARGIN_SEC * 1000) {
    return { ok: true, token: _token.token, cached: true, expiresAt: _token.expiresAt };
  }
  const r = await _request('POST', _path('/auth/token/client'), { body: {}, creds: c, kind: 'auth/token' });
  const d = r.data || {};
  const tok = d.token || d.access_token || (d.data && (d.data.token || d.data.access_token)) || null;
  if (!r.ok || !tok) {
    return Object.assign(r, { ok: false, error: r.error || (r.ok ? 'respuesta sin token' : 'no se pudo obtener el token') });
  }
  const expiresIn = Number(d.expires_in || (d.data && d.data.expires_in)) || 3600;
  const expiresAt = Date.now() + expiresIn * 1000;
  if (!creds || tag === _keyTag(getCredentials())) _token = { token: tok, expiresAt, keyTag: tag };
  return { ok: true, token: tok, cached: false, expiresAt, tokenType: d.token_type || null, httpStatus: r.httpStatus, code: r.code };
}
function invalidateToken() { _token = { token: null, expiresAt: 0, keyTag: null }; }
/** Ejecuta `fn(token)`; ante un 401 renueva el token y reintenta UNA vez. */
async function _withToken(fn, creds) {
  let t = await getClientToken({ creds });
  if (!t.ok) return { ok: false, httpStatus: t.httpStatus || 0, error: 'token: ' + (t.error || 'falló'), code: t.code || null, data: t.data || null };
  let r = await fn(t.token);
  if (r.httpStatus === 401) {
    t = await getClientToken({ creds, force: true });
    if (t.ok) r = await fn(t.token);
  }
  return r;
}

// ───────────────────────── helpers ─────────────────────────
function newTrace() { return String(Date.now()) + String(Math.floor(Math.random() * 900) + 100); }         // numérico
function newRetrieval() { return 'VIP' + crypto.randomBytes(6).toString('hex').toUpperCase(); }               // alfanumérico
/** ISO 8601 con offset de Argentina (-03:00), como pide `initial_datetime`. */
function isoWithOffsetAR(date) {
  const d = date ? new Date(date) : new Date();
  const ar = new Date(d.getTime() - 3 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${ar.getUTCFullYear()}-${p(ar.getUTCMonth() + 1)}-${p(ar.getUTCDate())}T${p(ar.getUTCHours())}:${p(ar.getUTCMinutes())}:${p(ar.getUTCSeconds())}-03:00`;
}
/** transaction_id determinístico (≤ 11 chars) a partir del id del payout local. */
function transactionIdFor(payoutId) {
  return 'P' + crypto.createHash('sha1').update(String(payoutId)).digest('hex').slice(0, 10).toUpperCase();
}
/** Busca un número en un objeto por lista de claves (shallow + 1 nivel), para respuestas no documentadas. */
function _pickNumber(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  const scan = (o) => {
    for (const k of keys) {
      if (o[k] != null && o[k] !== '' && Number.isFinite(Number(o[k]))) return Number(o[k]);
    }
    return null;
  };
  let v = scan(obj);
  if (v != null) return v;
  for (const k of Object.keys(obj)) {
    if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) { v = scan(obj[k]); if (v != null) return v; }
  }
  return null;
}
function _pickString(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  const scan = (o) => { for (const k of keys) { if (o[k] != null && String(o[k]).trim()) return String(o[k]).trim(); } return null; };
  let v = scan(obj);
  if (v != null) return v;
  for (const k of Object.keys(obj)) {
    if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) { v = scan(obj[k]); if (v != null) return v; }
  }
  return null;
}

// ───────────────────────── códigos del banco (tabla de la doc) ─────────────────────────
const BANK_CODES = {
  '2449': { msg: 'Saldo insuficiente en la cuenta de Finpro. Cargá saldo y reintentá.', retry: false },
  '2418': { msg: 'La cuenta destino está BLOQUEADA. No se puede pagar a ese CBU/CVU: pedile otro al cliente o pagá por otro banco.', retry: false },
  '2454': { msg: 'Finpro ya tiene una operación en curso desde este CVU. Se reintenta cuando termine la anterior.', retry: true },
  '2455': { msg: 'Finpro rechazó el pedido (bad request; típicamente transaction_id > 11 caracteres). Avisale al desarrollador.', retry: false },
  '0414': { msg: 'El CVU destino no está habilitado para recibir transferencias. Verificá el destino con el cliente.', retry: false },
  '0416': { msg: 'CVU inválido (origen o destino). Revisá nuestro CVU en el panel y el del cliente.', retry: false },
  '0583': { msg: 'Falla transitoria del banco (0583): se puede reintentar con un pedido nuevo.', retry: true },
  '0500': { msg: 'Error genérico del banco (0500). Si persiste, contactar a soporte de Finpro.', retry: false }
};
const SUCCESS_CODES = ['0200', '0201', '200', '201', '0000', '00', '0'];
function describeCode(code, description) {
  const c = code != null ? String(code).trim() : '';
  const known = BANK_CODES[c] || BANK_CODES[c.padStart(4, '0')];
  if (known) return `${known.msg} (código ${c}${description ? ': ' + String(description).slice(0, 120) : ''})`;
  if (c) return `Finpro respondió código ${c}${description ? ': ' + String(description).slice(0, 160) : ''}`;
  return description ? String(description).slice(0, 200) : 'sin detalle';
}
/** ¿El código es de ERROR del banco? (tabla + forma 2xxx / 04xx / 05xx / 4xx / 5xx). DECISIÓN defensiva. */
function isErrorCode(code) {
  if (code == null || code === '') return false;
  const c = String(code).trim();
  if (SUCCESS_CODES.includes(c)) return false;
  if (BANK_CODES[c]) return true;
  return /^(2\d{3}|04\d{2}|05\d{2}|4\d{2}|5\d{2})$/.test(c);
}
function isTransientCode(code) { const c = String(code || '').trim(); return c === '0583' || c === '2454' || c === '583'; }

// ───────────────────────── cola secuencial por from_cvu ─────────────────────────
// La doc recomienda mandar las transferencias de un mismo CVU de a una, esperando el
// resultado de cada proceso (si no, 2454). Cola de promesas por CVU en ESTA instancia
// (con varias instancias de EB el 2454 sigue siendo posible → se reintenta igual).
const _cvuQueues = new Map();
const _cvuInFlight = new Map();
function withCvuLock(cvu, fn) {
  const key = String(cvu || 'default');
  const prev = _cvuQueues.get(key) || Promise.resolve();
  _cvuInFlight.set(key, (_cvuInFlight.get(key) || 0) + 1);
  const run = prev.catch(() => {}).then(() => fn()).finally(() => {
    _cvuInFlight.set(key, Math.max(0, (_cvuInFlight.get(key) || 1) - 1));
    if (_cvuQueues.get(key) === run && !_cvuInFlight.get(key)) _cvuQueues.delete(key);
  });
  _cvuQueues.set(key, run);
  return run;
}

// ───────────────────────── operaciones ─────────────────────────
/** Saldo de la cuenta (`accounts/balance`). Campos no documentados → `balance`/`available` best-effort + `raw`. */
async function getBalance({ account: acc, creds } = {}) {
  const a = acc || account();
  if (!a) return { ok: false, error: 'Falta el número de cuenta de Finpro (panel → Finpro, o FINPRO_ACCOUNT).' };
  const r = await _request('POST', _path('/accounts/balance'), { body: { account: a, trace: newTrace(), retrieval: newRetrieval() }, creds, kind: 'accounts/balance' });
  if (!r.ok) return r;
  const d = r.data || {};
  return Object.assign(r, {
    balance: _pickNumber(d, ['balance', 'saldo', 'total', 'saldo_total', 'current_balance', 'balance_total']),
    available: _pickNumber(d, ['available', 'disponible', 'available_balance', 'saldo_disponible', 'availableBalance', 'balance', 'saldo']),
    currency: _pickString(d, ['currency', 'moneda']) || 'ARS'
  });
}

/**
 * Titular de un CVU o alias (Coelsa). Devuelve { ok, found, nombre, cuit, tipoPersona, cvu, code, description, raw }.
 * `found` = la red devolvió un titular. Un alias resuelto trae `cvu` si la respuesta lo incluye.
 */
async function getAccountInformation({ cvu, alias, creds } = {}) {
  const body = {};
  const c = String(cvu || '').replace(/\D/g, '');
  if (c.length === 22) body.cvu = c; else if (alias) body.alias = String(alias).trim().toLowerCase(); else return { ok: false, error: 'CVU (22 dígitos) o alias requerido' };
  const r = await _withToken((token) => _request('POST', _path('/accounts/information'), { body, token, creds, kind: 'accounts/information' }), creds);
  const d = r.data || {};
  const info = d.data && typeof d.data === 'object' ? Object.assign({}, d, d.data) : d;
  const nombre = _pickString(info, ['nombre', 'name', 'titular', 'holder', 'owner_name', 'denominacion']);
  return Object.assign(r, {
    found: !!nombre,
    nombre,
    cuit: _pickString(info, ['cuit', 'cuil', 'cuit_cuil', 'tax_id']),
    tipoPersona: _pickString(info, ['tipo_persona', 'tipoPersona', 'person_type']),
    cvu: (_pickString(info, ['cvu', 'cbu', 'cbu_cvu', 'account_number']) || (body.cvu || '')).replace(/\D/g, '') || null,
    alias: _pickString(info, ['alias']) || body.alias || null
  });
}

/**
 * Lote de UNA transferencia a CVU. `code '0201'` = aceptado (accepted:true). El resultado
 * final (coelsa_id / response_code) llega después por `getProcessResult`.
 */
async function createCvuTransfer({ processId, transactionId, fromCvu: from, toCvu, amount, description, callbackUrl, initialDatetime, concept, creds }) {
  const txId = String(transactionId || '').slice(0, 11);
  const body = {
    process_id: String(processId),
    transaction_count: 1,
    initial_datetime: initialDatetime || isoWithOffsetAR(),
    data: [{
      transaction_id: txId,
      from_cvu: String(from || fromCvu()).replace(/\D/g, ''),
      to_cvu: String(toCvu || '').replace(/\D/g, ''),
      amount: Number(amount),
      concept: concept || 'VAR',
      description: String(description || 'Retiro').slice(0, 100)
    }]
  };
  if (callbackUrl) body.callback_url = callbackUrl;
  const r = await _request('POST', _path('/transfers/cvu'), { body, creds, timeoutMs: 30000, kind: 'transfers/cvu' });
  const code = r.code;
  const accepted = r.ok && (code === '0201' || code === '201' || (code == null && !!(r.data && (r.data.process_id || r.data.processId))));
  return Object.assign(r, { accepted, processId: (r.data && (r.data.process_id || r.data.processId)) || String(processId), transactionId: txId });
}

/** Estado de uno o varios procesos. Normaliza el primero: { status, successCount, failCount, processedCount, raw }. */
async function getProcessStatus(processIds, { creds } = {}) {
  const ids = (Array.isArray(processIds) ? processIds : [processIds]).map(String).filter(Boolean);
  const r = await _request('POST', _path('/processes/status'), { body: { process_ids: ids }, creds, kind: 'processes/status' });
  const d = r.data || {};
  let row = d;
  const list = Array.isArray(d) ? d : (Array.isArray(d.data) ? d.data : (Array.isArray(d.processes) ? d.processes : (Array.isArray(d.results) ? d.results : null)));
  if (list) row = list.find((x) => x && String(x.process_id || x.processId || x.id) === ids[0]) || list[0] || {};
  else if (d.data && typeof d.data === 'object') row = Object.assign({}, d, d.data);
  const status = _pickString(row, ['status', 'state', 'process_status']);
  return Object.assign(r, {
    status: status ? status.toLowerCase() : null,
    finished: /^(finished|finalizado|completed|done|processed)$/i.test(status || ''),
    successCount: _pickNumber(row, ['transaction_success_count', 'success_count']),
    failCount: _pickNumber(row, ['transaction_fail_count', 'fail_count']),
    processedCount: _pickNumber(row, ['transaction_processed_count', 'processed_count']),
    notFound: r.httpStatus === 404 || (list && !list.length)
  });
}

/** Resultado por transacción de un proceso: { transactions: [{ transactionId, coelsaId, responseCode, responseDescription, amount, cbuFrom, cbuTo, authorizationCode, raw }] }. */
async function getProcessResult(processId, { creds } = {}) {
  const r = await _request('POST', _path(`/processes/${encodeURIComponent(String(processId))}/result`), { body: {}, creds, kind: 'processes/result' });
  const d = r.data || {};
  let list = Array.isArray(d) ? d : (Array.isArray(d.data) ? d.data : (Array.isArray(d.transactions) ? d.transactions : (Array.isArray(d.results) ? d.results : (Array.isArray(d.result) ? d.result : null))));
  if (!list && d.data && typeof d.data === 'object' && Array.isArray(d.data.transactions)) list = d.data.transactions;
  if (!list) list = (d.coelsa_id || d.response_code || d.transaction_id) ? [d] : [];
  const transactions = list.map((t) => ({
    transactionId: _pickString(t, ['transaction_id', 'transactionId']),
    coelsaId: _pickString(t, ['coelsa_id', 'coelsaId', 'coelsa']),
    responseCode: _pickString(t, ['response_code', 'responseCode', 'code']),
    responseDescription: _pickString(t, ['response_description', 'responseDescription', 'description', 'message']),
    amount: _pickNumber(t, ['amount', 'monto']),
    cbuFrom: _pickString(t, ['cbu_from', 'from_cvu', 'cbuFrom']),
    cbuTo: _pickString(t, ['cbu_to', 'to_cvu', 'cbuTo']),
    authorizationCode: _pickString(t, ['authorization_code', 'authorizationCode']),
    status: _pickString(t, ['status', 'state']),
    raw: t
  }));
  const processStatus = _pickString(d, ['status', 'state', 'process_status']);
  return Object.assign(r, { transactions, processStatus: processStatus ? processStatus.toLowerCase() : null });
}

/**
 * Verifica una transferencia ENTRANTE acreditada (`transfers/verify/incoming`). Solo
 * headers X-API-Key/Secret. Devuelve { ok, status: 'confirmed'|'not_found_yet'|'ambiguous'|null,
 * matchedBy, confidence, notification, matches, httpStatus, error, raw }.
 * Un 400/401/403 queda en `error` (sin status). NO detecta reversiones.
 */
async function verifyIncoming({ coelsaId, authorizationCode, amount, occurredAt, windowMinutes, toCvu, toAccount, creds } = {}) {
  const body = {};
  if (coelsaId) body.coelsa_id = String(coelsaId).trim();
  else if (authorizationCode) body.authorization_code = String(authorizationCode).trim();
  else {
    if (!(Number(amount) > 0)) return { ok: false, error: 'Para verificar sin coelsa hace falta el monto (y la fecha).' };
    body.amount = Number(amount);
    body.occurred_at = occurredAt ? (occurredAt instanceof Date ? occurredAt.toISOString() : String(occurredAt)) : new Date().toISOString();
    body.window_minutes = Math.min(1440, Math.max(1, Number(windowMinutes) || 180));
    const tc = String(toCvu || fromCvu() || '').replace(/\D/g, '');
    if (tc.length === 22) body.to_cvu = tc;
    else if (toAccount || account()) body.to_account = String(toAccount || account());
  }
  const r = await _request('POST', _path('/transfers/verify/incoming'), { body, creds, kind: 'verify/incoming' });
  const d = r.data || {};
  const info = d.data && typeof d.data === 'object' && !Array.isArray(d.data) ? Object.assign({}, d, d.data) : d;
  const st = _pickString(info, ['status', 'result']);
  const status = /^confirmed$/i.test(st || '') ? 'confirmed' : (/not_found/i.test(st || '') ? 'not_found_yet' : (/ambig/i.test(st || '') ? 'ambiguous' : (st ? st.toLowerCase() : null)));
  const notification = info.notification && typeof info.notification === 'object' ? info.notification : null;
  return Object.assign(r, {
    status: r.ok ? status : null,
    matchedBy: _pickString(info, ['matched_by', 'matchedBy']),
    confidence: (_pickString(info, ['confidence']) || '').toLowerCase() || null,
    notification: notification ? {
      id: notification.id != null ? String(notification.id) : null,
      amount: _pickNumber(notification, ['amount', 'monto']),
      authorizationCode: _pickString(notification, ['authorization_code', 'authorizationCode']),
      coelsaId: _pickString(notification, ['coelsa_id', 'coelsaId']),
      toCvu: _pickString(notification, ['to_cvu', 'toCvu', 'cbu_to']),
      fromCvu: _pickString(notification, ['from_cvu', 'fromCvu', 'cbu_from', 'origin_cvu']),
      fromName: _pickString(notification, ['from_name', 'payer_name', 'origin_name', 'nombre_origen', 'titular_origen', 'holder']),
      fromCuit: _pickString(notification, ['from_cuit', 'payer_cuit', 'origin_cuit', 'cuit_origen', 'cuit']),
      occurredAt: _pickString(notification, ['occurred_at', 'occurredAt', 'credited_at', 'date', 'fecha', 'created_at']),
      raw: notification
    } : null,
    matches: Array.isArray(info.matches) ? info.matches : null,
    searchedScope: info.searched_scope || null,
    requestKind: body.coelsa_id ? 'coelsa_id' : (body.authorization_code ? 'authorization_code' : 'amount_date'),
    requestBody: body
  });
}

module.exports = {
  // config
  setCredentialsOverride, setSettingsOverride, getCredentialSource, isEnabled, baseUrl, bankId, account, fromCvu,
  isDevUrl, isReadyForPayouts, isReadyForIncoming, settingsPublic, getDiag,
  // token
  getClientToken, invalidateToken,
  // operaciones
  getBalance, getAccountInformation, createCvuTransfer, getProcessStatus, getProcessResult, verifyIncoming,
  // helpers
  withCvuLock, describeCode, isErrorCode, isTransientCode, transactionIdFor, isoWithOffsetAR, newTrace, newRetrieval,
  DEFAULT_BASE_URL, DEFAULT_BANK_ID
};
