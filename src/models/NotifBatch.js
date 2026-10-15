// ============================================================================
// NotifBatch — LOTE DE NOTIFICACIONES CON REGALO (2026-08-14)
// ============================================================================
// Un "lote" es un envío masivo (o un código público) con un regalo asociado:
//   - giftType 'percent': % EXTRA en la próxima carga → al activarse crea un
//     PromoBonus (cartel verde) y LO APLICA EL AGENTE en la carga.
//   - giftType 'fixed': fichas — SIEMPRE se acreditan AUTOMÁTICAS por API
//     (por código al canjear; por tiempo al enviarse el lote).
// Modos:
//   - 'code':   el destinatario canjea un código (una vez por cuenta).
//   - 'window': el regalo aplica a todos desde el envío (claimedAt = sentAt).
// El envío NO vive en la request: el motor de server.js procesa `recipients`
// con claim atómico por destinatario (multi-instancia EB safe) y es REANUDABLE
// tras un deploy/reinicio (sendDone marca el cierre).
const mongoose = require('mongoose');

const recipientSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  username: { type: String, required: true },
  // Capacidad de notificación AL MOMENTO del envío:
  // 'app' = token FCM standalone; 'browser' = algún token; 'none' = sin tokens.
  channel: { type: String, enum: ['app', 'browser', 'none'], default: 'none' },
  // Entrega de la notificación: null = pendiente; 'sending' = una instancia lo
  // está procesando (claim del motor; si queda colgado >10 min se re-reclama);
  // 'socket'/'push' = entregado; 'none' = sin canal; 'error' = todos los push
  // fallaron.
  delivery: { type: String, enum: [null, 'sending', 'socket', 'push', 'none', 'error'], default: null },
  deliveryAt: { type: Date, default: null },
  // Canje: en mode 'code' se setea al canjear; en 'window' = sentAt.
  claimedAt: { type: Date, default: null },
  // Solo regalos % — id del PromoBonus creado al activarse.
  promoBonusId: { type: String, default: null },
  // Solo fichas auto-acreditadas.
  creditedAt: { type: Date, default: null },
  creditTxId: { type: String, default: null },
  creditError: { type: String, default: null }
}, { _id: false });

const notifBatchSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
  // Etiqueta para el historial ("Lote de AGENTE — <name>").
  name: { type: String, default: '', trim: true, maxlength: 60 },
  mode: { type: String, enum: ['code', 'window'], required: true },
  giftType: { type: String, enum: ['percent', 'fixed'], required: true },
  // % (1..200) o $ (1..500000) según giftType.
  amount: { type: Number, required: true, min: 1 },
  // Fichas: rollover del bono auto-acreditado (0 = libre). #191: también el % AUTOMÁTICO
  // (va como bonus_multiplier de la carga). Si el rollover GLOBAL está encendido, lo pisa.
  rolloverX: { type: Number, default: 0, min: 0 },
  // #191 (portado del gemelo #149/#263): APLICACIÓN del % — 'auto' = el sistema lo suma
  // SOLO en la carga (manual sin bonus del agente / hgcash), sin cartel que marcar;
  // 'agent' = flujo viejo (cartel verde + "Marcar usado"). Lotes viejos → 'agent'.
  applyMode: { type: String, enum: ['agent', 'auto'], default: 'agent' },
  // 'first' = solo la primera carga; 'all' = TODAS las cargas hasta expiresAt.
  applyScope: { type: String, enum: ['first', 'all'], default: 'first' },
  // Franja horaria diaria (minutos del día, hora argentina) del % automático. null = siempre.
  applyFromMin: { type: Number, default: null },
  applyToMin: { type: Number, default: null },
  // #CAP TOPE PROPIO del % de ESTE lote (sólo % automático): el % completo aplica hasta `capARS`
  // y el excedente de la carga va al `capExcessPct`. null = tope global; capARS 0 = sin tope.
  capARS: { type: Number, default: null },
  capExcessPct: { type: Number, default: null },
  // #173: en modo 'code' con % — horas que tiene el cliente para USAR el bono DESPUÉS de
  // canjearlo (default 24). Vencido ese plazo el PromoBonus queda 'expired' aunque el lote
  // siga vigente para canjear.
  useHours: { type: Number, default: 24, min: 1 },
  // #177: FICHAS POR TIEMPO con RECLAMO. true = al enviar NO se acredita a nadie: cada
  // cliente toca "🎁 RECLAMAR" en la app (card del home + modal 🎁) y recién ahí se
  // acreditan, mientras el lote esté vigente. false (o lotes viejos) = directo al enviar.
  claimRequired: { type: Boolean, default: false },
  // Solo mode 'code'.
  code: { type: String, default: null, uppercase: true, trim: true, index: true },
  // Código PÚBLICO (Telegram/redes): cualquiera canjea, con cupo opcional.
  isPublic: { type: Boolean, default: false },
  maxClaims: { type: Number, default: null },
  // UN solo reloj por lote: expiresAt = sentAt + validHours.
  validHours: { type: Number, required: true, min: 1 },
  sentAt: { type: Date, default: Date.now, index: true },
  expiresAt: { type: Date, required: true, index: true },
  title: { type: String, default: '', trim: true, maxlength: 100 },
  message: { type: String, default: '', maxlength: 500 },
  sentBy: { type: String, default: null },
  sentByRole: { type: String, default: null },
  // 'segment' (#191): filtro fino (base sin entrar / sin cargar / cargaron hace poco +
  // mín. cargas + mín. $ + publicista + cupo) — el filtro exacto en audienceFilter y su
  // texto legible en audienceLabel.
  audienceType: { type: String, enum: ['list', 'inactive', 'all', 'public', 'segment'], required: true },
  audienceDays: { type: Number, default: null },
  audienceLimit: { type: Number, default: null },
  audienceFilter: { type: mongoose.Schema.Types.Mixed, default: null },
  audienceLabel: { type: String, default: '' },
  // Motor de envío: true cuando no queda ningún recipient pendiente.
  sendDone: { type: Boolean, default: false, index: true },
  recipients: { type: [recipientSchema], default: [] }
}, { timestamps: true });

notifBatchSchema.index({ mode: 1, code: 1, expiresAt: -1 });
notifBatchSchema.index({ 'recipients.userId': 1 });

module.exports = mongoose.models['NotifBatch'] || mongoose.model('NotifBatch', notifBatchSchema);
