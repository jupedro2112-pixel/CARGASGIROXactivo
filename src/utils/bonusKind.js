/**
 * bonusKind.js — BONO NORMAL vs BONO WAGER (#226, Partner API v1.18 §2.8 "Premio
 * PROMOCIONAL (saldo Wager)"). Parte PURA: sin DB ni API, para validarla en frío
 * (`node scripts/test-bonus-kind.js`). server.js lee Config['bonusKind'] y llama acá.
 *
 * QUÉ ES EL WAGER: saldo PROMOCIONAL (plata ficticia de la casa, balde aparte del
 * saldo real; no sale del saldo del agente, no es retirable, sin rollover; se juega
 * después del saldo real y se convierte en real de a 5% de lo apostado por ronda).
 *
 * CÓMO SE OTORGA (límite de la API, no nuestro): NO hay un campo para pedirlo. Solo
 * lo entrega una REGLA AUTOMÁTICA de 1girox con premio "Promocional"; desde la API se
 * dispara mandando `promo_code` en el POST /deposit. Consecuencias que este módulo
 * modela:
 *   - El wager SOLO puede ir adentro de una CARGA (no hay wager "suelto": reembolsos,
 *     ruleta en $, fueguito, rakeback, etc. siguen siendo bono normal).
 *   - El MONTO lo decide la regla de 1girox (su % y su tope), no nosotros: por eso
 *     cada código se carga acá con el % que tiene allá y se elige por % EXACTO.
 *   - UN solo código por carga, y si el depósito lleva `bonus_amount` la regla NO
 *     aplica ("tus params siempre ganan") → una carga con wager no lleva bono normal
 *     adjunto: lo normal que haya que dar va en una operación aparte.
 *
 * Config['bonusKind'] = {
 *   enabled,                       // interruptor general (default APAGADO = todo normal)
 *   fallback: 'normal' | 'skip',   // si el wager no se pudo dar: bono normal / no dar nada (queda pendiente)
 *   flows: { install, publisher, roulette, story, lote } → 'normal' | 'wager',
 *   codes: [{ code, pct, capArs, label, enabled, oncePerPlayer }]
 * }
 */
// Bonos AUTOMÁTICOS configurables. El bono que pone el agente a mano NO está acá a
// propósito: lo elige el agente en cada carga (modal Depositar, siempre arranca en
// "normal") — un default "wager" le mandaría el código a TODAS las cargas manuales,
// incluidas las que el agente quería sin bono.
const FLOWS = ['install', 'publisher', 'roulette', 'story', 'lote'];
const FLOW_LABELS = {
  install: 'Bono por instalar la app',
  publisher: 'Bono de 1ª carga por publicista',
  roulette: 'Ruleta diaria (% EXTRA en la próxima carga)',
  story: 'Bono de una historia (+% en la próxima carga)',
  lote: 'Lote con regalo (% automático)'
};
const KINDS = ['normal', 'wager'];
const FALLBACKS = ['normal', 'skip'];
const MAX_CODES = 30;
const CODE_RE = /^[A-Za-z0-9_\-]{2,40}$/;

function defaultConfig() {
  const flows = {};
  FLOWS.forEach((f) => { flows[f] = 'normal'; });
  return { enabled: false, fallback: 'normal', flows, codes: [] };
}

function _cleanCode(raw) {
  const c = String(raw == null ? '' : raw).trim();
  return CODE_RE.test(c) ? c : null;
}

/** Normaliza una fila de código. Devuelve null si es inválida. */
function normalizeCodeRow(r) {
  if (!r || typeof r !== 'object') return null;
  const code = _cleanCode(r.code);
  if (!code) return null;
  const pct = Math.round(Number(r.pct));
  if (!Number.isFinite(pct) || pct < 1 || pct > 1000) return null;
  let capArs = Math.round(Number(r.capArs));
  if (!Number.isFinite(capArs) || capArs < 0) capArs = 0; // 0 = sin tope
  return {
    code, pct, capArs,
    label: String(r.label == null ? '' : r.label).trim().slice(0, 60),
    enabled: r.enabled !== false,
    oncePerPlayer: r.oncePerPlayer === true
  };
}

/** Lee lo guardado (tolerante: lo inválido se descarta y vale el default). */
function normalizeConfig(raw) {
  const d = defaultConfig();
  if (!raw || typeof raw !== 'object') return d;
  const out = defaultConfig();
  out.enabled = raw.enabled === true;
  out.fallback = FALLBACKS.includes(raw.fallback) ? raw.fallback : 'normal';
  const rf = (raw.flows && typeof raw.flows === 'object') ? raw.flows : {};
  FLOWS.forEach((f) => { out.flows[f] = rf[f] === 'wager' ? 'wager' : 'normal'; });
  const seen = new Set();
  (Array.isArray(raw.codes) ? raw.codes : []).forEach((r) => {
    const n = normalizeCodeRow(r);
    if (!n) return;
    const k = n.code.toLowerCase();
    if (seen.has(k) || out.codes.length >= MAX_CODES) return;
    seen.add(k);
    out.codes.push(n);
  });
  return out;
}

