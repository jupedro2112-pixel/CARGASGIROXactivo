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

    // =====================================================================
    // #206b RUEDA VISUAL — la misma que la ruleta diaria de PAUTANUEVAsantino
    // (aro con luces, gajos con etiquetas radiales, puntero, cubo con logo, giro
    // de 4,2 s hasta el gajo ganador que manda el server en `prizeIndex`).
    // =====================================================================
    const WHEEL_PALETTE = ['#0b3d2a', '#1a1a4a', '#0e6b4a', '#2b0a3d', '#0b3d5a', '#3a2c00'];
    const WHEEL_ACCENT = '#26e07f', WHEEL_ACCENT2 = '#0f9d58';
    function _wheelSize() {
        const w = Math.floor((window.innerWidth - 40) / 1.11);
        return Math.max(220, Math.min(w, Math.floor(window.innerHeight * 0.46), 360));
    }
    function _segments() {
        const prizes = Array.isArray(_state && _state.prizes) ? _state.prizes : [];
        return prizes.map(p => p.label || (p.type === 'percent' ? (p.value + '% EXTRA') : (p.type === 'cash' ? ('$' + _fmt(p.value)) : 'SIN PREMIO')));
    }
    // Índice del gajo que corresponde a un giro ya hecho (para dejar la rueda parada ahí).
    function _segIndexOf(spin) {
        const prizes = Array.isArray(_state && _state.prizes) ? _state.prizes : [];
        if (!spin || !prizes.length) return -1;
        let i = prizes.findIndex(p => p.label && spin.prizeLabel && p.label === spin.prizeLabel);
        if (i < 0) {
            const t = spin.prizeType || (Number(spin.prizeARS) > 0 ? 'cash' : 'none');
            i = prizes.findIndex(p => p.type === t && (t === 'none' || Number(p.value) === Number(t === 'cash' ? spin.prizeARS : spin.prizePct)));
        }
        return i;
    }
    function _wheelMarkup(o) {
        const S = o.S, n = Math.max(1, o.segs.length), R = S / 2;
        const fs = o.fs, pal = WHEEL_PALETTE, acc = WHEEL_ACCENT, acc2 = WHEEL_ACCENT2;
        let stops = '';
        for (let i = 0; i < n; i++) {
            const a0 = (360 / n) * i, a1 = (360 / n) * (i + 1);
            stops += pal[i % pal.length] + ' ' + a0 + 'deg ' + a1 + 'deg' + (i < n - 1 ? ',' : '');
        }
        // Etiquetas RADIALES centradas en cada gajo; giran con la rueda. En la mitad
        // izquierda se dan vuelta para que no queden cabeza abajo.
        let labels = '';
        const rIn = Math.round(S * 0.135), rOut = Math.round(S * 0.455);
        for (let i = 0; i < n; i++) {
            const ang = (360 / n) * i + (360 / n) / 2;
            const flip = ang > 180 && ang < 360;
            const gold = /\$/.test(o.segs[i] || '');
            const tf = flip
                ? 'rotate(' + (ang + 90) + 'deg) translate(-' + rOut + 'px,-50%)'
                : 'rotate(' + (ang - 90) + 'deg) translateY(-50%)';
            labels += '<div style="position:absolute;left:' + R + 'px;top:' + R + 'px;width:' + rOut + 'px;' +
                'box-sizing:border-box;' + (flip ? 'padding-right:' : 'padding-left:') + rIn + 'px;transform-origin:0 0;transform:' + tf + ';' +
                'text-align:center;font-size:' + fs + 'px;line-height:1.1;font-weight:900;letter-spacing:.3px;text-transform:uppercase;' +
                'color:' + (gold ? '#ffe98a' : '#fff') + ';text-shadow:0 1px 2px rgba(0,0,0,.9),0 0 10px rgba(0,0,0,.6);pointer-events:none;">' +
                _esc(o.segs[i] || '') + '</div>';
        }
        const sepDeg = (360 / n).toFixed(4);
        const rim = Math.round(S * 0.055), hub = Math.round(S * 0.19);
        if (!document.getElementById('wrPremiumCss')) {
            const st = document.createElement('style'); st.id = 'wrPremiumCss';
            st.textContent = '@keyframes wrGlow{0%,100%{filter:drop-shadow(0 0 8px rgba(38,224,127,.35))}50%{filter:drop-shadow(0 0 18px rgba(38,224,127,.75))}}' +
                '@keyframes wrLights{to{transform:rotate(30deg)}}';
            document.head.appendChild(st);
        }
        return '<div style="position:relative;width:' + (S + rim * 2) + 'px;height:' + (S + rim * 2) + 'px;margin:6px auto 18px;flex:none;">' +
            // Aro con luces (gira lento, decorativo)
            '<div style="position:absolute;inset:0;border-radius:50%;' +
                'background:repeating-conic-gradient(from 0deg,' + acc + ' 0deg 4deg,#3a2c00 4deg 12deg);' +
                'box-shadow:0 14px 40px rgba(0,0,0,.75),0 0 0 3px #2a1f00,0 0 0 5px ' + acc2 + ',inset 0 0 0 ' + Math.round(rim * 0.45) + 'px #1a1200;' +
                'animation:wrLights 6s linear infinite alternate;"></div>' +
            // Puntero (fijo) con pin
            '<div style="position:absolute;top:' + (rim - 14) + 'px;left:50%;transform:translateX(-50%);z-index:6;width:0;height:0;' +
                'border-left:15px solid transparent;border-right:15px solid transparent;border-top:30px solid ' + acc + ';' +
                'filter:drop-shadow(0 3px 4px rgba(0,0,0,.7));animation:wrGlow 1.6s ease-in-out infinite;"></div>' +
            '<div style="position:absolute;top:' + (rim - 22) + 'px;left:50%;transform:translateX(-50%);z-index:7;width:16px;height:16px;border-radius:50%;' +
                'background:radial-gradient(circle at 35% 35%,#fff,' + acc + ' 55%,#0f5a30);box-shadow:0 2px 6px rgba(0,0,0,.7);"></div>' +
            // Rueda (GIRA)
            '<div id="wrWheel" style="position:absolute;left:' + rim + 'px;top:' + rim + 'px;width:' + S + 'px;height:' + S + 'px;border-radius:50%;' +
                'background:' +
                    'repeating-conic-gradient(from 0deg,rgba(255,255,255,.55) 0deg 0.5deg,transparent 0.5deg ' + sepDeg + 'deg),' +
                    'radial-gradient(circle at 50% 50%,rgba(255,255,255,.14) 0%,rgba(255,255,255,0) 45%,rgba(0,0,0,.45) 100%),' +
                    'conic-gradient(' + stops + ');' +
                'box-shadow:inset 0 0 0 2px rgba(0,0,0,.5),inset 0 0 40px rgba(0,0,0,.55);' +
                'transition:transform 4.2s cubic-bezier(.17,.67,.2,1);">' + labels + '</div>' +
            // Brillo superior (fijo)
            '<div style="position:absolute;left:' + rim + 'px;top:' + rim + 'px;width:' + S + 'px;height:' + S + 'px;border-radius:50%;pointer-events:none;z-index:4;' +
                'background:radial-gradient(ellipse at 50% 18%,rgba(255,255,255,.22) 0%,rgba(255,255,255,.05) 35%,rgba(255,255,255,0) 60%);"></div>' +
            // Cubo central con logo (fijo)
            '<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:5;width:' + hub + 'px;height:' + hub + 'px;border-radius:50%;' +
                'background:radial-gradient(circle at 35% 30%,#d9ffe9,' + acc + ' 45%,#0a3d22 100%);' +
                'box-shadow:0 4px 14px rgba(0,0,0,.7),inset 0 -3px 8px rgba(0,0,0,.35),0 0 0 3px #1a1200;display:flex;align-items:center;justify-content:center;">' +
                '<img src="/images/soporte-1girox.png" alt="" style="width:' + Math.round(hub * 0.66) + 'px;height:' + Math.round(hub * 0.66) + 'px;border-radius:50%;object-fit:cover;border:2px solid rgba(0,0,0,.35);">' +
            '</div>' +
        '</div>';
    }
    // Deja la rueda parada en un gajo (sin animación).
    function _parkWheelAt(idx) {
        const wheel = document.getElementById('wrWheel');
        if (!wheel || idx < 0) return;
        const n = Math.max(1, _segments().length);
        const segMid = (360 / n) * idx + (360 / n) / 2;
        wheel.style.transition = 'none';
        wheel.style.transform = 'rotate(' + (360 - segMid) + 'deg)';
    }
    const BTN_MAIN = 'width:100%;background:' + WHEEL_ACCENT + ';color:#00301a;border:none;border-radius:16px;padding:16px;font-size:19px;font-weight:900;cursor:pointer;box-shadow:0 6px 18px rgba(38,224,127,.35);';
    const BTN_SOFT = 'width:100%;background:rgba(255,255,255,.14);color:#fff;border:none;border-radius:16px;padding:13px;font-size:15px;font-weight:800;cursor:pointer;';

    // Texto + botones del resultado según el giro (ya hecho o recién hecho).
    function _resultFor(spin) {
        const won = Number(spin.prizeARS || 0) > 0;
        const cdNext = _countdown(_state.nextResetAt);
        let titulo = '', detalle = '', actions = '';
        if (spin.prizeType === 'percent' && Number(spin.prizePct) > 0) {
            const used = spin.status === 'percent_used';
            const _exp = spin.expiresAt || (_state.pendingPct > 0 ? _state.pendingExpiresAt : null);
            const _cd = _countdown(_exp);
            const expired = spin.status === 'percent_expired' || (!used && !_cd && !spin._fresh);
            if (used) {
                titulo = '✅ ' + _esc(spin.prizeLabel || ('+' + spin.prizePct + '% EXTRA'));
                detalle = 'Ya se aplicó en una carga. ¡Que lo disfrutes!';
            } else if (expired) {
                titulo = '⌛ Premio vencido';
                detalle = 'Pasaron 24 h sin cargar y el <b>' + _esc(spin.prizePct) + '% EXTRA</b> se perdió.' + (cdNext ? '<br>Volvés a girar en <b>' + _esc(cdNext) + '</b>.' : '');
            } else {
                titulo = '🎉 ¡Ganaste ' + _esc(spin.prizeLabel || ('+' + spin.prizePct + '% EXTRA')) + '!';
                detalle = 'Se suma automático en tu <b>PRÓXIMA CARGA</b>. 💪<br><span style="font-size:12.5px;color:#ffd700;">⏳ Reclamable por <b>24 horas</b>: cargá antes de que venza' + (_cd ? ' (vence en ' + _esc(_cd) + ')' : '') + '.</span>';
                actions += '<button type="button" onclick="VIP.roulette.close();if(window.VIP&&VIP.ui&&VIP.ui.enterCasino)VIP.ui.enterCasino()" style="' + BTN_MAIN.replace('padding:16px;font-size:19px', 'padding:15px;font-size:17px') + '">💳 Cargar ahora y usarlo</button>';
            }
        } else if (won && spin.status === 'credit_failed') {
            titulo = '⚠️ Premio pendiente: $' + _fmt(spin.prizeARS);
            detalle = 'Ganaste pero la acreditación automática falló. Escribinos por el chat y te lo cargamos.';
        } else if (won) {
            titulo = '🎉 ¡Ganaste ' + _esc(spin.prizeLabel || ('$' + _fmt(spin.prizeARS))) + '!';
            detalle = '💰 Ya está <b>ACREDITADO</b> en tu saldo.' +
                (Number(spin.rolloverX) > 0 ? '<br><span style="font-size:12px;opacity:.85;">🎯 Rollover x' + spin.rolloverX + ': ya podés jugarlo; para retirarlo apostalo ' + spin.rolloverX + ' veces (las apuestas en DEPORTES no suman).</span>' : '') +
                (spin.creditTxId ? '<br><span style="font-size:10px;opacity:.6;font-family:monospace;">tx: ' + _esc(spin.creditTxId) + '</span>' : '');
        } else {
            titulo = '😅 Hoy no hubo suerte';
            detalle = cdNext ? '⏰ Tu próximo giro gratis es en <b>' + _esc(cdNext) + '</b>. ¡Volvé a intentar!' : '⏰ Ya podés volver a girar. ¡Probá de nuevo!';
        }
        actions += '<button type="button" onclick="VIP.roulette.close()" style="' + BTN_SOFT + '">Cerrar</button>';
        return {
            html: '<div style="font-size:24px;font-weight:900;color:' + WHEEL_ACCENT + ';margin:4px 0 8px;text-shadow:0 2px 6px rgba(0,0,0,.6);">' + titulo + '</div><div>' + detalle + '</div>',
            actions: actions,
            won: won
        };
    }

    function _renderModal(spinResult) {
        const modal = document.getElementById('rouletteModal');
        if (!modal) return;
        if (!_state) {
            modal.innerHTML = '<div style="color:#fff;text-align:center;padding:40px 16px;width:100%;">⏳ Cargando…</div>';
            return;
        }
        const spin = spinResult || _state.spin;
        const alreadySpun = !!(spin && (spin.prizeARS != null || spin.prizeType));
        const segs = _segments();
        const n = Math.max(1, segs.length);
        const S = _wheelSize();
        const fs = S >= 320 ? (n > 5 ? 13 : 16) : 12;

        let html = '<div style="position:relative;width:100%;max-width:480px;margin:0 auto;display:flex;flex-direction:column;align-items:center;color:#fff;' +
            'padding:calc(18px + env(safe-area-inset-top,0px)) 0 calc(18px + env(safe-area-inset-bottom,0px));box-sizing:border-box;">';
        html += '<button type="button" onclick="VIP.roulette.close()" aria-label="Cerrar" style="position:absolute;top:calc(6px + env(safe-area-inset-top,0px));right:4px;width:38px;height:38px;border-radius:50%;border:none;background:rgba(255,255,255,.14);color:#fff;font-size:20px;font-weight:900;cursor:pointer;z-index:9;">✕</button>';
        html += '<div style="color:' + WHEEL_ACCENT + ';font-size:22px;font-weight:900;text-align:center;text-shadow:0 2px 6px rgba(0,0,0,.6);padding:0 44px;">🎰 RULETA DIARIA</div>';
        html += '<div style="color:#fff;opacity:.85;font-size:14px;margin:4px 0 12px;text-align:center;padding:0 10px;">Un giro gratis cada 24 h. Los % extra valen 24 h. ¡Suerte!</div>';
        if (segs.length) {
            html += _wheelMarkup({ S: S, segs: segs, fs: fs });
        } else {
            html += '<div style="font-size:72px;line-height:1;margin:10px 0 16px;">🎰</div>';
        }
        html += '<div id="wrResult" style="color:#fff;text-align:center;font-size:15px;line-height:1.35;max-width:360px;padding:0 8px;"></div>';
        html += '<div id="wrActions" style="width:100%;max-width:360px;display:flex;flex-direction:column;gap:10px;margin-top:8px;padding:0 8px;box-sizing:border-box;"></div>';

        // Premios y probabilidades vigentes (vienen del panel).
        const prizes = Array.isArray(_state.prizes) ? _state.prizes.filter(p => p && p.type !== 'none') : [];
        if (!alreadySpun && prizes.length) {
            html += '<div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:12px 8px 0;">';
            for (const p of prizes) {
                const txt = p.type === 'percent' ? ('+' + _esc(p.value) + '% EXTRA próx. carga') : ('$' + _fmt(p.value));
                html += '<span style="background:rgba(38,224,127,0.10);border:1px solid rgba(38,224,127,0.40);border-radius:14px;padding:4px 9px;font-size:11px;color:#fff;font-weight:800;">' + _esc(p.emoji || '') + ' ' + txt + (p.pct != null ? ' <span style="color:#aaa;font-weight:600;">' + _esc(p.pct) + '%</span>' : '') + '</span>';
            }
            html += '</div>';
        }

        // Transparencia: ganadores del día (live), debajo de la rueda.
        html += '<div style="width:100%;max-width:440px;margin-top:16px;background:rgba(0,0,0,0.50);border:1px solid rgba(38,224,127,0.30);border-radius:11px;padding:11px 12px;box-sizing:border-box;">';
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

        const rEl = document.getElementById('wrResult');
        const aEl = document.getElementById('wrActions');
        if (alreadySpun) {
            // Ya giró: rueda parada en su gajo + resultado + cuenta regresiva.
            _parkWheelAt(_segIndexOf(spin));
            const r = _resultFor(spin);
            if (rEl) rEl.innerHTML = r.html;
            if (aEl) aEl.innerHTML = r.actions;
        } else {
            if (aEl) aEl.innerHTML = '<button type="button" id="rouletteSpinBtn" onclick="VIP.roulette.spin()" style="' + BTN_MAIN + '">🎰 GIRAR</button>';
        }

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
        const btn = document.getElementById('rouletteSpinBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Girando…'; btn.style.opacity = '.7'; }
        const restoreBtn = () => { if (btn) { btn.disabled = false; btn.textContent = '🎰 GIRAR'; btn.style.opacity = '1'; } };
        try {
            const resp = await fetch(`${VIP.config.API_URL}/api/roulette/spin`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${VIP.state.currentToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            const d = await resp.json();
            if (!resp.ok || !d || !d.success) {
                if (d && d.alreadySpun) {
                    _state.alreadySpun = true;
                    _state.spin = d.spin;
                    if (d.nextSpinAt) _state.nextResetAt = d.nextSpinAt;
                    _renderModal();
                } else if (d && d.needsAppNotifs) {
                    restoreBtn();
                    _showNeedsAppModal();
                } else {
                    restoreBtn();
                    try { VIP.ui.showToast((d && d.error) || 'No se pudo girar. Probá de nuevo.', 'error'); } catch (_) {}
                }
                _spinning = false;
                return;
            }
            // Girar la rueda hasta el gajo ganador (índice del server; si no viene, por etiqueta).
            const segs = _segments();
            const n = Math.max(1, segs.length);
            let idx = (typeof d.prizeIndex === 'number' && d.prizeIndex >= 0) ? d.prizeIndex : -1;
            if (idx < 0) idx = Math.max(0, _segIndexOf({ prizeLabel: d.prize.prizeLabel, prizeType: d.prize.prizeType, prizeARS: d.prize.prizeARS, prizePct: d.prize.prizePct }));
            idx = Math.min(n - 1, idx);
            const wheel = document.getElementById('wrWheel');
            const segMid = (360 / n) * idx + (360 / n) / 2;
            const target = 360 * 5 + (360 - segMid);
            if (wheel) { wheel.style.transition = 'transform 4.2s cubic-bezier(.17,.67,.2,1)'; void wheel.offsetWidth; wheel.style.transform = 'rotate(' + target + 'deg)'; }

            _state.alreadySpun = true;
            if (d.nextSpinAt) _state.nextResetAt = d.nextSpinAt; // cooldown 24 h
            if (d.prize && d.prize.prizeType === 'percent') { _state.pendingPct = d.prize.prizePct || 0; _state.pendingExpiresAt = d.prize.expiresAt || null; }
            _state.spin = {
                prizeARS: d.prize.prizeARS,
                prizeType: d.prize.prizeType || null,
                prizePct: d.prize.prizePct || 0,
                expiresAt: d.prize.expiresAt || null,
                rolloverX: d.prize.rolloverX,
                prizeLabel: d.prize.prizeLabel,
                status: d.prize.status,
                spunAt: new Date().toISOString(),
                creditTxId: d.prize.transactionId || null,
                _fresh: true
            };
            const spinSnapshot = _state.spin;
            setTimeout(() => {
                // Si el modal se cerró y se volvió a abrir, _renderModal ya pintó el resultado.
                const rEl = document.getElementById('wrResult');
                const aEl = document.getElementById('wrActions');
                if (rEl && aEl && _state.spin === spinSnapshot) {
                    const r = _resultFor(spinSnapshot);
                    rEl.innerHTML = r.html;
                    aEl.innerHTML = r.actions;
                }
                renderHomeCard();
                // Refrescar saldo del header (lo real es ui.syncBalance).
                try { if (window.VIP && VIP.ui && typeof VIP.ui.syncBalance === 'function') VIP.ui.syncBalance(); } catch (_) {}
                loadRecentWinners();
                _spinning = false;
            }, wheel ? 4400 : 300);
        } catch (e) {
            restoreBtn();
            try { VIP.ui.showToast('Error de conexión. Probá de nuevo.', 'error'); } catch (_) {}
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
