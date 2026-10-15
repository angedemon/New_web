// ─── Score global Yélé 0-100 (IMP-05 / IMP-12) ──────────────────────────────
// Copie fidèle de lib/services/scoring.dart (application mobile) : le score
// affiché ici doit être identique à celui de l'app et de son historique.
// Toute modification se fait des deux côtés ; l'échelle est décrite dans
// docs/SCORE.md du dépôt mobilefront.

const YeleScore = (() => {
  function logScale(v, zeroAt, fullAt) {
    if (v <= zeroAt) return 0;
    if (v >= fullAt) return 100;
    return 100 * Math.min(1, Math.max(0, Math.log(v / zeroAt) / Math.log(fullAt / zeroAt)));
  }

  const download = (mbps) => logScale(mbps, 0.25, 100);
  const upload = (mbps) => logScale(mbps, 0.1, 50);

  function latency(ms) {
    if (ms <= 0) return 0;
    if (ms <= 20) return 100;
    if (ms >= 500) return 0;
    return 100 * (1 - Math.log(ms / 20) / Math.log(500 / 20));
  }

  // Pondération 30/15/15/20/20, composantes absentes retirées.
  function global({ download: dl, upload: ul, ping, browsingScore, streamingScore }) {
    const parts = [];
    if (dl > 0) parts.push([download(dl), 30]);
    if (ul > 0) parts.push([upload(ul), 15]);
    if (ping > 0) parts.push([latency(ping), 15]);
    if (browsingScore > 0) parts.push([browsingScore, 20]);
    if (streamingScore > 0) parts.push([streamingScore, 20]);
    if (!parts.length) return 0;
    const w = parts.reduce((s, p) => s + p[1], 0);
    return Math.round(parts.reduce((s, p) => s + p[0] * p[1], 0) / w * 10) / 10;
  }

  // Score d'une mesure : celui calculé par l'app s'il existe, sinon la même
  // formule (mesures antérieures à son envoi).
  function of(p) {
    if (p.globalScore > 0) return p.globalScore;
    return global({
      download: parseFloat(p.download) || 0,
      upload: parseFloat(p.upload) || 0,
      ping: parseFloat(p.ping) || 0,
      browsingScore: p.browsingScore || 0,
      streamingScore: p.streamingScore || 0,
    });
  }

  // Mêmes paliers que l'application.
  function band(score) {
    if (score >= 80) return { label: 'Excellent', level: 4 };
    if (score >= 60) return { label: 'Bon', level: 3 };
    if (score >= 40) return { label: 'Moyen', level: 2 };
    if (score >= 20) return { label: 'Faible', level: 1 };
    return { label: 'Très faible', level: 0 };
  }

  return { global, of, band };
})();