/**
 * Valida lo que manda el panel (estricta: un dato inválido es error, no se descarta
 * en silencio). Devuelve { ok:true, config, warnings[] } | { ok:false, error }.
 */
function validateConfig(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = defaultConfig();
  out.enabled = b.enabled === true;
  if (b.fallback != null && !FALLBACKS.includes(b.fallback)) return { ok: false, error: 'Opción inválida para "si el wager no se puede dar".' };
  out.fallback = FALLBACKS.includes(b.fallback) ? b.fallback : 'normal';
  const rf = (b.flows && typeof b.flows === 'object') ? b.flows : {};
  for (const f of FLOWS) {
    const v = rf[f] == null ? 'normal' : rf[f];
    if (!KINDS.includes(v)) return { ok: false, error: `Tipo de bono inválido para "${FLOW_LABELS[f]}".` };
    out.flows[f] = v;
  }
  const rows = Array.isArray(b.codes) ? b.codes : [];
  if (rows.length > MAX_CODES) return { ok: false, error: `Máximo ${MAX_CODES} códigos.` };
  const seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    if (!_cleanCode(r.code)) return { ok: false, error: `Código ${i + 1}: escribí el código tal cual está en 1girox (2 a 40 letras, números, guion o guion bajo, sin espacios).` };
    const n = normalizeCodeRow(r);
    if (!n) return { ok: false, error: `Código "${String(r.code).trim()}": el % tiene que ser un número entre 1 y 1000.` };
    const k = n.code.toLowerCase();
    if (seen.has(k)) return { ok: false, error: `El código "${n.code}" está repetido.` };
    seen.add(k);
    out.codes.push(n);
  }
  const warnings = [];
  const wagerFlows = FLOWS.filter((f) => out.flows[f] === 'wager');
  const active = out.codes.filter((c) => c.enabled);
  if (out.enabled && !active.length) warnings.push('El bono wager está ACTIVADO pero no hay ningún código activo: todo va a seguir saliendo como bono normal.');
  if (out.enabled && active.length && !wagerFlows.length) warnings.push('Hay códigos cargados pero ningún bono automático está puesto en "Wager": solo se va a usar cuando el agente elija "Bono wager" a mano al cargar.');
  if (!out.enabled && wagerFlows.length) warnings.push('Hay bonos puestos en "Wager" pero el interruptor general está APAGADO: siguen saliendo como bono normal.');
  return { ok: true, config: out, warnings };
}

/** ¿Este flujo sale como wager? (interruptor general + tipo del flujo) */
function flowIsWager(cfg, flow) {
  return !!(cfg && cfg.enabled && cfg.flows && cfg.flows[flow] === 'wager');
}

/** Fila de un código por su texto (case-insensitive). Solo activos salvo opts.any. */
function findCode(cfg, code, opts) {
  const c = String(code == null ? '' : code).trim().toLowerCase();
  if (!c || !cfg || !Array.isArray(cfg.codes)) return null;
  const row = cfg.codes.find((r) => r.code.toLowerCase() === c);
  if (!row) return null;
  if (!row.enabled && !(opts && opts.any)) return null;
  return row;
}

/**
 * Elige el código para dar un wager de `pct`%: activo, con el MISMO %, y que el
 * jugador no haya usado ya si la fila es "una vez por jugador". Entre varios, el
 * primero de la lista (el orden del panel manda).
 */
function pickCode(cfg, pct, usedCodes) {
  if (!cfg || !cfg.enabled || !Array.isArray(cfg.codes)) return null;
  const p = Number(pct); // EXACTO: un premio de 12,5% no usa un código de 13%
  if (!Number.isFinite(p) || p <= 0) return null;
  const used = new Set((Array.isArray(usedCodes) ? usedCodes : []).map((c) => String(c).toLowerCase()));
  return cfg.codes.find((r) => r.enabled && r.pct === p && !(r.oncePerPlayer && used.has(r.code.toLowerCase()))) || null;
}

/** Wager que DEBERÍA dar un código sobre una carga (estimación: el real lo informa 1girox). */
function estimateWager(row, amount) {
  const a = Math.max(0, Number(amount) || 0);
  if (!row) return 0;
  const w = Math.floor(a * row.pct / 100);
  return row.capArs > 0 ? Math.min(w, row.capArs) : w;
}

/**
 * Plan de los bonos AUTOMÁTICOS de una carga.
 * @param cfg    config normalizada
 * @param items  bonos de esta carga, en orden de prioridad:
 *               [{ kind:'publisher'|'install'|'roulette'|'story'|'lote', pct, amount }]
 *               (`amount` = lo que saldría como bono NORMAL)
 * @param opts   { usedCodes: códigos que el jugador ya usó }
 * @returns { code, wagerItem, normalItems, normalTotal, skippedItems }
 *   - code/wagerItem: el ÚNICO bono de la carga que sale como wager (o null/null).
 *   - normalItems: los que salen como bono normal (flujo en "normal", o flujo en
 *     "wager" sin código y fallback 'normal').
 *   - skippedItems: flujo en "wager" sin código disponible y fallback 'skip' → no se
 *     dan en esta carga (quedan pendientes).
 * Sin wagerItem la carga sale EXACTAMENTE como antes (bono normal adjunto).
 */
