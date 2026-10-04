#!/usr/bin/env python3
"""Les réponses de référence de la mission « festival », calculées depuis missions/entrees/festival/.

Le juge compare la page à ces chiffres-là. Les conventions suivies ici sont
exactement celles que la mission énonce. Le programme d'un festivalier se calcule par un plus long
chemin dans le graphe des concerts compatibles, avec les départages de la mission dans la clé.
"""
import csv, sys
from collections import defaultdict
from functools import lru_cache
from pathlib import Path

ENTREES = Path(__file__).resolve().parent.parent / "missions" / "entrees" / "festival"


def lire(nom):
    with open(ENTREES / nom, encoding="utf-8") as f:
        return list(csv.DictReader(f, delimiter=";"))


def minutes(s):
    """Heure de festival : avant midi, c'est la nuit qui suit (01:30 → 25:30)."""
    h, m = int(s[:2]), int(s[3:])
    t = h * 60 + m
    return t + 24 * 60 if h < 12 else t


def hm(t):
    t %= 24 * 60
    return f"{t // 60:02d}:{t % 60:02d}"


scenes = {s["id"]: s for s in lire("scenes.csv")}
concerts = lire("concerts.csv")
for c in concerts:
    c["d"], c["f"], c["aff"] = minutes(c["debut"]), minutes(c["fin"]), int(c["affluence"])
par_id = {c["id"]: c for c in concerts}
marche = {(m["de"], m["vers"]): int(m["minutes"]) for m in lire("marche.csv")}
festivaliers = {f["id"]: f for f in lire("festivaliers.csv")}
envies = defaultdict(dict)
for e in lire("envies.csv"):
    envies[e["festivalier"]][e["concert"]] = int(e["priorite"])
JOURS = sorted({c["jour"] for c in concerts})


def m(a, b):
    return 0 if a == b else marche[(a, b)]


def programme(fid, jour, envies_f=None, arrivee=None, depart=None):
    """Le meilleur programme d'un jour : le plus de points ; à égalité, le plus de concerts ; puis le moins
    de marche ; puis la fin la plus tôt ; puis la liste d'identifiants la plus petite dans l'ordre des horaires."""
    f = festivaliers[fid]
    env = envies_f if envies_f is not None else envies[fid]
    a0 = minutes(arrivee or f["arrivee"])
    d0 = minutes(depart or f["depart_limite"])
    cand = sorted((c for c in concerts if c["jour"] == jour and c["id"] in env), key=lambda c: (c["d"], c["id"]))
    cand = [c for c in cand if a0 + m("ENT", c["scene"]) <= c["d"] and c["f"] + m(c["scene"], "ENT") <= d0]

    @lru_cache(None)
    def meilleur(i):
        """La meilleure suite qui commence par cand[i] : (clé, liste)."""
        c = cand[i]
        best = None
        for j in range(len(cand)):
            n = cand[j]
            if n["d"] >= c["f"] + m(c["scene"], n["scene"]) and n["id"] != c["id"]:
                k, l = meilleur(j)
                k2 = (k[0], k[1], k[2] + m(c["scene"], n["scene"]), k[3])
                if best is None or cle(k2, l) > cle(best[0], best[1]):
                    best = (k2, l)
        if best is None:
            return ((env[c["id"]], 1, m(c["scene"], "ENT"), c["f"]), (c["id"],))
        k, l = best
        return ((k[0] + env[c["id"]], k[1] + 1, k[2], k[3]), (c["id"],) + l)

    def cle(k, l):
        # plus de points, plus de concerts, moins de marche, fin plus tôt, identifiants plus petits
        return (k[0], k[1], -k[2], -k[3], tuple(-int(x[1:]) for x in l))

    best = None
    for i, c in enumerate(cand):
        k, l = meilleur(i)
        k = (k[0], k[1], k[2] + m("ENT", c["scene"]), k[3])
        if best is None or cle(k, l) > cle(*best):
            best = (k, l)
    if best is None:
        return {"points": 0, "concerts": [], "marche": 0}
    k, l = best
    return {"points": k[0], "concerts": list(l), "marche": k[2]}


def foule(jour):
    """Foule du site à chaque début de concert (le maximum ne peut tomber qu'à un début)."""
    cs = [c for c in concerts if c["jour"] == jour]
    pics = []
    for t in sorted({c["d"] for c in cs}):
        pics.append((sum(c["aff"] for c in cs if c["d"] <= t < c["f"]), t))
    return max(pics, key=lambda p: (p[0], -p[1]))


def foule_a(jour, t):
    return sum(c["aff"] for c in concerts if c["jour"] == jour and c["d"] <= t < c["f"])


if __name__ == "__main__":
    print("== le programme ==")
    print(len(concerts), "concerts,", len({c['artiste'] for c in concerts}), "artistes,", len({c['genre'] for c in concerts}), "genres")
    for j in JOURS:
        print(j, sum(1 for c in concerts if c["jour"] == j), "concerts ;", {s: sum(1 for c in concerts if c["jour"] == j and c["scene"] == s) for s in scenes if s != "ENT"})
    print("minutes de musique :", sum(c["f"] - c["d"] for c in concerts))
    apres = [c for c in concerts if c["f"] > 24 * 60]
    print("concerts qui finissent après minuit :", len(apres), "; le plus tard :", max(apres, key=lambda c: c["f"])["id"], hm(max(c["f"] for c in concerts)))
    print("par genre :", dict(sorted(((g, sum(1 for c in concerts if c["genre"] == g)) for g in {c["genre"] for c in concerts}), key=lambda x: -x[1])))

    print("\n== erreurs et alertes ==")
    for j in JOURS:
        for s in scenes:
            cs = sorted((c for c in concerts if c["jour"] == j and c["scene"] == s), key=lambda c: c["d"])
            for a, b in zip(cs, cs[1:]):
                if b["d"] < a["f"]:
                    print("chevauchement :", a["id"], a["artiste"], a["debut"], "-", a["fin"], "/", b["id"], b["artiste"], b["debut"], "-", b["fin"], s, j)
    trop = [c for c in concerts if c["aff"] > int(scenes[c["scene"]]["capacite"])]
    print("affluence au-delà de la capacité :", len(trop), [(c["id"], c["scene"], c["aff"]) for c in trop][:12])

    print("\n== la foule ==")
    for j in JOURS:
        v, t = foule(j)
        print(j, "pic", v, "à", hm(t), "; à 22:00 :", foule_a(j, 22 * 60), "; à 01:00 :", foule_a(j, 25 * 60))

    print("\n== la marche ==")
    print("Clairière → Serre", marche[("CLA", "SER")], "; Serre → Clairière", marche[("SER", "CLA")], "; Entrée → Docks", marche[("ENT", "DOC")])

    print("\n== les programmes ==")
    for fid, f in festivaliers.items():
        tot = 0
        lignes = []
        for j in JOURS:
            p = programme(fid, j)
            tot += p["points"]
            lignes.append(f"{j[8:]}: {p['points']}pts {len(p['concerts'])}c {p['marche']}min {','.join(p['concerts'])}")
        print(f"{fid} {f['nom']} ({f['arrivee']}→{f['depart_limite']}, {len(envies[fid])} envies) total {tot} pts")
        for l in lignes:
            print("    ", l)
