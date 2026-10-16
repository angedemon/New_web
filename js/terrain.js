// ─── Relevés de terrain importés (fichiers statiques de data/) ───────────────
// - data/nperf.json : tests nPerf de la campagne des agents (source séparée
//   des tests Yélé : ils n'entrent ni dans la base ni dans le baromètre) ;
// - data/couverture_orange.json : relevé TowerCollector d'Orange, couverture
//   4G (meilleur RSRP) par carré de ~110 m et sites (eNodeB) à position estimée.
// Les fichiers sont produits par outils/importer_campagne.py.

const Terrain = (() => {
  let cache = null;

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(url + ' : HTTP ' + res.status);
    return res.json();
  }

  function load() {
    if (!cache) {
      cache = Promise.all([
        getJson('data/nperf.json').catch(() => null),
        getJson('data/couverture_orange.json').catch(() => null),
      ]).then(([nperf, tower]) => ({ nperf, tower }));
    }
    return cache;
  }

  // Nom d'opérateur mobile unifié, à partir de la SIM puis du réseau IP.
  function mobileOperator(p) {
    const pick = (s) => {
      s = (s || '').toLowerCase();
      if (/orange|61302|613:2/.test(s)) return 'Orange';
      if (/telecel|61303|613:3/.test(s)) return 'Telecel';
      if (/moov|onatel|telmob|61301|613:1/.test(s)) return 'Moov Africa';
      return null;
    };
    return pick(p.simOperator) || pick(p.operator);
  }

  const MOBILE_NET = /^(2G|3G|4G|5G|MOBILE)$/i;
  const OUAGA = [[12.25, -1.65], [12.48, -1.40]];
  const inOuaga = (lat, lng) => lat >= OUAGA[0][0] && lat <= OUAGA[1][0] && lng >= OUAGA[0][1] && lng <= OUAGA[1][1];

  // Tests Yélé mobiles de Ouagadougou, au même format que les tests nPerf.
  function yeleMobile(points) {
    return points
      .filter((p) => p.lat && p.lng && inOuaga(p.lat, p.lng) && MOBILE_NET.test(p.networkType || '') && p.download > 0)
      .map((p) => ({
        op: mobileOperator(p), dl: p.download,
        ul: p.upload > 0 ? p.upload : null, ping: p.ping > 0 ? p.ping : null,
      }));
  }

  // ── Couleurs ───────────────────────────────────────────────────────────────

  // Niveaux RSRP de l'étude (tableau 17) et seuil ARCEP 4G (-102 dBm).
  const RSRP_CLASSES = [
    { min: -80, color: '#0b5d2c', label: '> -80 dBm (excellent)' },
    { min: -90, color: '#1a9641', label: '-80 à -90 (bon)' },
    { min: -102, color: '#a6d96a', label: '-90 à -102 (correct)' },
    { min: -110, color: '#fdae61', label: '-102 à -110 (sous le seuil ARCEP)' },
    { min: -Infinity, color: '#d7191c', label: '< -110 dBm (très faible)' },
  ];
  const rsrpClass = (v) => RSRP_CLASSES.find((c) => v >= c.min);

  const SPEED = [
    { max: 3, color: '#d7191c' }, { max: 8, color: '#fdae61' }, { max: 30, color: '#a6d96a' },
    { max: 100, color: '#1a9641' }, { max: Infinity, color: '#0b5d2c' },
  ];
  const speedColor = (dl) => (SPEED.find((c) => dl < c.max) || SPEED[0]).color;

  const fmt = (v, d = 1) => (v == null ? '—' : Number(v).toLocaleString('fr-FR', { maximumFractionDigits: d }));
  const dateFr = (t) => t.slice(8, 10) + '/' + t.slice(5, 7) + '/' + t.slice(0, 4) + ' ' + t.slice(11, 16);

  // ── Couches de la carte principale ─────────────────────────────────────────

  function nperfPopup(t) {
    return `<div class="popup-yele">
      <div class="popup-op"><b>${escapeHtml(t.op)}</b>
        <span class="popup-net" style="background:#1c1c3c">${escapeHtml(t.tech || 'Mobile')}</span>
        <span class="terrain-badge">nPerf</span></div>
      <div class="popup-metrics">
        <div class="popup-metric"><b>${fmt(t.dl)}</b><span>Mbps ↓</span></div>
        <div class="popup-metric"><b>${fmt(t.ul)}</b><span>Mbps ↑</span></div>
        <div class="popup-metric"><b>${fmt(t.ping, 0)}</b><span>ms</span></div>
      </div>
      <div class="terrain-lines">
        Crête ${fmt(t.dlPeak)} ↓ / ${fmt(t.ulPeak)} ↑ Mbps · gigue ${fmt(t.jitter, 0)} ms
        ${t.signal != null ? '<br>Signal ' + t.signal + ' dBm' : ''}
        <br>Serveur : ${escapeHtml(t.serveur || '—')}
      </div>
      <small>Campagne des agents${t.equipe ? ' · équipe ' + t.equipe : ''} · ${dateFr(t.t)}</small>
    </div>`;
  }

  function sitePopup(s) {
    return `<div class="popup-yele">
      <div class="popup-op"><b>Site Orange (eNodeB ${s.id})</b></div>
      <div class="terrain-lines">
        ${s.cellules} cellule${s.cellules > 1 ? 's' : ''} (secteurs) · ${escapeHtml(s.bandes.join(', ') || 'bande inconnue')}
        <br>${s.mesures.toLocaleString('fr-FR')} relevés · meilleur RSRP ${s.meilleurRsrp} dBm
        <br>RSRP moyen reçu ${fmt(s.rsrpMoyen)} dBm
      </div>
      <small>Position estimée à partir des relevés (± ${s.precisionM} m environ), pas la position officielle du pylône.</small>
    </div>`;
  }

  const SITE_ICON = L.divIcon({
    className: 'terrain-site-icon',
    html: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 3 5 21h3l1.2-3.5h5.6L16 21h3L12 3zm-2.1 11.5L12 8.6l2.1 5.9h-4.2z" fill="#ff7900" stroke="#fff" stroke-width="1"/></svg>',
    iconSize: [22, 22], iconAnchor: [11, 20], popupAnchor: [0, -18],
  });

  async function attachToMainMap(map) {
    const data = await load();
    const renderer = L.canvas({ padding: 0.3 });
    const layers = {
      nperf: L.layerGroup(), couverture: L.layerGroup(), sites: L.layerGroup(),
    };
    if (data.nperf) {
      data.nperf.tests.forEach((t) => {
        L.circleMarker([t.lat, t.lng], {
          renderer, radius: 6, weight: 2, color: '#1c1c3c', fillColor: speedColor(t.dl), fillOpacity: 0.95,
        }).bindPopup(nperfPopup(t)).addTo(layers.nperf);
      });
    }
    if (data.tower) {
      const half = data.tower.carreDeg / 2;
      data.tower.couverture.forEach(([lat, lng, rsrp, n]) => {
        const c = rsrpClass(rsrp);
        L.rectangle([[lat - half, lng - half], [lat + half, lng + half]], {
          renderer, weight: 0, fillColor: c.color, fillOpacity: 0.65,
        }).bindPopup(`<div class="popup-yele"><div class="popup-op"><b>Couverture 4G Orange</b></div>
          <div class="terrain-lines">Meilleur RSRP médian : <b>${rsrp} dBm</b><br>${c.label}<br>${n} relevé${n > 1 ? 's' : ''} TowerCollector</div></div>`)
          .addTo(layers.couverture);
      });
      data.tower.sites.forEach((s) => {
        L.marker([s.lat, s.lng], { icon: SITE_ICON }).bindPopup(sitePopup(s)).addTo(layers.sites);
      });
    }

    const box = document.getElementById('terrain-layers');
    if (!box) return;
    const counts = {
      nperf: data.nperf ? data.nperf.tests.length + ' tests' : 'indisponible',
      couverture: data.tower ? data.tower.couverture.length + ' carrés' : 'indisponible',
      sites: data.tower ? data.tower.sites.length + ' sites' : 'indisponible',
    };
    box.querySelectorAll('input[data-terrain]').forEach((input) => {
      const key = input.dataset.terrain;
      input.closest('label').querySelector('small').textContent = counts[key];
      input.disabled = !(key === 'nperf' ? data.nperf : data.tower);
      input.addEventListener('change', () => {
        if (input.checked) layers[key].addTo(map); else map.removeLayer(layers[key]);
        renderLegend();
      });
    });
    function renderLegend() {
      const leg = document.getElementById('terrain-legend');
      const on = (k) => box.querySelector(`input[data-terrain="${k}"]`).checked;
      let html = '';
      if (on('couverture')) {
        html += RSRP_CLASSES.map((c) => `<span><i style="background:${c.color};border-radius:2px"></i>${c.label}</span>`).join('');
      }
      if (on('nperf')) html += '<span><i style="background:#fff;border:2px solid #1c1c3c"></i>Test nPerf (couleur = débit ↓)</span>';
      if (on('sites')) html += '<span><i style="background:#ff7900;border-radius:0;clip-path:polygon(50% 0,100% 100%,0 100%)"></i>Site Orange estimé</span>';
      leg.innerHTML = html;
      leg.style.display = html ? 'flex' : 'none';
      // Les relevés couvrent surtout Ouagadougou : on y amène la carte.
      if (html && map.getZoom() < 11) map.flyTo([12.3714, -1.5197], 12);
    }
  }

  // ── Comparaison Yélé / nPerf par opérateur (vue Opérateurs) ────────────────

  function median(vals) {
    const v = vals.filter((x) => x != null).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  function stats(list) {
    return {
      n: list.length,
      dl: median(list.map((t) => t.dl)),
      ul: median(list.map((t) => t.ul)),
      ping: median(list.map((t) => t.ping)),
      arcep: list.length ? list.filter((t) => t.dl > 2 && (t.ul == null || t.ul > 1)).length / list.length : null,
    };
  }

  function gap(y, n) {
    if (y == null || !n) return '';
    const e = ((y - n) / n) * 100;
    const cls = Math.abs(e) <= 15 ? 'ok' : 'ko';
    return `<span class="terrain-gap ${cls}">${e > 0 ? '+' : ''}${fmt(e, 0)} %</span>`;
  }

  async function renderComparison(yelePoints) {
    const tbody = document.querySelector('#terrain-compare tbody');
    if (!tbody) return;
    const { nperf } = await load();
    if (!nperf) {
      tbody.innerHTML = '<tr><td colspan="6">Relevés nPerf indisponibles.</td></tr>';
      return;
    }
    const yele = yeleMobile(yelePoints);
    const ops = ['Orange', 'Moov Africa', 'Telecel'];
    const pct = (v) => (v == null ? '—' : fmt(v * 100, 0) + ' %');
    tbody.innerHTML = ops.map((op) => {
      const y = stats(yele.filter((t) => t.op === op));
      const n = stats(nperf.tests.filter((t) => t.op === op));
      return `<tr>
        <td><b style="color:${operatorColor(op)}">${op}</b></td>
        <td>${y.n} / ${n.n}</td>
        <td>${fmt(y.dl)} / ${fmt(n.dl)} ${gap(y.dl, n.dl)}</td>
        <td>${fmt(y.ul)} / ${fmt(n.ul)} ${gap(y.ul, n.ul)}</td>
        <td>${fmt(y.ping, 0)} / ${fmt(n.ping, 0)}</td>
        <td>${pct(y.arcep)} / ${pct(n.arcep)}</td>
      </tr>`;
    }).join('');
    const p = nperf.periode;
    document.getElementById('terrain-compare-note').textContent =
      `nPerf : ${nperf.tests.length} tests des agents du ${p[0].split('-').reverse().join('/')} au ${p[1].split('-').reverse().join('/')}. ` +
      `Yélé : tests mobiles de Ouagadougou, toutes dates. Les tests n'ont pas été faits au même moment ni au même endroit : ` +
      `la comparaison porte sur les médianes, pas sur des paires de tests. Écart en vert : moins de 15 %.`;
  }

  return { load, mobileOperator, attachToMainMap, renderComparison, inOuaga };
})();
