#!/usr/bin/env node
/**
 * Validación EN FRÍO del BONO NORMAL vs BONO WAGER (#226, Partner API v1.18 §2.8).
 * Sin DB ni API: la parte pura (src/utils/bonusKind.js) + chequeos ESTÁTICOS de que
 * el cliente de la API y los dos flujos de carga están cableados (lo que no se puede
 * ejecutar sin la plataforma).
 *
 *   node scripts/test-bonus-kind.js
 */
const fs = require('fs');
const path = require('path');
const bk = require('../src/utils/bonusKind');

let fails = 0;
function check(name, got, exp) {
  const ok = JSON.stringify(got) === JSON.stringify(exp);
  if (!ok) fails++;
  console.log(`${ok ? '✅' : '❌'} ${name} → ${JSON.stringify(got)}${ok ? '' : ` (esperado ${JSON.stringify(exp)})`}`);
}
const girox = fs.readFileSync(path.join(__dirname, '../src/services/giroxService.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const txModel = fs.readFileSync(path.join(__dirname, '../src/models/Transaction.js'), 'utf8');

console.log('== 1) CONFIG ==');
const d = bk.defaultConfig();
check('default: apagado, todo normal, sin códigos', [d.enabled, d.fallback, Object.values(d.flows).every((v) => v === 'normal'), d.codes.length], [false, 'normal', true, 0]);
check('normalizeConfig(null) = default', bk.normalizeConfig(null), d);
check('normalizeConfig descarta basura sin romper', bk.normalizeConfig({ enabled: 'si', fallback: 'x', flows: { install: 'wager', story: 'otro' }, codes: [{ code: 'ok 1', pct: 10 }, { code: 'W100', pct: 100 }, { code: 'w100', pct: 50 }, { code: 'X', pct: 5 }] }),
  { enabled: false, fallback: 'normal', flows: { install: 'wager', publisher: 'normal', roulette: 'normal', story: 'normal', lote: 'normal' }, codes: [{ code: 'W100', pct: 100, capArs: 0, label: '', enabled: true, oncePerPlayer: false }] });
let v = bk.validateConfig({ enabled: true, flows: { install: 'wager' }, codes: [{ code: 'W100', pct: 100, capArs: 5000 }] });
check('validateConfig OK', [v.ok, v.config.enabled, v.config.flows.install, v.config.codes[0].capArs, v.warnings.length], [true, true, 'wager', 5000, 0]);
check('validateConfig: código con espacios → error', bk.validateConfig({ codes: [{ code: 'mi codigo', pct: 10 }] }).ok, false);
check('validateConfig: % fuera de rango → error', bk.validateConfig({ codes: [{ code: 'A1', pct: 0 }] }).ok, false);
check('validateConfig: código repetido (sin importar mayúsculas) → error', bk.validateConfig({ codes: [{ code: 'AB', pct: 10 }, { code: 'ab', pct: 20 }] }).ok, false);
check('validateConfig: tipo de flujo inválido → error', bk.validateConfig({ flows: { install: 'promo' } }).ok, false);
check('validateConfig: activado sin códigos → aviso', bk.validateConfig({ enabled: true }).warnings.length, 1);
check('validateConfig: flujos en wager con el interruptor apagado → aviso', bk.validateConfig({ enabled: false, flows: { lote: 'wager' } }).warnings.length, 1);

console.log('\n== 2) ELECCIÓN DEL CÓDIGO ==');
const cfg = bk.normalizeConfig({ enabled: true, fallback: 'normal', flows: { install: 'wager', roulette: 'wager', lote: 'wager' },
  codes: [{ code: 'W100', pct: 100, capArs: 5000, oncePerPlayer: true }, { code: 'W100B', pct: 100 }, { code: 'W10', pct: 10 }, { code: 'OFF20', pct: 20, enabled: false }] });
check('pickCode por % exacto', bk.pickCode(cfg, 100, []).code, 'W100');
check('pickCode: "una vez por jugador" ya usado → el siguiente del mismo %', bk.pickCode(cfg, 100, ['w100']).code, 'W100B');
check('pickCode: sin código para ese % → null', bk.pickCode(cfg, 50, []), null);
check('pickCode: % EXACTO (9,6% no usa el código de 10%)', bk.pickCode(cfg, 9.6, []), null);
check('el bono del agente NO es un flujo configurable', bk.FLOWS.includes('agent'), false);
check('pickCode: código desactivado no se usa', bk.pickCode(cfg, 20, []), null);
check('pickCode: con el interruptor apagado → null', bk.pickCode(Object.assign({}, cfg, { enabled: false }), 100, []), null);
check('findCode case-insensitive, solo activos', [bk.findCode(cfg, 'w10').code, bk.findCode(cfg, 'OFF20'), bk.findCode(cfg, 'OFF20', { any: true }).code], ['W10', null, 'OFF20']);
check('estimateWager respeta el tope', [bk.estimateWager(cfg.codes[0], 3000), bk.estimateWager(cfg.codes[0], 20000), bk.estimateWager(cfg.codes[2], 20000)], [3000, 5000, 2000]);
check('flowIsWager', [bk.flowIsWager(cfg, 'install'), bk.flowIsWager(cfg, 'publisher'), bk.flowIsWager(Object.assign({}, cfg, { enabled: false }), 'install')], [true, false, false]);

console.log('\n== 3) PLAN DE UNA CARGA ==');
const install = { kind: 'install', pct: 100, amount: 5000 };
const roul10 = { kind: 'roulette', pct: 10, amount: 1000 };
const roul15 = { kind: 'roulette', pct: 15, amount: 1500 };
const pub = { kind: 'publisher', pct: 50, amount: 5000 };
let p = bk.planDeposit(cfg, [install], {});
check('instalar app en wager con código → wager, nada normal', [p.code.code, p.wagerItem.kind, p.normalTotal], ['W100', 'install', 0]);
p = bk.planDeposit(cfg, [install, roul10], {});
check('dos bonos en wager → UN código (el primero); el otro cae a normal', [p.code.code, p.wagerItem.kind, p.normalItems.map((i) => i.kind), p.normalTotal], ['W100', 'install', ['roulette'], 1000]);
p = bk.planDeposit(cfg, [pub, roul10], {});
check('publicista (normal) + ruleta (wager) → ruleta wager, publicista normal aparte', [p.code.code, p.wagerItem.kind, p.normalTotal], ['W10', 'roulette', 5000]);
p = bk.planDeposit(cfg, [roul15], {});
check('wager sin código para ese % + respaldo normal → sale normal (sin plan de wager)', [p.code, p.wagerItem, p.normalTotal, p.skippedItems.length], [null, null, 1500, 0]);
p = bk.planDeposit(Object.assign({}, cfg, { fallback: 'skip' }), [roul15, pub], {});
check('wager sin código + respaldo "no dar nada" → queda en espera, lo normal sale', [p.code, p.skippedItems.map((i) => i.kind), p.normalTotal], [null, ['roulette'], 5000]);
p = bk.planDeposit(Object.assign({}, cfg, { enabled: false }), [install, roul10], {});
check('interruptor apagado → todo normal (camino de siempre)', [p.code, p.normalTotal], [null, 6000]);
p = bk.planDeposit(cfg, [pub], {});
check('flujo en normal → todo normal', [p.code, p.normalTotal], [null, 5000]);

console.log('\n== 4) RESPUESTA DE 1girox Y QUÉ HACER DESPUÉS ==');
const okPromo = { success: true, duplicate: false, data: { wager: 20000, promo_bonus: { status: 'ok', amount: 20000, rule: 'Bienvenida 200%' } }, promoBonus: { status: 'ok', amount: 20000, rule: 'Bienvenida 200%' } };
const noPromo = { success: true, duplicate: false, data: {}, promoBonus: null };
const classic = { success: true, duplicate: false, data: { wagering: { bonus: { status: 'ok', amount: 1000 } } }, promoBonus: null };
const dup = { success: true, duplicate: true, data: {}, promoBonus: null };
let o = bk.readPromoOutcome(okPromo);
check('promo_bonus ok → otorgado', [o.granted, o.amount, o.rule, o.wagerBalance], [true, 20000, 'Bienvenida 200%', 20000]);
check('sin promo_bonus → no otorgado', [bk.readPromoOutcome(noPromo).granted, bk.readPromoOutcome(noPromo).unknown], [false, false]);
check('la regla dio bono CLÁSICO → ruleBonus', [bk.readPromoOutcome(classic).granted, bk.readPromoOutcome(classic).ruleBonus], [false, 1000]);
check('duplicate sin detalle → unknown', bk.readPromoOutcome(dup).unknown, true);
check('depósito fallido → nada', bk.readPromoOutcome({ success: false }).granted, false);
const plan2 = bk.planDeposit(cfg, [install, roul10], {});
let r = bk.resolveOutcome(plan2, bk.readPromoOutcome(okPromo), cfg);
check('otorgado: wager para instalar + ruleta normal aparte', [r.wagerKind, r.sideItems.map((i) => i.kind), r.sideTotal, r.pendingItems.length], ['install', ['roulette'], 1000, 0]);
r = bk.resolveOutcome(plan2, bk.readPromoOutcome(noPromo), cfg);
check('NO otorgado + respaldo normal → los dos como bono normal aparte', [r.wagerKind, r.sideTotal, r.pendingItems.length], [null, 6000, 0]);
r = bk.resolveOutcome(plan2, bk.readPromoOutcome(noPromo), Object.assign({}, cfg, { fallback: 'skip' }));
check('NO otorgado + "no dar nada" → instalar queda pendiente, ruleta normal', [r.wagerKind, r.sideTotal, r.pendingItems.map((i) => i.kind)], [null, 1000, ['install']]);
r = bk.resolveOutcome(plan2, bk.readPromoOutcome(classic), cfg);
check('la regla dio bono clásico → NO se da otro bono por ese ítem', [r.ruleBonusKind, r.sideItems.map((i) => i.kind), r.sideTotal], ['install', ['roulette'], 1000]);
r = bk.resolveOutcome(plan2, bk.readPromoOutcome(dup), cfg);
check('duplicate sin detalle → se da por ENTREGADO sin respaldo (no se duplica en la próxima carga)', [r.wagerKind, r.unknownKind, r.sideTotal, r.pendingItems.length], [null, 'install', 1000, 0]);

console.log('\n== 5) CABLEADO (estático) ==');
check('cliente: promo_code solo sin bono explícito', /if \(wagering\.promoCode && !\(body\.bonus_amount > 0 \|\| body\.bonus_percent > 0\)\) \{\s*body\.promo_code =/.test(girox), true);
check('cliente: expone promoBonus y el saldo wager', /out\.promoBonus = \(r\.data && r\.data\.promo_bonus\) \|\| null/.test(girox) && /wager: \(player\.wager != null/.test(girox), true);
check('cliente: getUserBalance devuelve wager', /wager: info\.wager != null \? info\.wager : null/.test(girox), true);
check('modelo: tipo de Transaction wager_bonus', /'roulette', 'wager_bonus'\]/.test(txModel), true);
check('carga manual: con plan de wager va SOLO el código', /_wg\s*\? \{ promoCode: _wg\.plan\.code\.code \}/.test(server), true);
check('carga manual: bono normal aparte con reference estable', /sideRef: `vip-depbonus-\$\{_depTxId\}`/.test(server), true);
check('carga del banco: con plan de wager va SOLO el código', /_hgWg \? \{ promoCode: _hgWg\.plan\.code\.code \}/.test(server), true);
check('carga del banco: bono normal aparte con reference del movimiento', /sideRef: `vip-hgb-\$\{chargeKey \|\| movement\.movementId\}`/.test(server), true);
check('el wager NO se guarda como bono real de la carga', /wagerBonus: \{ amount: _wgOut\.wagerAmount/.test(server) && /wagerBonus: \{ amount: _hgWgOut\.wagerAmount/.test(server), true);
check('settle: solo los bonos entregados (ctx.kinds)', /const _kOk = \(k\) => !_kinds \|\| _kinds\.includes\(k\);/.test(server), true);
check('resumen de Transacciones: wager fuera de gifts', /case 'wager_bonus': wagers = g\.total; break;/.test(server) && !/const gifts = [^;]*wagers/.test(server), true);
check('endpoints GET/POST /api/admin/bonus-kind', /app\.get\('\/api\/admin\/bonus-kind'/.test(server) && /app\.post\('\/api\/admin\/bonus-kind'/.test(server), true);
check('mensaje editable /sys_wager_bonus sembrado', /name: '\/sys_wager_bonus'/.test(server), true);
check('la base del reembolso en vivo NO incluye wager_bonus', /CASHBACK_GIFT_TX_TYPES = \[[^\]]*wager_bonus/.test(server), false);

console.log(fails ? `\n❌ ${fails} caso(s) fallaron` : '\n✅ Todos los casos del bono wager dan lo esperado');
process.exit(fails ? 1 : 0);
