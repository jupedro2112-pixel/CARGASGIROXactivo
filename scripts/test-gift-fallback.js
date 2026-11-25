// #236 Regalo que no puede salir como bono con rollover: por defecto va como BONO sin rollover (nunca como depósito,
// que 1girox muestra como Carga). En frío: se simula la API de 1girox.   node scripts/test-gift-fallback.js
const assert = require('assert');
const path = require('path');
const Module = require('module');
process.env.GIROX_API_URL = 'https://api.prueba.test/v1'; process.env.GIROX_API_KEY = 'k-prueba'; delete process.env.GIROX_GIFT_AS_BONUS;
const calls = [];
const state = { bonusLocked: 0, cfg: { bonus: { enabled: true, standalone_enabled: true, multipliers: [0, 3, 5], fixed_min: 2, fixed_max: 500000 } }, bonusFail: null };
const origLoad = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === 'axios') {
    return async ({ method, url, data }) => {
      const p = url.replace(process.env.GIROX_API_URL, ''); const m = String(method).toLowerCase();
      calls.push({ m, p, data });
      if (m === 'get' && p === '/config') return { status: 200, data: state.cfg };
      if (m === 'get' && /^\/players\/[^/]+$/.test(p)) return { status: 200, data: { player: { username: 'jug', balance: 1000, wagering: { available: 1000, locked: state.bonusLocked, bonus_locked: state.bonusLocked, claimable_total: 0 } } } };
      if (m === 'post' && /\/bonus$/.test(p)) {
        if (state.bonusFail && data.multiplier > 0) { const e = new Error('422'); e.response = { status: 422, data: { error: { code: state.bonusFail, message: 'x' }, code: state.bonusFail } }; throw e; }
        return { status: 200, data: { operation: { ledger_id: 77, reference: data.reference, type: 'bonus' } } };
      }
      if (m === 'post' && /\/deposit$/.test(p)) return { status: 200, data: { operation: { ledger_id: 88, reference: data.reference, type: 'deposit' } } };
      return { status: 200, data: {} };
    };
  }
  if (/utils\/logger$/.test(req)) return { warn() {}, info() {}, error() {}, debug() {} };
  return origLoad.call(this, req, parent, ...rest);
};
const girox = require(path.join(__dirname, '..', 'src/services/giroxService'));
let mode = undefined;
girox.setRolloverResolver(async () => 3);          // rollover GLOBAL x3 encendido
girox.setGiftFallbackResolver(async () => mode);
const posts = () => calls.filter((c) => c.m === 'post').map((c) => c.p.split('/').pop() + (c.data.multiplier != null ? ':x' + c.data.multiplier : ''));
const reset = (o) => { calls.length = 0; Object.assign(state, { bonusLocked: 0, bonusFail: null }, o || {}); };

(async () => {
  let n = 0; const ok = (t) => { n++; console.log('  ✅ ' + t); };

  reset(); mode = undefined;
  let r = await girox.creditUserBalance('jug', 1000, 'vip-rf-1', { giftFlow: 'refund' });
  assert.ok(r.success); assert.deepStrictEqual(posts(), ['bonus:x3']); assert.strictEqual(r.creditedAs, 'bonus'); assert.strictEqual(r.rolloverApplied, 3);
  ok('sin bono activo: sale como bono con el rollover global (igual que antes)');

  reset({ bonusLocked: 5000 }); mode = undefined;
  r = await girox.creditUserBalance('jug', 1000, 'vip-rf-2', { giftFlow: 'refund' });
  assert.ok(r.success); assert.deepStrictEqual(posts(), ['bonus:x0'], 'no tiene que ir a /deposit');
  assert.strictEqual(r.creditedAs, 'bonus'); assert.strictEqual(r.rolloverApplied, 0); assert.ok(/bono activo/.test(r.fallbackReason));
  ok('jugador CON bono activo: sale como BONO sin rollover — nunca como depósito');

  reset({ bonusLocked: 5000 }); mode = 'bonus0';
  r = await girox.creditGift('jug', 500, { rolloverX: 5, reference: 'vip-roulette-1', description: 'Premio ruleta' });
  assert.deepStrictEqual(posts(), ['bonus:x0']); assert.strictEqual(r.creditedAs, 'bonus');
  ok('ruleta / fueguito (creditGift) con bono activo: también bono sin rollover');

  reset({ bonusLocked: 5000 }); mode = 'deposit';
  r = await girox.creditUserBalance('jug', 1000, 'vip-rf-3', { giftFlow: 'refund' });
  assert.ok(r.success); assert.deepStrictEqual(posts(), ['deposit:x3']); assert.strictEqual(r.creditedAs, 'deposit'); assert.strictEqual(r.rolloverApplied, 3); assert.ok(r.fallbackReason);
  ok('opción del panel "depósito con rollover": se comporta como antes y avisa que fue depósito');

  reset({ bonusFail: 'bonus_out_of_range' }); mode = undefined;
  r = await girox.creditUserBalance('jug', 1000, 'vip-rf-4', { giftFlow: 'refund' });
  assert.ok(r.success); assert.deepStrictEqual(posts(), ['bonus:x3', 'bonus:x0']); assert.strictEqual(r.creditedAs, 'bonus');
  assert.strictEqual(calls.filter((c) => c.m === 'post')[0].data.reference, calls.filter((c) => c.m === 'post')[1].data.reference, 'misma reference en los dos intentos');
  ok('la plataforma rechaza el bono con rollover: reintenta como bono sin rollover con la MISMA reference');

  reset({ bonusLocked: 5000 }); mode = undefined;
  r = await girox.creditUserBalance('jug', 1, 'vip-rf-5', { giftFlow: 'refund' });
  assert.ok(r.success); assert.deepStrictEqual(posts(), ['deposit']); assert.strictEqual(r.creditedAs, 'deposit');
  ok('único caso que sigue yendo a depósito: monto fuera de lo que 1girox acepta como bono (ej. $1) — queda marcado');

  reset(); mode = undefined;
  r = await girox.creditUserBalance('jug', 1000, 'vip-payoutref-bonus-1', { ignoreGlobalRollover: true });
  assert.deepStrictEqual(posts(), ['bonus:x0']);
  ok('devolución / comisión (sin rollover global): no cambia');

  console.log('\n✅ Todo OK (' + n + ')');
})().catch((e) => { console.error('❌ ' + (e && e.stack || e)); console.error(JSON.stringify(calls.slice(-6))); process.exit(1); });
