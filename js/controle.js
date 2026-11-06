// ─── Yélé Contrôle : espace réservé de l'autorité ────────────────────────────
// Page séparée du tableau de bord public. Elle lit les campagnes de drive test
// et de walk test (collection séparée côté serveur), réservées aux comptes
// déclarés dans control_agents et control_readers.

const Controle = (() => {
  const API = CONFIG.API_BASE_URL;
  const TOKEN_KEY = 'yeleControlToken';
  const OPS = [
    { id: 'orange', name: 'Orange', color: '#e8770f', re: /orange|61302/i },
    { id: 'moov', name: 'Moov Africa', color: '#1e6ad0', re: /moov|onatel|telmob|61301/i },
    { id: 'telecel', name: 'Telecel', color: '#8a4fc9', re: /telecel|61303/i },
  ];
  // Seuils de l'annexe 3 des cahiers des charges des licences.
  const ARCEP = { setupRate: 98, webRate: 95, webMax: 30, videoMax: 5, rsrpMin: -102, dl4g: 2, ul4g: 1 };
  const LIVE_MS = 10 * 60 * 1000;

  const state = {
    token: null, email: '', demo: false, demoData: null,
    campaigns: [], campaign: null, rows: [], op: '', layer: 'dl',
    timer: null,
  };
  let map = null;
  let layer = null;

  // ── Outils ────────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d = 1) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const hhmm = (iso) => { const d = new Date(iso); return isNaN(d) ? '—' : `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
  const dayFr = (iso) => { const d = new Date(iso); return isNaN(d) ? '—' : `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`; };
  const median = (a) => { const s = a.filter((x) => x != null && isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const pct = (n, d) => (d ? (100 * n) / d : null);
  const opOf = (p, doc) => OPS.find((o) => o.re.test(p.simOperator || '') || o.re.test(doc.operator || '')) || null;

  function store(key, value) {
    try { if (value == null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch (_) { /* stockage indisponible */ }
  }
  function load(key) { try { return sessionStorage.getItem(key); } catch (_) { return null; } }

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...(opts.headers || {}) },
    });
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    return res.status === 204 ? null : res.json();
  }

  // ── Connexion ─────────────────────────────────────────────────────────────
  async function login(email, password) {
    const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    state.token = r.token;
    const me = await api('/api/control/me');
    if (!me.reader) {
      state.token = null;
      throw new Error('Ce compte n\'a pas accès à l\'espace Contrôle. Demandez à l\'administrateur de le déclarer.');
    }
    state.email = me.email;
    store(TOKEN_KEY, state.token);
  }

  async function resumeSession() {
    const t = load(TOKEN_KEY);
    if (!t) return false;
    state.token = t;
    try {
      const me = await api('/api/control/me');
      if (!me.reader) throw new Error('forbidden');
      state.email = me.email;
      return true;
    } catch (_) {
      state.token = null; store(TOKEN_KEY, null);
      return false;
    }
  }

  function renderUser() {
    $('ct-user').innerHTML = state.demo
      ? `<span>Démonstration</span><a href="#" id="quit">Quitter</a>`
      : state.token
        ? `<span>${esc(state.email)}</span><a href="#" id="quit">Se déconnecter</a>`
        : `<a href="index.html">Tableau de bord public</a>`;
    const q = $('quit');
    if (q) q.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!state.demo && state.token) { try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) { /* hors ligne */ } }
      state.token = null; state.demo = false; store(TOKEN_KEY, null);
      clearInterval(state.timer);
      showLogin();
    });
  }

  function showLogin() {
    $('view-app').hidden = true; $('view-login').hidden = false;
    renderUser();
  }

  async function showApp() {
    $('view-login').hidden = true; $('view-app').hidden = false;
    $('demo-banner').hidden = !state.demo;
    $('refresh-btn').hidden = state.demo;
    renderUser();
    initMap();
    await loadCampaigns();
  }

  // ── Données ───────────────────────────────────────────────────────────────
  async function loadCampaigns() {
    state.campaigns = state.demo ? state.demoData.campaigns : await api('/api/control/campaigns');
    const sel = $('campaign-select');
    sel.innerHTML = state.campaigns.length
      ? state.campaigns.map((c) => `<option value="${esc(c.campaign)}">${esc(c.campaign)} · ${dayFr(c.firstAt)}</option>`).join('')
      : '<option value="">Aucune campagne pour l\'instant</option>';
    if (state.campaigns.length) await loadCampaign(state.campaigns[0].campaign);
    else renderEmpty();
  }

  async function loadCampaign(id) {
    const data = state.demo ? state.demoData.campaign : await api(`/api/control/campaign?id=${encodeURIComponent(id)}`);
    state.campaign = { ...data, summary: state.campaigns.find((c) => c.campaign === id) };
    state.rows = data.measurements.map((doc) => {
      let p = {};
      try { p = JSON.parse(doc.payload); } catch (_) { /* mesure illisible */ }
      return { doc, p, op: opOf(p, doc) };
    });
    renderAll();
    scheduleRefresh();
  }

  function isLive() {
    const s = state.campaign && state.campaign.summary;
    return !state.demo && s && Date.now() - new Date(s.lastReceived).getTime() < LIVE_MS;
  }

  function scheduleRefresh() {
    clearInterval(state.timer);
    $('live-badge').hidden = !isLive();
    if (isLive()) {
      state.timer = setInterval(async () => {
        try { await loadCampaigns(); } catch (_) { /* nouvel essai au prochain tour */ }
      }, 30000);
    }
  }

  // ── Rendu ─────────────────────────────────────────────────────────────────
  function renderEmpty() {
    $('campaign-meta').textContent = 'Les campagnes apparaissent ici dès que les téléphones d\'un agent envoient leurs premières mesures.';
    ['summary', 'ops', 'devices', 'seal', 'spots', 'latest'].forEach((k) => { $(k).innerHTML = ''; });
    if (layer) layer.clearLayers();
  }

  function renderAll() {
    const s = state.campaign.summary || {};
    const rows = state.rows;
    $('campaign-meta').textContent = `${dayFr(s.firstAt)} · ${hhmm(s.firstAt)} – ${hhmm(s.lastAt)} · ${(s.agents || []).join(', ')}`;
    const failed = rows.filter((r) => r.p.error).length;
    $('summary').innerHTML = [
      ['Mesures', rows.length, ''],
      ['Cycles en échec', failed, failed ? 'ko' : 'ok'],
      ['Téléphones', (s.devices || []).length, ''],
      ['Opérateurs', OPS.filter((o) => rows.some((r) => r.op === o)).length, ''],
      ['Durée', s.firstAt ? `${Math.round((new Date(s.lastAt) - new Date(s.firstAt)) / 60000)} min` : '—', ''],
    ].map(([k, v, c]) => `<div class="ct-stat"><small>${k}</small><b class="${c}">${v}</b></div>`).join('');
    renderOpFilter();
    renderMap();
    renderDevices();
    renderOps();
    renderSpots();
    renderLatest();
    renderSeal();
  }

  function renderOpFilter() {
    const present = OPS.filter((o) => state.rows.some((r) => r.op === o));
    $('op-filter').innerHTML = [`<button data-op="" aria-pressed="${state.op === ''}">Tous</button>`]
      .concat(present.map((o) => `<button data-op="${o.id}" aria-pressed="${state.op === o.id}"><span class="dot" style="background:${o.color}"></span>${o.name}</button>`))
      .join('');
    $('op-filter').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      state.op = b.dataset.op; renderOpFilter(); renderMap();
    }));
  }

  const SCALES = {
    dl: { label: 'Débit descendant', unit: 'Mb/s', get: (p) => p.download, steps: [[30, '#0b5d2c', '> 30'], [8, '#1a9641', '8–30'], [3, '#a6d96a', '3–8'], [1, '#f28e2b', '1–3'], [-Infinity, '#d7191c', '< 1']] },
    rsrp: { label: 'Signal reçu (RSRP)', unit: 'dBm', get: (p) => p.rsrp, steps: [[-80, '#0b5d2c', '> −80'], [-90, '#1a9641', '−80/−90'], [-102, '#a6d96a', '−90/−102'], [-110, '#f28e2b', '−102/−110'], [-Infinity, '#d7191c', '< −110']] },
    ping: { label: 'Latence', unit: 'ms', get: (p) => (p.ping == null ? null : -p.ping), steps: [[-50, '#0b5d2c', '< 50'], [-100, '#1a9641', '50–100'], [-200, '#a6d96a', '100–200'], [-400, '#f28e2b', '200–400'], [-Infinity, '#d7191c', '> 400']] },
  };

  function initMap() {
    if (map) { setTimeout(() => map.invalidateSize(), 50); return; }
    map = L.map('ct-map', { zoomControl: true }).setView([12.3714, -1.5197], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 18 }).addTo(map);
    layer = L.layerGroup().addTo(map);
    $('layer-filter').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      state.layer = b.dataset.layer;
      $('layer-filter').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      renderMap();
    }));
  }

  function popup(r) {
    const p = r.p;
    return `<b>${esc(r.op ? r.op.name : p.simOperator || '—')}</b> · ${esc(p.cellularTech || '—')} · cycle ${esc(r.doc.seq)}<br>
      ${hhmm(p.measuredAt)} · ${esc(r.doc.deviceId)}<br>
      ${p.error ? `<span style="color:#d23b33">Échec : ${esc(p.error)}</span><br>` : `▼ ${fmt(p.download)} · ▲ ${fmt(p.upload)} Mb/s · ${fmt(p.ping, 0)} ms<br>`}
      RSRP ${p.rsrp ?? '—'} dBm · perte ${fmt(p.packetLoss)} %<br>
      <span style="font-family:Consolas,monospace;font-size:11px;color:#5d6478">${esc(r.doc.hash.slice(0, 20))}…</span>`;
  }

  function renderMap() {
    if (!layer) return;
    layer.clearLayers();
    const sc = SCALES[state.layer];
    const pts = [];
    for (const r of state.rows) {
      if (state.op && (!r.op || r.op.id !== state.op)) continue;
      const lat = r.p.latitude, lng = r.p.longitude;
      if (!lat || !lng) continue;
      pts.push([lat, lng]);
      if (r.p.error) {
        L.marker([lat, lng], { icon: L.divIcon({ className: '', html: '<div style="color:#d23b33;font:800 18px/1 Inter,sans-serif;text-shadow:0 0 3px #fff">✕</div>', iconSize: [16, 16], iconAnchor: [8, 9] }) })
          .bindPopup(popup(r)).addTo(layer);
        continue;
      }
      const v = sc.get(r.p);
      const color = v == null ? '#9aa1b1' : sc.steps.find(([min]) => v >= min)[1];
      L.circleMarker([lat, lng], { radius: 7, weight: 2, color: r.op ? r.op.color : '#fff', fillColor: color, fillOpacity: 0.95 })
        .bindPopup(popup(r)).addTo(layer);
    }
    if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
    $('legend').innerHTML = `<span>${sc.label} · contour = opérateur · ✕ = cycle en échec</span>` +
      sc.steps.map(([, c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join('') + `<span>${sc.unit}</span>`;
  }

  function renderDevices() {
    const byDev = new Map();
    for (const r of state.rows) {
      const d = byDev.get(r.doc.deviceId) || { id: r.doc.deviceId, op: r.op, n: 0, fail: 0, last: null };
      d.n++; if (r.p.error) d.fail++;
      if (!d.last || r.doc.seq > d.last.doc.seq) d.last = r;
      byDev.set(r.doc.deviceId, d);
    }
    const ref = state.demo ? new Date((state.campaign.summary || {}).lastAt).getTime() : Date.now();
    $('devices').innerHTML = [...byDev.values()].map((d) => {
      const p = d.last.p;
      const ago = Math.round((ref - new Date(d.last.doc.receivedAt).getTime()) / 60000);
      const hot = p.batteryTempC != null && p.batteryTempC >= 42;
      return `<div class="ct-device"><span class="bar" style="background:${d.op ? d.op.color : '#9aa1b1'}"></span><div>
        <b>${esc(d.op ? d.op.name : '—')}</b> <small style="display:inline">${esc(d.id)}</small>
        <small>${d.n} cycles · ${d.fail} en échec · dernière mesure ${hhmm(p.measuredAt)}${ago > 0 ? ` (il y a ${ago} min)` : ''}</small>
        <small class="${hot ? 'warn' : ''}">Batterie ${p.batteryPercent ?? '—'} %${p.charging ? ' en charge' : ''} · ${p.batteryTempC != null ? fmt(p.batteryTempC, 0) + ' °C' : '—'}${hot ? ' · téléphone chaud' : ''}</small>
      </div></div>`;
    }).join('') || '<p class="ct-muted">Aucun téléphone.</p>';
  }

  function check(label, value, rule, threshold) {
    const pill = value == null ? '<span class="pill na">non mesuré</span>'
      : rule ? `<span class="pill ${value >= threshold ? 'ok' : 'ko'}">${value >= threshold ? 'Conforme' : 'Non conforme'}</span>`
        : '<span class="pill na">indicatif</span>';
    return `<div class="ct-check"><span>${label}</span><span><span class="v">${value == null ? '—' : fmt(value) + ' %'}</span>${pill}</span></div>`;
  }

  function renderOps() {
    $('ops').innerHTML = OPS.map((op) => {
      const rows = state.rows.filter((r) => r.op === op);
      if (!rows.length) return '';
      const ok = rows.filter((r) => !r.p.error);
      const hasWeb = rows.some((r) => r.p.webLoadS != null);
      const hasVideo = rows.some((r) => r.p.videoStartS != null);
      const withRsrp = rows.filter((r) => r.p.rsrp != null);
      return `<div class="ct-card ct-op" style="--op:${op.color}">
        <header><h2>${op.name}</h2><span class="ct-eyebrow">${rows.length} cycles</span></header>
        <div class="ct-kpis">
          <div><small>▼ médian</small><b>${fmt(median(ok.map((r) => r.p.download)))}</b></div>
          <div><small>▲ médian</small><b>${fmt(median(ok.map((r) => r.p.upload)))}</b></div>
          <div><small>Latence méd.</small><b>${ok.length ? fmt(median(ok.map((r) => r.p.ping)), 0) + ' ms' : '—'}</b></div>
        </div>
        ${check('Connexion data réussie (seuil 98 %)', pct(ok.length, rows.length), true, ARCEP.setupRate)}
        ${check('Pages web en moins de 30 s (seuil 95 %)', hasWeb ? pct(ok.filter((r) => r.p.webLoadS < ARCEP.webMax).length, rows.length) : null, true, ARCEP.webRate)}
        ${check('Vidéo : 1re image en moins de 5 s', hasVideo ? pct(ok.filter((r) => r.p.videoStartS < ARCEP.videoMax).length, rows.length) : null, false)}
        ${check('Couverture : RSRP ≥ −102 dBm', withRsrp.length ? pct(withRsrp.filter((r) => r.p.rsrp >= ARCEP.rsrpMin).length, withRsrp.length) : null, false)}
        ${check('Débit 4G : ▼ > 2 et ▲ > 1 Mb/s', pct(ok.filter((r) => r.p.download > ARCEP.dl4g && r.p.upload > ARCEP.ul4g).length, rows.length), false)}
      </div>`;
    }).join('');
  }

  function renderSpots() {
    const spots = state.rows.filter((r) => r.p.error || (r.p.rsrp != null && r.p.rsrp < -110))
      .sort((a, b) => (b.p.error ? 1 : 0) - (a.p.error ? 1 : 0) || (a.p.rsrp ?? 0) - (b.p.rsrp ?? 0));
    $('spots').innerHTML = spots.length ? spots.slice(0, 30).map((r) => `<tr>
      <td><span class="dot" style="background:${r.op ? r.op.color : '#9aa1b1'}"></span> ${esc(r.op ? r.op.name : '—')}</td>
      <td>${hhmm(r.p.measuredAt)}</td>
      <td class="${r.p.error ? 'ko' : ''}">${r.p.error ? esc(r.p.error) : 'Signal faible'} · ${r.p.rsrp ?? '—'} dBm</td>
      <td>${fmt(r.p.latitude, 4)}, ${fmt(r.p.longitude, 4)}</td></tr>`).join('')
      : '<tr><td colspan="4">Aucun point noir sur cette campagne.</td></tr>';
  }

  function renderLatest() {
    const rows = [...state.rows].sort((a, b) => (b.p.measuredAt || '').localeCompare(a.p.measuredAt || '')).slice(0, 40);
    $('latest').innerHTML = rows.map((r) => `<tr>
      <td>${hhmm(r.p.measuredAt)}</td><td>${esc(r.op ? r.op.name : '—')}</td><td>${esc(r.p.cellularTech || '—')}</td>
      ${r.p.error ? `<td class="ko" colspan="3">${esc(r.p.error)}</td>` : `<td>${fmt(r.p.download)}</td><td>${fmt(r.p.upload)}</td><td>${fmt(r.p.ping, 0)} ms</td>`}
      <td>${r.p.rsrp ?? '—'}</td></tr>`).join('');
  }

  // Vérification de la chaîne dans le navigateur (SHA-256 natif).
  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function renderSeal() {
    const box = $('seal');
    const docs = state.rows.map((r) => r.doc).sort((a, b) => a.deviceId.localeCompare(b.deviceId) || a.seq - b.seq);
    let broken = null, local = false;
    if (window.crypto && crypto.subtle) {
      local = true;
      const prev = {};
      for (const d of docs) {
        const expected = await sha256(d.prevHash + '|' + d.payload);
        if (d.prevHash !== (prev[d.deviceId] || '') || d.hash !== expected) { broken = d; break; }
        prev[d.deviceId] = d.hash;
      }
    } else if (!state.campaign.chainIntact) broken = { deviceId: '?', seq: '?' };
    box.innerHTML = broken
      ? `<div class="ct-seal-status ko">Chaîne cassée : ${esc(broken.deviceId)}, cycle ${esc(broken.seq)}</div>
         <p class="ct-muted">Cette mesure a été modifiée, supprimée ou insérée après son envoi. Elle ne peut pas fonder une décision.</p>`
      : `<div class="ct-seal-status ok">Chaîne intacte · ${docs.length} mesures</div>
         <p class="ct-muted">${local ? 'Empreintes recalculées dans votre navigateur.' : 'Vérification faite par le serveur.'} Aucune mesure n'a été modifiée ou retirée depuis son envoi.</p>`;
    const last = {};
    for (const d of docs) last[d.deviceId] = d.hash;
    box.innerHTML += `<div class="ct-hash">${Object.entries(last).map(([k, h]) => `${esc(k)} : ${h.slice(0, 16)}…`).join('<br>')}</div>`;
  }

  // Export : une ligne par mesure, les champs du téléphone et l'empreinte.
  function exportCsv() {
    const cols = ['measuredAt', 'deviceId', 'seq', 'simOperator', 'cellularTech', 'latitude', 'longitude', 'rsrp', 'download', 'upload', 'ping', 'packetLoss', 'webLoadS', 'videoStartS', 'batteryTempC', 'error'];
    const q = (v) => { const s = v == null ? '' : String(v); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [cols.concat(['hash']).join(';')]
      .concat(state.rows.map((r) => cols.map((c) => q(c === 'deviceId' ? r.doc.deviceId : c === 'seq' ? r.doc.seq : r.p[c])).concat(r.doc.hash).join(';')));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `yele-controle-${state.campaign.campaign}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ── Démarrage ─────────────────────────────────────────────────────────────
  async function init() {
    $('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('login-error'); err.hidden = true;
      const btn = $('login-submit'); btn.disabled = true; btn.textContent = 'Connexion…';
      try {
        await login($('login-email').value.trim(), $('login-password').value);
        state.demo = false;
        await showApp();
      } catch (ex) {
        err.textContent = ex.status === 401 ? 'E-mail ou mot de passe incorrect.'
          : ex.status === 429 ? 'Trop de tentatives. Réessayez dans quelques minutes.'
            : ex.status ? 'Serveur indisponible. Réessayez dans un instant.' : ex.message || 'Serveur injoignable.';
        err.hidden = false;
      } finally { btn.disabled = false; btn.textContent = 'Se connecter'; }
    });
    $('demo-btn').addEventListener('click', async () => {
      const res = await fetch('data/controle_demo.json', { cache: 'no-cache' });
      state.demoData = await res.json();
      state.demo = true;
      await showApp();
    });
    $('campaign-select').addEventListener('change', (e) => { if (e.target.value) loadCampaign(e.target.value); });
    $('refresh-btn').addEventListener('click', () => loadCampaigns().catch(() => {}));
    $('export-btn').addEventListener('click', exportCsv);

    if (await resumeSession()) await showApp(); else showLogin();
  }

  return { init };
})();

Controle.init();
