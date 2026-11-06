// ─── Limites administratives officielles du Burkina Faso ─────────────────────
// Régions (17, découpage de 2025), provinces (47) et communes (352), converties
// depuis les couches officielles (shapefiles WGS84) et allégées pour le web :
// data/limites/{regions,provinces,communes}.geojson.
//
// Sert à deux choses :
//  - afficher les limites sur une carte Leaflet, colorées selon le débit
//    médian des mesures de chaque entité, avec ses statistiques au clic ;
//  - situer une mesure dans sa commune (et donc sa province et sa région),
//    pour les statistiques et les rapports par zone.

const Limites = (() => {
  const LEVELS = {
    regions: { file: 'data/limites/regions.geojson', label: 'Région', key: (p) => p.nom },
    provinces: { file: 'data/limites/provinces.geojson', label: 'Province', key: (p) => p.nom },
    communes: { file: 'data/limites/communes.geojson', label: 'Commune', key: (p) => p.nom },
  };
  const cache = {};

  // Mêmes classes de débit que la couche « Carte de débit ».
  const SPEED = [
    { max: 3, color: '#d7191c', label: '< 3 Mb/s' },
    { max: 8, color: '#fdae61', label: '3 – 8' },
    { max: 30, color: '#a6d96a', label: '8 – 30' },
    { max: 100, color: '#1a9641', label: '30 – 100' },
    { max: Infinity, color: '#0b5d2c', label: '> 100 Mb/s' },
  ];
  const speedColor = (v) => (SPEED.find((c) => v < c.max) || SPEED[0]).color;
  const MIN_TESTS = 3; // en dessous, l'entité n'est pas colorée : trop peu de mesures

  function bbox(geom) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const poly of geom.coordinates) {
      for (const ring of poly) {
        for (const [x, y] of ring) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    return [minX, minY, maxX, maxY];
  }

  async function load(level) {
    if (!cache[level]) {
      cache[level] = fetch(LEVELS[level].file)
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then((fc) => { fc.features.forEach((f) => { f.bbox = bbox(f.geometry); }); return fc; });
    }
    return cache[level];
  }

  // Point dans un anneau (lancer de rayon).
  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function contains(f, lat, lng) {
    const b = f.bbox;
    if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) return false;
    return f.geometry.coordinates.some((poly) => inRing(lng, lat, poly[0]));
  }

  /// Commune (propriétés nom, province, région) qui contient le point, ou null.
  /// Charge les communes au premier appel.
  async function locator() {
    const fc = await load('communes');
    return (lat, lng) => {
      if (!lat || !lng) return null;
      const f = fc.features.find((x) => contains(x, lat, lng));
      return f ? f.properties : null;
    };
  }

  const median = (a) => {
    const s = a.filter((v) => v != null && isFinite(v)).sort((x, y) => x - y);
    if (!s.length) return null;
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const fmt = (v, d = 1) => (v == null ? '—' : Number(v).toLocaleString('fr-FR', { maximumFractionDigits: d }));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /// Regroupe des mesures {lat, lng, download, upload, ping} par entité du
  /// niveau choisi. Renvoie Map(nom → {n, dl, ul, ping}).
  async function statsBy(level, points) {
    const locate = await locator();
    const groups = new Map();
    for (const p of points) {
      const c = locate(p.lat, p.lng);
      if (!c) continue;
      const name = level === 'communes' ? c.nom : level === 'provinces' ? c.province : c.region;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(p);
    }
    const out = new Map();
    groups.forEach((list, name) => out.set(name, {
      n: list.length,
      dl: median(list.map((p) => p.download)),
      ul: median(list.map((p) => p.upload)),
      ping: median(list.map((p) => p.ping)),
    }));
    return out;
  }

  /// Couche Leaflet des limites d'un niveau, colorée selon le débit médian.
  async function layer(level, points) {
    const [fc, stats] = await Promise.all([load(level), statsBy(level, points)]);
    const L_ = LEVELS[level];
    return L.geoJSON(fc, {
      style: (f) => {
        const s = stats.get(L_.key(f.properties));
        const colored = s && s.n >= MIN_TESTS && s.dl != null;
        return {
          color: '#1c1c3c',
          weight: level === 'communes' ? 0.8 : level === 'provinces' ? 1.3 : 2,
          opacity: 0.7,
          fillColor: colored ? speedColor(s.dl) : '#9aa1b1',
          fillOpacity: colored ? 0.38 : 0.04,
        };
      },
      onEachFeature: (f, lyr) => {
        const p = f.properties;
        const s = stats.get(L_.key(p));
        const where = [p.province && `Province : ${esc(p.province)}`, p.region && `Région : ${esc(p.region)}`].filter(Boolean).join('<br>');
        lyr.bindTooltip(esc(p.nom), { sticky: true, direction: 'top', opacity: 0.9 });
        lyr.bindPopup(`<div class="popup-yele">
          <div class="popup-op"><b>${L_.label} de ${esc(p.nom)}</b></div>
          ${where ? `<small>${where}</small>` : ''}
          ${s ? `<div class="popup-metrics">
              <div class="popup-metric"><b>${fmt(s.dl)}</b><span>Mbps ↓ méd.</span></div>
              <div class="popup-metric"><b>${fmt(s.ul)}</b><span>Mbps ↑ méd.</span></div>
              <div class="popup-metric"><b>${fmt(s.ping, 0)}</b><span>ms méd.</span></div>
            </div><small>${s.n} test${s.n > 1 ? 's' : ''}${s.n < MIN_TESTS ? ' : trop peu pour colorer la zone' : ''}</small>`
            : '<small>Aucun test dans cette zone pour l\'instant.</small>'}
        </div>`);
        lyr.on('mouseover', () => lyr.setStyle({ weight: 2.5, opacity: 1 }));
        lyr.on('mouseout', () => lyr.setStyle({ weight: level === 'communes' ? 0.8 : level === 'provinces' ? 1.3 : 2, opacity: 0.7 }));
      },
    });
  }

  /// Bloc « Limites administratives » du panneau de la carte principale.
  function attachToMainMap(map, getPoints) {
    const box = document.getElementById('limits-mode');
    const legend = document.getElementById('limits-legend');
    if (!box) return;
    let current = null;
    let level = '';
    async function show(next) {
      level = next;
      box.querySelectorAll('[data-limits]').forEach((b) => b.classList.toggle('active', b.dataset.limits === next));
      if (current) { map.removeLayer(current); current = null; }
      legend.style.display = next ? 'flex' : 'none';
      if (!next) return;
      legend.innerHTML = '<span>Chargement des limites…</span>';
      try {
        const pts = getPoints().filter((p) => p.lat && p.lng && p.download > 0);
        const lyr = await layer(next, pts);
        if (level !== next) return; // un autre niveau a été choisi entre-temps
        current = lyr.addTo(map);
        legend.innerHTML = SPEED.map((c) => `<span><i style="background:${c.color}"></i>${c.label}</span>`).join('') +
          `<span>Débit ↓ médian · gris = moins de ${MIN_TESTS} tests</span>`;
      } catch (e) {
        legend.innerHTML = '<span>Limites indisponibles.</span>';
      }
    }
    box.querySelectorAll('[data-limits]').forEach((b) => b.addEventListener('click', () => show(b.dataset.limits)));
  }

  return { load, locator, statsBy, layer, attachToMainMap, LEVELS };
})();
