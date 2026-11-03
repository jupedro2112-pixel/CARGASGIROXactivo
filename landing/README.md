# Carpeta `landing/` = la landing de pauta publicada en Vercel (giroxgrupo.com)

Proyecto Vercel `cargasgirox-landing`, conectado al repo `jupedro2112-pixel/CARGASGIROXactivo` (2026-11-03).
**Root Directory del proyecto = `landing`** (Settings → Build and Deployment). Cada push a `main` que toque
esta carpeta genera un deployment nuevo; conectar/desconectar el Git NO deploya nada por sí solo.

Para ver o repetir un deploy: página del proyecto → pestaña **Deployments** (arriba, no en Settings) → menú ⋯ del
último → **Redeploy**. Tras deployar, recargar con Ctrl+F5 (el navegador cachea la landing vieja).

Contenido (#225): diseño tomado de la landing de PICACOMPARTIDO adaptado a ESTA página (carga MANUAL con agente
24 hs). `index.html` llama a `https://cargas1girox.com` (`API_BASE_DEFAULT`): `/api/landing/info` (porcentajes
reales), `/api/meta-pixel-id`, `/api/landing/signup`, `/api/landing/touch`. `vercel.json`: fuera de Argentina
sirve `blank.html`; `/CODIGO` → `index.html`. `img/`: logo de 1GIROX y fotos del carrusel de juegos.
