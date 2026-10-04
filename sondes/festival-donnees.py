#!/usr/bin/env python3
"""Génère les données de la mission « festival » dans missions/entrees/festival/.

Déterministe (graine fixe). Un festival de musique de quatre jours, six scènes, une entrée.
Les pièges sont posés volontairement :
- des concerts qui finissent ou commencent après minuit, écrits « 01:30 » mais qui appartiennent
  à la journée de festival de la veille ;
- une marche qui n'a pas la même durée dans les deux sens (la Serre est en haut d'une pente) ;
- une erreur dans le programme : deux concerts qui se chevauchent sur la même scène ;
- des concerts dont l'affluence prévue dépasse la capacité de la scène ;
- des festivaliers qui arrivent tard ou doivent partir avant la fin (dernier train).
"""
import csv, math, random
from pathlib import Path

SORTIE = Path(__file__).resolve().parent.parent / "missions" / "entrees" / "festival"
JOURS = ["2026-07-09", "2026-07-10", "2026-07-11", "2026-07-12"]  # jeudi → dimanche

# id, nom, capacité, x, y (mètres, plan du site), ouverture, fermeture (heure de festival, > 24 h = après minuit)
SCENES = [
    ("GRA", "Grande Scène", 30000, 420, 180, 16 * 60, 24 * 60 + 30),
    ("CLA", "La Clairière", 8000, 150, 320, 15 * 60, 24 * 60),
    ("CHA", "Le Chapiteau", 5000, 620, 380, 17 * 60, 27 * 60),
    ("DOC", "Les Docks", 4000, 700, 90, 20 * 60, 28 * 60),
    ("SER", "La Serre", 1200, 260, 520, 14 * 60 + 30, 23 * 60),
    ("KIO", "Le Kiosque", 600, 480, 440, 14 * 60, 22 * 60),
]
ENTREE = ("ENT", "Entrée", 0, 60, 60)
PENTE = ("SER", 1.4)  # monter vers la Serre coûte 40 % de plus

GENRES = {
    "GRA": ["rock", "pop", "hip-hop", "électro"], "CLA": ["folk", "pop", "chanson", "world"],
    "CHA": ["électro", "hip-hop", "rock"], "DOC": ["techno", "électro"],
    "SER": ["jazz", "chanson", "folk"], "KIO": ["chanson", "jazz", "world", "folk"],
}
MOTS_A = ["Les", "The", "Nuit", "Velours", "Cobalt", "Marée", "Orage", "Lumen", "Papier", "Sable", "Neon", "Argile",
          "Silex", "Comète", "Brume", "Ivoire", "Fauve", "Onde", "Lichen", "Rivage", "Zinc", "Opale", "Ambre", "Givre"]
MOTS_B = ["Sauvages", "Machines", "Tropiques", "Lointaines", "Électriques", "du Nord", "Club", "Orchestra", "Collectif",
          "Sisters", "Brothers", "Parade", "Radio", "Express", "Quartet", "Sound System", "Nomades", "Fantômes",
          "Jardins", "Satellites", "Vagues", "Atlas", "Cendres", "Lanternes"]


def hm(m):
    m %= 24 * 60
    return f"{m // 60:02d}:{m % 60:02d}"


def generer():
    r = random.Random(20260926)
    SORTIE.mkdir(parents=True, exist_ok=True)
    noms = set()

    def artiste():
        while True:
            n = f"{r.choice(MOTS_A)} {r.choice(MOTS_B)}"
            if n not in noms:
                noms.add(n)
                return n

    concerts = []
    n = 0
    for jour in JOURS:
        for sid, _, cap, _, _, ouv, ferm in SCENES:
            t = ouv + r.choice([0, 0, 15, 30])
            while True:
                duree = r.choice([45, 60, 60, 75, 90]) if sid not in ("GRA", "DOC") else r.choice([60, 75, 90, 105, 120])
                if t + duree > ferm:
                    break
                n += 1
                pop = r.choices([1, 2, 3, 4, 5], weights=[3, 4, 4, 2, 1])[0]
                affluence = int(round(cap * (0.25 + 0.2 * pop) * r.uniform(0.8, 1.15), -1))
                concerts.append({"id": f"C{n:03d}", "artiste": artiste(), "genre": r.choice(GENRES[sid]), "scene": sid,
                                 "jour": jour, "debut": t, "fin": t + duree, "affluence": affluence})
                t += duree + r.choice([15, 20, 30, 30, 45])
    # l'erreur du programme : le samedi, à la Serre, un concert commence 20 minutes avant la fin du précédent
    serre = [c for c in concerts if c["jour"] == "2026-07-11" and c["scene"] == "SER"]
    faute = serre[2]
    decalage = faute["debut"] - (serre[1]["fin"] - 20)
    for c in serre[2:]:
        c["debut"] -= decalage
        c["fin"] -= decalage
    for c in concerts:
        c["debut"], c["fin"] = hm(c["debut"]), hm(c["fin"])

    lieux = [ENTREE[:1] + ENTREE[1:]] + [(s[0], s[1], s[2], s[3], s[4]) for s in SCENES]
    pos = {l[0]: (l[3], l[4]) for l in lieux}
    marche = []
    for a in pos:
        for b in pos:
            if a == b:
                continue
            m = math.dist(pos[a], pos[b]) / 70  # 70 m par minute dans la foule
            if b == PENTE[0]:
                m *= PENTE[1]
            marche.append({"de": a, "vers": b, "minutes": max(2, round(m))})

    festivaliers = [
        ("F1", "Inès", "14:00", "04:00"), ("F2", "Marc", "14:00", "01:10"), ("F3", "Sofia", "18:30", "04:00"),
        ("F4", "Karim", "16:00", "02:00"), ("F5", "Jeanne", "14:00", "23:30"), ("F6", "Omar", "20:00", "04:00"),
        ("F7", "Clara", "15:00", "03:00"), ("F8", "Basile", "14:00", "04:00"),
    ]
    envies = []
    for fid, *_ in festivaliers:
        gouts = r.sample(sorted({g for gs in GENRES.values() for g in gs}), 3)
        for c in concerts:
            p = 0.45 if c["genre"] in gouts else 0.07
            if r.random() < p:
                envies.append({"festivalier": fid, "concert": c["id"], "priorite": r.choices([1, 2, 3], weights=[4, 3, 2])[0]})

    def ecrire(nom, colonnes, lignes):
        with open(SORTIE / nom, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=colonnes, delimiter=";")
            w.writeheader()
            w.writerows(lignes)
        print(f"{nom} : {len(lignes)} lignes, {(SORTIE / nom).stat().st_size} octets")

    ecrire("scenes.csv", ["id", "nom", "capacite", "x", "y", "ouverture", "fermeture"],
           [{"id": s[0], "nom": s[1], "capacite": s[2], "x": s[3], "y": s[4], "ouverture": hm(s[5]), "fermeture": hm(s[6])} for s in SCENES]
           + [{"id": ENTREE[0], "nom": ENTREE[1], "capacite": 0, "x": ENTREE[3], "y": ENTREE[4], "ouverture": "", "fermeture": ""}])
    ecrire("concerts.csv", ["id", "artiste", "genre", "scene", "jour", "debut", "fin", "affluence"], concerts)
    ecrire("marche.csv", ["de", "vers", "minutes"], marche)
    ecrire("festivaliers.csv", ["id", "nom", "arrivee", "depart_limite"],
           [{"id": f, "nom": n, "arrivee": a, "depart_limite": d} for f, n, a, d in festivaliers])
    ecrire("envies.csv", ["festivalier", "concert", "priorite"], envies)


if __name__ == "__main__":
    generer()