function planDeposit(cfg, items, opts) {
  const out = { code: null, wagerItem: null, normalItems: [], normalTotal: 0, skippedItems: [] };
  const list = (Array.isArray(items) ? items : []).filter((it) => it && Number(it.amount) > 0);
  const used = (opts && opts.usedCodes) || [];
  for (const it of list) {
    if (flowIsWager(cfg, it.kind)) {
      if (!out.wagerItem) {
        const row = pickCode(cfg, it.pct, used);
        if (row) { out.code = row; out.wagerItem = it; continue; }
      }
      // en wager pero sin código para ese % (o ya hay otro wager en esta carga)
      if (cfg.fallback === 'skip') { out.skippedItems.push(it); continue; }
    }
    out.normalItems.push(it);
    out.normalTotal += Number(it.amount) || 0;
  }
  return out;
}

/**
 * Lee de la respuesta del depósito qué dio la plataforma por el código.
 * @param result  lo que devuelve giroxService.depositToUser
 * @returns { granted, amount, rule, wagerBalance, ruleBonus, unknown }
 *   - granted/amount/rule: saldo promocional otorgado (bloque promo_bonus status ok).
 *   - ruleBonus: la regla dio un BONO CLÁSICO (plata real) en vez de promocional.
 *   - unknown: respuesta `duplicate` sin detalle → no se sabe qué pasó la 1ª vez.
 */
function readPromoOutcome(result) {
  const out = { granted: false, amount: 0, rule: null, wagerBalance: null, ruleBonus: 0, unknown: false };
  if (!result || !result.success) return out;
  const d = result.data || {};
  const pb = result.promoBonus || d.promo_bonus || null;
  if (d.wager != null && Number.isFinite(Number(d.wager))) out.wagerBalance = Number(d.wager);
  if (pb && String(pb.status || '').toLowerCase() === 'ok' && Number(pb.amount) > 0) {
    out.granted = true;
    out.amount = Number(pb.amount);
    out.rule = pb.rule ? String(pb.rule).slice(0, 120) : null;
    return out;
  }
  const wb = d.wagering && d.wagering.bonus;
  if (wb && String(wb.status || '').toLowerCase() === 'ok' && Number(wb.amount) > 0) {
    out.ruleBonus = Number(wb.amount);
    return out;
  }
  if (result.duplicate && !pb) out.unknown = true;
  return out;
}

/**
 * Qué hacer DESPUÉS del depósito con código.
 * @param plan     lo que devolvió planDeposit (con wagerItem)
 * @param outcome  readPromoOutcome(result)
 * @param cfg      config
 * @returns { wagerKind, sideItems, sideTotal, pendingItems, ruleBonusKind, unknownKind }
 *   - wagerKind: kind entregado como wager (o null).
 *   - unknownKind: la plataforma respondió `duplicate` sin detalle (reintento de una carga
 *     que ya había entrado): NO se sabe si el promocional se otorgó la 1ª vez. Se da por
 *     ENTREGADO (se marca usado, sin respaldo) y se avisa al agente: dejarlo pendiente lo
 *     volvería a dar en la próxima carga encima del que quizá ya recibió.
 *   - sideItems/sideTotal: bonos NORMALES a acreditar en la operación aparte.
 *   - pendingItems: no entregados (quedan pendientes).
 *   - ruleBonusKind: kind que la plataforma ya entregó como bono clásico.
 */
function resolveOutcome(plan, outcome, cfg) {
  const out = { wagerKind: null, sideItems: [], sideTotal: 0, pendingItems: [], ruleBonusKind: null, unknownKind: null };
  if (!plan) return out;
  (plan.normalItems || []).forEach((it) => out.sideItems.push(it));
  (plan.skippedItems || []).forEach((it) => out.pendingItems.push(it));
  const w = plan.wagerItem;
  if (w) {
    if (outcome && outcome.granted) out.wagerKind = w.kind;
    else if (outcome && outcome.ruleBonus > 0) out.ruleBonusKind = w.kind;
    else if (outcome && outcome.unknown) out.unknownKind = w.kind; // duplicate sin detalle: se da por entregado (no arriesgar un doble bono)
    else if (cfg && cfg.fallback === 'skip') out.pendingItems.push(w);
    else out.sideItems.push(w);
  }
  out.sideTotal = out.sideItems.reduce((s, it) => s + (Number(it.amount) || 0), 0);
  return out;
}

module.exports = {
  FLOWS, FLOW_LABELS, KINDS, FALLBACKS, MAX_CODES,
  defaultConfig, normalizeConfig, validateConfig, normalizeCodeRow,
  flowIsWager, findCode, pickCode, estimateWager,
  planDeposit, readPromoOutcome, resolveOutcome
};
