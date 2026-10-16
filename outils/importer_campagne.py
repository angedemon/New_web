"""Importe les relevés de terrain dans le tableau de bord (fichiers statiques).

Usage :
    python outils/importer_campagne.py SIGNAL.xlsx Analyse_TowerCollector_Orange.xlsx

Produit :
- data/nperf.json          : tests nPerf de la campagne des agents, nettoyés
- data/couverture_orange.json : couverture 4G Orange (TowerCollector) par carré
                               de ~110 m et sites (eNodeB) à position estimée

Les noms des agents ne sont pas repris (seul le numéro d'équipe est gardé).
Dépendance : openpyxl.
"""

import json
import math
import re
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import openpyxl

SORTIE = Path(__file__).resolve().parent.parent / "data"

# Au-delà, la valeur est une erreur de saisie ou de mesure (ex. gigue 2016 ms).
MAX_LATENCE_MS = 1000
MAX_GIGUE_MS = 500
MAX_TRAFIC_MIO = 1000


def nombre(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    m = re.search(r"-?\d+(?:[.,]\d+)?", str(v))
    return float(m.group().replace(",", ".")) if m else None


def lignes(path, feuille=0):
    ws = openpyxl.load_workbook(path, read_only=True, data_only=True).worksheets[feuille]
    rows = list(ws.iter_rows(values_only=True))
    entete = rows[0]
    for r in rows[1:]:
        if any(c is not None for c in r):
            yield {k: (r[i] if i < len(r) else None) for i, k in enumerate(entete)}


def distance_m(lat1, lon1, lat2, lon2):
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    return 6_371_000 * math.hypot(dlat, dlon)


# ── nPerf ─────────────────────────────────────────────────────────────────────

def operateur(*textes):
    for t in textes:
        t = (t or "").lower()
        if "613:2" in t or "orange" in t:
            return "Orange"
        if "613:3" in t or "telecel" in t:
            return "Telecel"
        if "613:1" in t or "moov" in t or "onatel" in t:
            return "Moov Africa"
    return None


def techno(t):
    t = (t or "").upper()
    if t.startswith("WIFI"):
        return "WiFi"
    if t.startswith("5G"):
        return "5G"
    if t.startswith("4G"):
        return "4G"
    if t.startswith("3G"):
        return "3G"
    if t.startswith("2G"):
        return "2G"
    return ""


def borne(v, maxi):
    return None if v is None or v < 0 or v > maxi else v


def importer_nperf(path):
    rejets = Counter()
    vus = set()
    tests = []
    for r in lignes(path):
        d = r.get("date")
        lat, lng = nombre(r.get("lat")), nombre(r.get("lng"))
        if not isinstance(d, datetime):
            rejets["sans date"] += 1
            continue
        if not lat or not lng:
            rejets["sans position GPS"] += 1
            continue
        tech = techno(r.get("techno"))
        if tech == "WiFi":
            rejets["test en Wi-Fi"] += 1
            continue
        op = operateur(r.get("operateur"), r.get("reseau"))
        if not op:
            rejets["opérateur inconnu"] += 1
            continue
        serveur = str(r.get("serveur") or "")
        if serveur.startswith(("[TG]", "[NE]")):
            rejets["serveur hors Burkina (Togo, Niger)"] += 1
            continue
        dl, ul = nombre(r.get("debit_descendant")), nombre(r.get("debit_montant"))
        if not dl:
            rejets["sans débit"] += 1
            continue
        cle = (round(lat, 5), round(lng, 5), dl, ul, op)
        if cle in vus:
            rejets["doublon (même test saisi deux fois)"] += 1
            continue
        vus.add(cle)
        smin, smax = nombre(r.get("signal_min")), nombre(r.get("signal_max"))
        sig = [s for s in (nombre(r.get("signal")), smin, smax) if s is not None and -140 < s < -30]
        tests.append({
            # Heure locale du Burkina Faso = UTC.
            "t": d.replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M"),
            "lat": round(lat, 6), "lng": round(lng, 6),
            "op": op, "tech": tech,
            "dl": dl, "ul": ul,
            "dlPeak": nombre(r.get("debit_desc_crete")),
            "ulPeak": nombre(r.get("debit_mont_crete")),
            "ping": borne(nombre(r.get("latence")), MAX_LATENCE_MS),
            "jitter": borne(nombre(r.get("gigue")), MAX_GIGUE_MS),
            "signal": round(statistics.mean(sig)) if sig else None,
            "trafficMB": borne(nombre(r.get("trafic_mio")), MAX_TRAFIC_MIO),
            "equipe": int(r["equipe"]) if isinstance(r.get("equipe"), (int, float)) else None,
            "serveur": serveur or None,
        })
    tests.sort(key=lambda x: x["t"])
    return tests, rejets


# ── TowerCollector ───────────────────────────────────────────────────────────

CARRE_DEG = 0.001  # ≈ 110 m


def bande(tech, arfcn):
    a = nombre(arfcn)
    if a is None:
        return None
    a = int(a)
    if tech.startswith("4G"):
        for lo, hi, nom in [(0, 599, "B1 2100 MHz"), (1200, 1949, "B3 1800 MHz"),
                            (2750, 3449, "B7 2600 MHz"), (3450, 3799, "B8 900 MHz"),
                            (6150, 6449, "B20 800 MHz"), (9210, 9659, "B28 700 MHz")]:
            if lo <= a <= hi:
                return nom
    if tech.startswith("3G"):
        if 10562 <= a <= 10838:
            return "3G 2100 MHz"
        if 2937 <= a <= 3088:
            return "3G 900 MHz"
    if tech.startswith("2G"):
        return "2G 900 MHz" if a <= 124 else "2G 1800 MHz"
    return None


def importer_tower(path):
    releves = list(lignes(path, 0))
    # 1) Couverture : à chaque instant, le téléphone voit plusieurs cellules ;
    #    le meilleur RSRP 4G est celui dont bénéficierait l'abonné.
    instants = defaultdict(list)
    for r in releves:
        rsrp = nombre(r.get("rsrp"))
        if str(r.get("techno", "")).startswith("4G") and rsrp is not None and -140 < rsrp < -40:
            instants[(r["measured_at"], r["lat"], r["lon"])].append(rsrp)
    carres = defaultdict(list)
    for (_, lat, lon), vals in instants.items():
        carres[(math.floor(lat / CARRE_DEG), math.floor(lon / CARRE_DEG))].append(max(vals))
    couverture = [
        [round((a + 0.5) * CARRE_DEG, 5), round((b + 0.5) * CARRE_DEG, 5),
         round(statistics.median(v)), len(v)]
        for (a, b), v in carres.items()
    ]

    # 2) Sites : un eNodeB (pylône 4G) porte plusieurs cellules. Sa position
    #    n'est pas dans le relevé ; on l'estime par le barycentre des mesures
    #    où il est reçu le plus fort (pondéré par la puissance reçue).
    par_site = defaultdict(list)
    for r in releves:
        site = r.get("site (eNodeB)")
        sig = nombre(r.get("rsrp")) if r.get("rsrp") not in (None, "") else nombre(r.get("signal (dBm)"))
        if site and sig is not None and str(r.get("techno", "")).startswith("4G"):
            par_site[int(site)].append((sig, r["lat"], r["lon"], str(r["cell_id"]), bande("4G", r.get("arfcn"))))
    sites = []
    for site, mes in par_site.items():
        mes.sort(key=lambda m: m[0], reverse=True)
        top = mes[:max(5, len(mes) // 10)][:30]
        poids = [10 ** ((m[0] - top[0][0]) / 10) for m in top]
        w = sum(poids)
        lat = sum(p * m[1] for p, m in zip(poids, top)) / w
        lon = sum(p * m[2] for p, m in zip(poids, top)) / w
        dispersion = math.sqrt(sum(p * distance_m(lat, lon, m[1], m[2]) ** 2 for p, m in zip(poids, top)) / w)
        sites.append({
            "id": site, "lat": round(lat, 5), "lng": round(lon, 5),
            "precisionM": max(50, round(dispersion / 10) * 10),
            "cellules": len({m[3] for m in mes}),
            "bandes": sorted({m[4] for m in mes if m[4]}),
            "mesures": len(mes),
            "meilleurRsrp": round(top[0][0]),
            "rsrpMoyen": round(statistics.mean(m[0] for m in mes), 1),
        })
    sites.sort(key=lambda s: -s["mesures"])

    dates = sorted(r["measured_at"] for r in releves)
    resume = {
        "operateur": "Orange",
        "periode": [dates[0][:10], dates[-1][:10]],
        "releves": len(releves),
        "cellules": len({str(r["cell_id"]) for r in releves}),
        "parTechno": dict(Counter(str(r.get("techno")) for r in releves)),
        "parBande": dict(Counter(b for b in (bande(str(r.get("techno", "")), r.get("arfcn")) for r in releves) if b)),
    }
    return {"resume": resume, "carreDeg": CARRE_DEG, "couverture": couverture, "sites": sites}


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    SORTIE.mkdir(exist_ok=True)

    tests, rejets = importer_nperf(sys.argv[1])
    nperf = {
        "source": "nPerf — campagne des agents",
        "periode": [tests[0]["t"][:10], tests[-1]["t"][:10]] if tests else None,
        "rejets": dict(rejets),
        "tests": tests,
    }
    (SORTIE / "nperf.json").write_text(json.dumps(nperf, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"nPerf : {len(tests)} tests gardés ; rejetés : {dict(rejets)}")
    print("  par opérateur :", dict(Counter(t["op"] for t in tests)))

    tower = importer_tower(sys.argv[2])
    (SORTIE / "couverture_orange.json").write_text(json.dumps(tower, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"TowerCollector : {len(tower['couverture'])} carrés de couverture, {len(tower['sites'])} sites estimés")
    print("  ", tower["resume"])


if __name__ == "__main__":
    main()
