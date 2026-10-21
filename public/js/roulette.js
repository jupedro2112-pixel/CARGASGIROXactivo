// =====================================================================
// RULETA DIARIA — 1 giro/día por user con PWA + notifs activadas
// =====================================================================
// Flujo:
//   1) Al cargar el home, fetch /api/roulette/status
//      - si NO elegible (sin FCM token) → no muestra nada
//      - si elegible y ya giró HOY → card mostrando resultado de hoy
//      - si elegible y NO giró → card "GIRAR LA RULETA"
//   2) Click "GIRAR" → abre modal con animación de ruleta, llama
//      POST /api/roulette/spin, muestra premio. Si gana, JUGAYGANA ya
//      acreditó server-side automático.
//   3) Transparencia: tabla de probabilidades visible en el modal
//      ("el premio más grande es el menos probable").
// =====================================================================
(function () {
    'use strict';
    window.VIP = window.VIP || {};

    let _state = null; // { eligible, alreadySpun, spin, prizes }
    let _spinning = false;

    function _esc(s) {
        const d = document.createElement('div');
        d.textContent = String(s == null ? '' : s);
        return d.innerHTML;
    }
    function _fmt(n) { return Number(n || 0).toLocaleString('es-AR'); }
    // #206 "Xh Ym" hasta una fecha ISO ('' si ya pasó / no hay).
    function _countdown(iso) {
        if (!iso) return '';
        const ms = new Date(iso).getTime() - Date.now();
        if (!(ms > 0)) return '';
        const h = Math.floor(ms / 3600000), m = Math.max(1, Math.ceil((ms % 3600000) / 60000));
        return (h > 0 ? h + ' h ' : '') + m + ' min';
    }

    async function loadStatus() {
        if (!VIP.state || !VIP.state.currentToken) return;
        try {
            const r = await fetch(`${VIP.config.API_URL}/api/roulette/status`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (!r.ok) return;
            const d = await r.json();
            if (!d || !d.success) return;
            _state = d;
            renderHomeCard();
        } catch (e) { /* best-effort */ }
    }

    function renderHomeCard() {
        const c = document.getElementById('rouletteHomeCard');
        if (!c) return;
        if (!_state || !_state.eligible) {
            // #188/#206: si le faltan cargas, se muestra la celda BLOQUEADA con lo que
            // le falta (antes desaparecía y el cliente no sabía por qué). Con la
            // ruleta APAGADA en el panel (enabled:false) no se muestra nada.
            const _min = Number(_state && (_state.minDeposits != null ? _state.minDeposits : _state.minCargas)) || 0;
            const _have = Number(_state && (_state.deposits != null ? _state.deposits : _state.cargas30d)) || 0;
            const _days = Number(_state && _state.depositDays) || 0;
            if (_state && _state.enabled !== false && (_state.needsDeposit || _state.needsActive) && _min > 0) {
                const faltan = Math.max(1, _min - _have);
                const _msg = '🎰 Para girar la ruleta diaria necesitás ' + _min + ' carga' + (_min === 1 ? '' : 's') + (_days > 0 ? ' en los últimos ' + _days + ' días' : '') + ' (llevás ' + _have + '). Cargá y girás gratis.';
                c.innerHTML = '<div class="dash-roulette" style="opacity:.55;" onclick="VIP.ui&&VIP.ui.showToast&&VIP.ui.showToast(\'' + _msg.replace(/'/g, '') + '\',\'info\')">'
                    + '<span class="dash-roulette-avatar">🔒</span>'
                    + '<span class="dash-roulette-label">RULETA</span>'
                    + '<span class="dash-roulette-sub">Faltan ' + faltan + ' carga' + (faltan === 1 ? '' : 's') + '</span>'
                    + '</div>';
                c.style.display = '';
            } else {
                c.style.display = 'none';
                c.innerHTML = '';
            }
            // Ocultar tambien el card separado por si quedo de antes.
            const sep = document.getElementById('rouletteRecentWinnersCard');
            if (sep) sep.style.display = 'none';
            return;
        }

        const spin = _state.spin;
        // Celda compacta con el mismo formato que el recuadro de usuario
        // (avatar dorado + etiqueta + estado). Tap → modal de spin.
        let subText;
        if (_state.alreadySpun && spin) {
            const won = Number(spin.prizeARS || 0) > 0;
            if (spin.prizeType === 'percent' && Number(spin.prizePct) > 0) {
                // #206: el % vale 24 h desde el giro.
                const _cd = _state.pendingPct > 0 ? _countdown(_state.pendingExpiresAt) : '';
                subText = spin.status === 'percent_used' ? '% ya aplicado' : (spin.status === 'percent_expired' || (!_cd && !(_state.pendingPct > 0))) ? '% vencido' : ('+' + spin.prizePct + '%' + (_cd ? ' · vence ' + _cd : ''));
            } else if (won && spin.status === 'credited') {
                subText = 'Ganaste $' + _fmt(spin.prizeARS);
            } else if (won && spin.status === 'credit_failed') {
                subText = 'Escribinos';
            } else {
                const _cd = _countdown(_state.nextResetAt);
                subText = _cd ? ('Girás en ' + _cd) : 'Volvé a girar';
            }
        } else {
            subText = '¡GIRÁ HOY!';
        }

        c.innerHTML = '<div class="dash-roulette" onclick="VIP.roulette && VIP.roulette.open()">'
            + '<span class="dash-roulette-avatar">🎰</span>'
            + '<span class="dash-roulette-label">RULETA</span>'
            + '<span class="dash-roulette-sub">' + _esc(subText) + '</span>'
            + '</div>';
        c.style.display = '';

        // Ocultamos el card SEPARADO (el viejo).
        const sep = document.getElementById('rouletteRecentWinnersCard');
        if (sep) sep.style.display = 'none';
    }


    // Modal que se abre cuando el server rebota el giro porque al user
    // le faltan los pasos (app instalada o notifs). Detecta plataforma y
    // muestra el siguiente paso concreto + CTA.
    function _showNeedsAppModal() {
        const inApp = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
                       window.navigator.standalone === true;
        const notifPerm = (typeof Notification !== 'undefined') ? Notification.permission : 'default';

        document.getElementById('rouletteNeedsAppModal')?.remove();
        const overlay = document.createElement('div');
        overlay.id = 'rouletteNeedsAppModal';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:99998;display:flex;align-items:flex-start;justify-content:center;padding:14px;overflow-y:auto;-webkit-overflow-scrolling:touch;';
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

        let b1, b2, b3, ctaTxt, ctaAction;
        if (!inApp) {
            b1 = '⏳'; b2 = '⏳'; b3 = '⏳';
            ctaTxt = '📲 INSTALAR LA APP AHORA';
            ctaAction = 'window.VIP&&VIP.ui&&VIP.ui.installApp&&VIP.ui.installApp();document.getElementById(\'rouletteNeedsAppModal\').remove();';
        } else if (notifPerm !== 'granted') {
            b1 = '✅'; b2 = '✅'; b3 = '⏳';
            ctaTxt = '🔔 ACTIVAR NOTIFICACIONES';
            ctaAction = '(async()=>{try{const p=await Notification.requestPermission();if(p===\'granted\')VIP.ui.showToast(\'✅ Listo, tocá GIRAR de nuevo\',\'success\');}catch(_){}document.getElementById(\'rouletteNeedsAppModal\').remove();})();';
        } else {
            b1 = '✅'; b2 = '✅'; b3 = '⚠️';
            ctaTxt = '🔄 REFRESCAR';
            ctaAction = 'location.reload();';
        }

        overlay.innerHTML =
            '<div style="background:linear-gradient(180deg,#1a0033,#0a001a);border:2.5px solid #ffd700;border-radius:18px;padding:22px 18px;max-width:440px;width:100%;color:#fff;margin:16px auto;box-shadow:0 0 40px rgba(255,215,0,0.40);">' +
                '<div style="text-align:center;font-size:54px;line-height:1;margin-bottom:6px;">🎰</div>' +
                '<div style="text-align:center;color:#ffd700;font-weight:900;font-size:17px;letter-spacing:1px;margin-bottom:4px;">Para girar la ruleta</div>' +
                '<div style="text-align:center;color:#fff;font-size:13.5px;line-height:1.55;margin-bottom:14px;">Necesitamos asegurarnos que sos vos. Para participar tenés que tener <strong>la app instalada con notificaciones activas</strong>.</div>' +
                '<div style="background:rgba(255,215,0,0.06);border:1px dashed rgba(255,215,0,0.45);border-radius:12px;padding:14px;margin-bottom:14px;">' +
                    '<div style="color:#ffd700;font-weight:900;font-size:11px;letter-spacing:1.5px;text-align:center;margin-bottom:10px;">🧭 SEGUÍ ESTOS 3 PASOS</div>' +
                    '<div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:9px;"><div style="flex-shrink:0;width:30px;height:30px;border-radius:50%;background:rgba(255,215,0,0.15);border:1.5px solid #ffd700;color:#ffd700;font-weight:900;display:flex;align-items:center;justify-content:center;">' + b1 + '</div><div style="flex:1;font-size:12.5px;line-height:1.5;"><strong>Instalá la app</strong> en tu celular (Android: 1 toque · iPhone: video paso a paso).</div></div>' +
                    '<div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:9px;"><div style="flex-shrink:0;width:30px;height:30px;border-radius:50%;background:rgba(255,215,0,0.15);border:1.5px solid #ffd700;color:#ffd700;font-weight:900;display:flex;align-items:center;justify-content:center;">' + b2 + '</div><div style="flex:1;font-size:12.5px;line-height:1.5;"><strong>Abrí la app desde el ícono</strong> nuevo de tu pantalla — no desde Chrome.</div></div>' +
                    '<div style="display:flex;gap:10px;align-items:flex-start;"><div style="flex-shrink:0;width:30px;height:30px;border-radius:50%;background:rgba(255,215,0,0.15);border:1.5px solid #ffd700;color:#ffd700;font-weight:900;display:flex;align-items:center;justify-content:center;">' + b3 + '</div><div style="flex:1;font-size:12.5px;line-height:1.5;"><strong>Aceptá las notificaciones</strong> cuando te lo pida la app. Después tocá GIRAR.</div></div>' +
                '</div>' +
                (!inApp ? '<div style="background:rgba(37,211,102,0.10);border:1px solid #25d366;border-radius:10px;padding:9px 11px;margin-bottom:12px;text-align:center;font-size:12px;color:#aaffaa;">🎁 <strong style="color:#ffd700;">Bonus:</strong> al instalar la app te llevás un <strong style="color:#ffd700;">' + _esc(_installBonusShort()) + '</strong> en tu próxima carga.</div>' : '') +
                '<button onclick="' + ctaAction + '" style="width:100%;background:linear-gradient(135deg,#ffd700,#ff8800);color:#000;border:none;padding:13px;border-radius:11px;font-weight:900;font-size:14px;cursor:pointer;letter-spacing:0.5px;margin-bottom:8px;box-shadow:0 4px 14px rgba(255,215,0,0.40);">' + ctaTxt + '</button>' +
                '<button onclick="document.getElementById(\'rouletteNeedsAppModal\').remove();" style="width:100%;background:transparent;color:#aaa;border:1px solid rgba(255,255,255,0.20);padding:10px;border-radius:9px;font-weight:700;font-size:12px;cursor:pointer;">Cerrar</button>' +
            '</div>';
        document.body.appendChild(overlay);
    }

    // Card que aparece cuando el user ganó: lo invita a la comunidad para
    // recibir novedades (problemas de página, juegos de la semana,
    // problemas con el banco) y le aclara qué hacer si su WhatsApp
    // principal no funciona — revisar el número vigente en el home.
    function _communityRecommendCard() {
        const link = (window.VIP && VIP.state && VIP.state.communityLink) || '';
        const link2 = (window.VIP && VIP.state && VIP.state.communityLink2) || '';
        const label1 = (window.VIP && VIP.state && VIP.state.communityLabel) || 'COMUNIDAD 1';
        const label2 = (window.VIP && VIP.state && VIP.state.communityLabel2) || 'COMUNIDAD 2';

        let buttons = '';
        if (link) {
            buttons += '<a href="' + _esc(link) + '" target="_blank" rel="noopener" onclick="window.VIP&&VIP.communityClick&&VIP.communityClick(\'home_button\',\'' + _esc(link) + '\')" style="display:flex;align-items:center;gap:9px;background:linear-gradient(135deg,#25d366,#128c7e);color:#fff;text-decoration:none;padding:11px 13px;border-radius:10px;font-weight:900;font-size:13.5px;margin-bottom:8px;box-shadow:0 3px 10px rgba(37,211,102,0.40);">' +
                '<span style="font-size:18px;">💬</span>' +
                '<span style="flex:1;text-align:left;">ENTRAR A ' + _esc(label1.toUpperCase()) + '</span>' +
                '<span style="font-size:14px;">›</span>' +
            '</a>';
        }
        if (link2) {
            buttons += '<a href="' + _esc(link2) + '" target="_blank" rel="noopener" onclick="window.VIP&&VIP.communityClick&&VIP.communityClick(\'home_button_2\',\'' + _esc(link2) + '\')" style="display:flex;align-items:center;gap:9px;background:linear-gradient(135deg,#00d4ff,#0080ff);color:#000;text-decoration:none;padding:11px 13px;border-radius:10px;font-weight:900;font-size:13.5px;margin-bottom:8px;box-shadow:0 3px 10px rgba(0,212,255,0.35);">' +
                '<span style="font-size:18px;">💬</span>' +
                '<span style="flex:1;text-align:left;">ENTRAR A ' + _esc(label2.toUpperCase()) + '</span>' +
                '<span style="font-size:14px;">›</span>' +
            '</a>';
        }
        if (!buttons) return '';

        let html = '<div style="background:linear-gradient(135deg,rgba(34,160,217,0.14),rgba(0,136,204,0.08));border:1.5px dashed rgba(34,160,217,0.55);border-radius:13px;padding:13px;margin-bottom:12px;">';
        html += '<div style="color:#22a0d9;font-weight:900;font-size:12px;letter-spacing:0.8px;text-align:center;margin-bottom:6px;">📢 UNITE A NUESTRA NUEVA COMUNIDAD</div>';
        html += '<div style="color:#fff;font-size:12.5px;line-height:1.5;margin-bottom:10px;text-align:center;">Nos mudamos a <strong>Telegram</strong> — ya no usamos WhatsApp. Sumate al canal privado para enterarte de <strong>códigos, novedades, juegos de la semana</strong> y todo lo que liberamos.</div>';
        html += buttons;
        html += '<div style="background:rgba(255,170,102,0.10);border-left:3px solid #ffaa66;border-radius:0 7px 7px 0;padding:7px 10px;margin-top:6px;color:#ffd0a0;font-size:11.5px;line-height:1.4;">⚠️ Si nuestro <strong>WhatsApp principal</strong> no te funciona, revisá el número vigente abajo en el home.</div>';
        html += '</div>';
        return html;
    }

    // #188 texto corto de la regla del bono por instalar (viene de installbonus.js).
    function _installBonusShort() {
        const r = (window.VIP && VIP.state && VIP.state.installBonusRule) || null;
        if (!r) return '100% de bono';
        return r.pct + '% de bono' + (r.capArs > 0 ? ' (hasta $' + _fmt(r.capArs) + (r.excessPct > 0 ? ', +' + r.excessPct + '% sobre el resto' : '') + ')' : '');
    }

    function open() {
        const modal = document.getElementById('rouletteModal');
        if (!modal) return;
        if (!_state) { loadStatus(); }
        _renderModal();
        modal.style.display = 'flex';
    }

    function close() {
        const modal = document.getElementById('rouletteModal');
        if (modal) modal.style.display = 'none';
    }

    function _renderModal(spinResult) {
        const modal = document.getElementById('rouletteModal');
        if (!modal) return;
        if (!_state) {
            modal.innerHTML = '<div style="background:#1a0033;border:2px solid #d4af37;border-radius:14px;padding:30px;color:#fff;text-align:center;max-width:560px;width:100%;margin:14px auto;">⏳ Cargando…</div>';
            return;
        }
        const spin = spinResult || _state.spin;
        const alreadySpun = !!(spin && (spin.prizeARS != null || spin.prizeType));
        let html = '<div style="background:linear-gradient(180deg,#1a0033,#0a001a);border:2px solid #ffd700;border-radius:16px;padding:20px 16px;color:#fff;max-width:560px;width:100%;margin:14px auto;position:relative;">';
        html += '<button onclick="VIP.roulette.close()" style="position:absolute;top:10px;right:10px;background:rgba(0,0,0,0.55);border:1px solid rgba(255,255,255,0.20);color:#fff;font-size:18px;cursor:pointer;line-height:1;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;">✕</button>';
        html += '<h2 style="color:#ffd700;text-align:center;margin:0 0 4px;font-size:22px;font-weight:900;letter-spacing:1.5px;padding-right:36px;">🎰 RULETA DIARIA</h2>';
        html += '<p style="color:#ddd;text-align:center;margin:0 0 14px;font-size:12px;line-height:1.4;">1 giro cada 24 h · el saldo se acredita solo · los % EXTRA valen 24 h</p>';

        if (alreadySpun) {
            // Estado: ya giró hoy.
            const won = Number(spin.prizeARS || 0) > 0;
            if (spin.prizeType === 'percent' && Number(spin.prizePct) > 0) {
                // #188/#206 premio BONIFICACIÓN: +X% en la próxima carga. Lo aplica el
                // SISTEMA solo en la carga y vale 24 h desde el giro (réplica #305).
                const used = spin.status === 'percent_used';
                const _exp = spin.expiresAt || (_state.pendingPct > 0 ? _state.pendingExpiresAt : null);
                const _cd = _countdown(_exp);
                const expired = spin.status === 'percent_expired' || (!used && !_cd && !(_state.pendingPct > 0 && spinResult));
                html += '<div id="rouletteResultBox" style="background:linear-gradient(135deg,rgba(255,215,0,0.12),rgba(102,255,102,0.08));border:2px solid ' + (expired ? '#888' : '#ffd700') + ';border-radius:14px;padding:24px 16px;text-align:center;margin-bottom:12px;">';
                html += '<div style="font-size:60px;line-height:1;margin-bottom:8px;">' + (expired ? '⌛' : '🎁') + '</div>';
                html += '<div style="color:#ffd700;font-size:13px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">' + (expired ? 'PREMIO VENCIDO' : '¡GANASTE!') + '</div>';
                html += '<div style="color:#fff;font-size:30px;font-weight:900;margin-bottom:6px;">+' + _esc(spin.prizePct) + '% EXTRA</div>';
                html += '<div style="color:#ffd479;font-size:13px;font-weight:800;">en tu PRÓXIMA CARGA</div>';
                if (used) {
                    html += '<div style="background:rgba(102,255,102,0.20);border:1px solid #66ff66;border-radius:8px;padding:9px 12px;margin-top:10px;color:#fff;font-size:12.5px;font-weight:800;">✅ Ya se aplicó en una carga</div>';
                } else if (expired) {
                    html += '<div style="background:rgba(136,136,136,0.18);border:1px solid #888;border-radius:8px;padding:9px 12px;margin-top:10px;color:#ddd;font-size:12.5px;line-height:1.45;">Pasaron 24 h sin cargar y el % se perdió. Volvé a girar y probá de nuevo 🎰</div>';
                } else {
                    html += '<div style="background:rgba(255,215,0,0.14);border:1px solid rgba(255,215,0,0.6);border-radius:8px;padding:9px 12px;margin-top:10px;color:#fff;font-size:12.5px;line-height:1.45;">Se aplica <strong>solo</strong> en tu próxima carga: te sumamos el <strong>' + _esc(spin.prizePct) + '%</strong> como bono, sin pedir nada.</div>';
                    html += '<div style="background:rgba(255,120,0,0.14);border:1px solid rgba(255,170,102,0.7);border-radius:8px;padding:8px 12px;margin-top:8px;color:#ffd0a0;font-size:12px;font-weight:800;">⏳ Reclamable por 24 horas: cargá antes de que venza' + (_cd ? ' (vence en ' + _esc(_cd) + ')' : '') + '.</div>';
                }
                html += '</div>';
            } else if (won && spin.status === 'credited') {
                html += '<div id="rouletteResultBox" style="background:linear-gradient(135deg,rgba(102,255,102,0.10),rgba(255,215,0,0.10));border:2px solid #66ff66;border-radius:14px;padding:24px 16px;text-align:center;margin-bottom:12px;">';
                html += '<div style="font-size:60px;line-height:1;margin-bottom:8px;">🎉</div>';
                html += '<div style="color:#66ff66;font-size:13px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">¡GANASTE!</div>';
                html += '<div style="color:#fff;font-size:32px;font-weight:900;margin-bottom:6px;">$' + _fmt(spin.prizeARS) + '</div>';
                html += '<div style="background:rgba(102,255,102,0.20);border:1px solid #66ff66;border-radius:8px;padding:9px 12px;margin-top:10px;color:#fff;font-size:13px;font-weight:800;">✅ Acreditado a tu saldo automáticamente</div>';
                // #186 rollover del premio (el global del panel, lo manda el server)
                if (Number(spin.rolloverX) > 0) html += '<div style="color:#ffd479;font-size:11.5px;margin-top:8px;line-height:1.4;">🎯 Rollover x' + spin.rolloverX + ': ya podés jugarlo; para retirarlo apostalo ' + spin.rolloverX + ' veces. Las apuestas en DEPORTES no suman.</div>';
                if (spin.creditTxId) html += '<div style="color:#888;font-size:10px;margin-top:6px;font-family:monospace;">tx: ' + _esc(spin.creditTxId) + '</div>';
                html += '</div>';

                // CTA comunidad — el owner pidió que recomendemos entrar al
                // grupo cuando ganen, para que reciban novedades, problemas
                // con la página, juegos de la semana, problemas con el banco.
                html += _communityRecommendCard();
            } else if (won && spin.status === 'credit_failed') {
                html += '<div style="background:rgba(255,170,102,0.10);border:2px solid #ffaa66;border-radius:14px;padding:20px 16px;text-align:center;margin-bottom:12px;">';
                html += '<div style="font-size:48px;margin-bottom:6px;">⚠️</div>';
                html += '<div style="color:#ffaa66;font-size:13px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">PREMIO PENDIENTE</div>';
                html += '<div style="color:#fff;font-size:24px;font-weight:900;margin-bottom:6px;">$' + _fmt(spin.prizeARS) + '</div>';
                html += '<div style="color:#ffd0a0;font-size:12px;margin-top:8px;">Ganaste pero la acreditación automática falló. Escribinos por WhatsApp al número principal y te lo cargamos.</div>';
                html += '</div>';
            } else {
                html += '<div style="background:rgba(0,0,0,0.30);border:1px solid rgba(255,255,255,0.20);border-radius:14px;padding:24px 16px;text-align:center;margin-bottom:12px;">';
                html += '<div style="font-size:54px;margin-bottom:6px;">😔</div>';
                html += '<div style="color:#aaa;font-size:13px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;">Hoy no fue tu día</div>';
                const _cdN = _countdown(_state.nextResetAt);
                html += '<div style="color:#ddd;font-size:14px;">' + (_cdN ? 'Volvés a girar en <strong>' + _esc(_cdN) + '</strong> 🎰' : 'Ya podés volver a girar 🎰') + '</div>';
                html += '</div>';
            }
            html += '<button onclick="VIP.roulette.close()" style="width:100%;background:rgba(255,255,255,0.08);color:#fff;border:1px solid rgba(255,255,255,0.20);padding:12px;border-radius:10px;font-weight:800;font-size:13px;cursor:pointer;">CERRAR</button>';
        } else {
            // Estado: aún no giró. Ícono 🎰 con animación + CTA. Sin tabla
            // de probabilidades (el reparto ahora es por monto diario).
            html += '<div id="rouletteResultBox" style="background:linear-gradient(135deg,#4a0080,#7c00cc);border:2px solid #ffd700;border-radius:14px;padding:28px 16px;text-align:center;margin-bottom:12px;box-shadow:inset 0 0 30px rgba(255,215,0,0.20);">';
            html += '<div style="font-size:72px;line-height:1;margin-bottom:6px;animation:rouletteIcon 2s ease-in-out infinite;">🎰</div>';
            html += '<div style="color:#ffd700;font-size:16px;font-weight:900;letter-spacing:1px;margin-bottom:4px;">Tu giro de hoy te espera</div>';
            html += '<div style="color:#fff;font-size:13px;margin-bottom:14px;opacity:0.92;">Tocá <strong>GIRAR</strong> y la suerte decide. El saldo se acredita solo; los % EXTRA se suman solos en tu próxima carga (valen 24 h).</div>';
            html += '<button id="rouletteSpinBtn" onclick="VIP.roulette.spin()" style="background:linear-gradient(135deg,#ffd700,#f7931e);color:#000;border:none;padding:16px 40px;border-radius:12px;font-weight:900;font-size:18px;cursor:pointer;letter-spacing:2px;box-shadow:0 4px 16px rgba(255,215,0,0.50);">🎰 GIRAR</button>';
            html += '</div>';
            // #188 premios y probabilidades vigentes (vienen del panel).
            const prizes = Array.isArray(_state.prizes) ? _state.prizes.filter(p => p && p.type !== 'none') : [];
            if (prizes.length) {
                html += '<div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-bottom:10px;">';
                for (const p of prizes) {
                    const txt = p.type === 'percent' ? ('+' + _esc(p.value) + '% EXTRA próx. carga') : ('$' + _fmt(p.value));
                    html += '<span style="background:rgba(255,215,0,0.10);border:1px solid rgba(255,215,0,0.40);border-radius:14px;padding:4px 9px;font-size:11px;color:#fff;font-weight:800;">' + _esc(p.emoji || '') + ' ' + txt + (p.pct != null ? ' <span style="color:#aaa;font-weight:600;">' + _esc(p.pct) + '%</span>' : '') + '</span>';
                }
                html += '</div>';
            }
            html += '<style>@keyframes rouletteIcon { 0%, 100% { transform: rotate(-10deg); } 50% { transform: rotate(10deg); } }</style>';
        }

        // Bloque de transparencia: ganadores del día (live), DENTRO del modal.
        // Cuando el user gana, esto le da contexto + social proof. Cuando
        // pierde, refuerza que la ruleta sí paga. Reusa el mismo cache que
        // el card del home y se sincroniza con auto-refresh.
        html += '<div style="margin-top:14px;background:rgba(0,0,0,0.50);border:1px solid rgba(255,215,0,0.30);border-radius:11px;padding:11px 12px;">';
        html += '  <div style="text-align:center;background:linear-gradient(135deg,rgba(37,211,102,0.18),rgba(255,215,0,0.12));border:1px solid rgba(37,211,102,0.45);border-radius:9px;padding:7px 10px;margin:0 0 9px;">';
        html += '    <div style="color:#25d366;font-weight:900;font-size:10.5px;letter-spacing:1.4px;line-height:1.25;">✨ TRANSPARENCIA ABSOLUTA</div>';
        html += '    <div style="color:#ffd700;font-weight:800;font-size:11.5px;letter-spacing:0.4px;line-height:1.25;">TODO PARA USTEDES</div>';
        html += '  </div>';
        html += '  <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;">';
        html += '    <span style="font-size:14px;">🏆</span>';
        html += '    <span style="color:#ffd700;font-weight:900;font-size:11px;letter-spacing:1px;">GANADORES DE HOY · EN VIVO</span>';
        html += '    <span style="margin-left:auto;display:inline-flex;align-items:center;gap:5px;font-size:10px;color:#25d366;font-weight:700;">';
        html += '      <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#25d366;box-shadow:0 0 5px #25d366;animation:winners-pulse 1.4s ease-in-out infinite;"></span>';
        html += '      LIVE';
        html += '    </span>';
        html += '  </div>';
        html += '  <div id="rouletteModalWinnersList" style="max-height:240px;overflow-y:auto;-webkit-overflow-scrolling:touch;font-size:12px;line-height:1.5;"></div>';
        html += '  <div id="rouletteModalWinnersEmpty" style="text-align:center;color:#888;font-size:11.5px;padding:12px 8px;">Todavía no hay ganadores hoy. Sé el primero — girá la ruleta.</div>';
        html += '  <div style="text-align:center;font-size:10px;color:#777;margin-top:7px;padding-top:7px;border-top:1px dashed rgba(255,255,255,0.10);">🔒 Nombres parcialmente ocultos. Los premios son reales y se acreditan automáticamente.</div>';
        html += '</div>';

        html += '</div>';
        modal.innerHTML = html;

        // Pintar lista con el cache que tengamos y refrescar del server.
        _renderWinnersListInto(
            document.getElementById('rouletteModalWinnersList'),
            document.getElementById('rouletteModalWinnersEmpty'),
            _recentWinnersCache
        );
        loadRecentWinners();
    }

    async function spin() {
        if (_spinning) return;
        _spinning = true;
        // Animación: el icono 🎰 gira rápido + "GIRANDO...".
        const box = document.getElementById('rouletteResultBox');
        if (box) {
            box.innerHTML = '<div style="font-size:80px;line-height:1;margin-bottom:10px;display:inline-block;animation:rouletteSpin 0.5s linear infinite;">🎰</div>' +
                '<div style="color:#ffd700;font-size:14px;font-weight:900;letter-spacing:2px;text-transform:uppercase;">GIRANDO...</div>' +
                '<style>@keyframes rouletteSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }</style>';
        }
        try {
            // Mínimo 1.5s de animación para que se "sienta" la ruleta.
            const [resp] = await Promise.all([
                fetch(`${VIP.config.API_URL}/api/roulette/spin`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${VIP.state.currentToken}`, 'Content-Type': 'application/json' }
                }),
                new Promise(r => setTimeout(r, 1500))
            ]);
            const d = await resp.json();
            if (!resp.ok) {
                if (d && d.alreadySpun) {
                    _state.alreadySpun = true;
                    _state.spin = d.spin;
                    if (d.nextSpinAt) _state.nextResetAt = d.nextSpinAt; // #206
                    _renderModal();
                } else if (d && d.needsAppNotifs) {
                    // No tiene app instalada y/o notifs aceptadas — mostrar
                    // el modal con los pasos clarito para que pueda participar.
                    _showNeedsAppModal();
                } else {
                    if (box) box.innerHTML = '<div style="color:#ff8080;padding:20px;">❌ ' + _esc((d && d.error) || 'Error') + '</div>';
                }
                _spinning = false;
                return;
            }
            // Construimos un "spin" del shape que espera _renderModal y refrescamos.
            _state.alreadySpun = true;
            if (d.nextSpinAt) _state.nextResetAt = d.nextSpinAt; // #206 cooldown 24 h
            if (d.prize && d.prize.prizeType === 'percent') { _state.pendingPct = d.prize.prizePct || 0; _state.pendingExpiresAt = d.prize.expiresAt || null; } // #206
            _state.spin = {
                prizeARS: d.prize.prizeARS,
                prizeType: d.prize.prizeType || null, // #188
                prizePct: d.prize.prizePct || 0,
                expiresAt: d.prize.expiresAt || null, // #206
                rolloverX: d.prize.rolloverX, // #186
                prizeLabel: d.prize.prizeLabel,
                status: d.prize.status,
                spunAt: new Date().toISOString(),
                creditTxId: d.prize.transactionId || null
            };
            _renderModal(_state.spin);
            renderHomeCard();
            // Refrescar saldo del header (mismo patrón que installbonus/withdraw).
            // FIX 2026-07-09: antes llamaba a VIP.auth.refreshBalance, que nunca
            // existió → el saldo no se refrescaba tras ganar. Lo real es ui.syncBalance.
            try { if (window.VIP && VIP.ui && typeof VIP.ui.syncBalance === 'function') VIP.ui.syncBalance(); } catch (_) {}
        } catch (e) {
            if (box) box.innerHTML = '<div style="color:#ff8080;padding:20px;">Error de conexión</div>';
        } finally {
            _spinning = false;
        }
    }

    // Cache para reusar la lista en el modal sin re-fetch.
    let _recentWinnersCache = [];

    function _renderWinnersListInto(listEl, emptyEl, winners) {
        if (!listEl) return;
        if (!winners || winners.length === 0) {
            listEl.innerHTML = '';
            if (emptyEl) emptyEl.style.display = '';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';
        let html = '';
        for (const w of winners) {
            // Horario hh:mm en hora local del browser (ART para la mayoría).
            let hhmm = '';
            try {
                const d = new Date(w.spunAt);
                hhmm = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
            } catch (_) { hhmm = ''; }
            html += '<div class="winner-row' + (w.isMe ? ' is-me' : '') + '">';
            html += '<span class="winner-user">👤 ' + _esc(w.username) + '</span>';
            html += '<span class="winner-prize">' + (w.prizeType === 'percent' ? ('+' + _esc(w.prizePct) + '% próx. carga') : ('+$' + _fmt(w.prizeARS))) + '</span>';
            html += '<span class="winner-time">' + hhmm + '</span>';
            html += '</div>';
        }
        listEl.innerHTML = html;
    }

    // Lista de ganadores del día (transparencia). 🪦 El recuadro del HOME
    // (rouletteWinnersList) fue ELIMINADO 2026-08-05 (owner: confundía en el
    // inicio) — ahora los ganadores se pintan SOLO dentro del modal de la
    // ruleta. 80% del nombre tapado server-side.
    async function loadRecentWinners() {
        if (!VIP.state || !VIP.state.currentToken) return;
        try {
            const r = await fetch(`${VIP.config.API_URL}/api/roulette/recent-winners?limit=50`, {
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}` }
            });
            if (!r.ok) return;
            const d = await r.json();
            const winners = Array.isArray(d.winners) ? d.winners : [];
            _recentWinnersCache = winners;
            // Solo dentro del modal (si está abierto).
            _renderWinnersListInto(
                document.getElementById('rouletteModalWinnersList'),
                document.getElementById('rouletteModalWinnersEmpty'),
                winners
            );
        } catch (e) { /* best-effort */ }
    }

    VIP.roulette = { loadStatus, open, close, spin, loadRecentWinners };

    // Boot: cargar status apenas el usuario esté autenticado.
    document.addEventListener('DOMContentLoaded', () => {
        const tryLoad = () => {
            if (VIP.state && VIP.state.currentToken) {
                loadStatus();
                loadRecentWinners();
            } else {
                setTimeout(tryLoad, 1500);
            }
        };
        setTimeout(tryLoad, 800);
    });

    // Refresh al volver visible.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            loadStatus();
            loadRecentWinners();
        }
    });

    // Auto-refresh cada 30s para mostrar nuevos ganadores en vivo. Solo
    // mientras la página es visible, para no quemar batería en background.
    setInterval(() => {
        if (document.visibilityState === 'visible' && VIP.state && VIP.state.currentToken) {
            loadRecentWinners();
        }
    }, 30000);
})();
