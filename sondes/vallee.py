#!/usr/bin/env python3
"""Le moteur de référence de la mission « ligne » : une année de trains en montagne, minute par minute.

Lit le dossier ENTREES (missions/entrees/ligne/ par sondes/ligne-references.py), applique les règles de
missions/ligne.md à la lettre, en entiers (aucun flottant ne décide de rien). Sert au juge : positions des trains à une minute donnée, retards gare par
gare, causes d'attente, voyageurs, ardoise, neige. Usage :
    python3 sondes/vallee.py [reglage=valeur ...]            le bilan de l'année
    python3 sondes/vallee.py --train 203 --date 2027-02-03    un train, gare par gare
    python3 sondes/vallee.py --instant 2027-02-12T08:17       où sont les trains
"""
import csv, sys
from datetime import date, timedelta
from pathlib import Path

ENTREES = Path(__file__).resolve().parent.parent / "missions" / "entrees" / "vallee"
ANNEE = 2027
JOURS = 365
MINUTES = JOURS * 1440
DEBUT_ETE, FIN_ETE = date(2027, 6, 21), date(2027, 9, 22)
ATTENTE_SUPPRESSION = 180   # un train qui n'a pas pu partir de son origine 180 min après l'heure est supprimé
ATTENTE_LIMITATION = 360    # un train bloqué en gare 360 min au-delà de son horaire y est limité
TUNNEL_KMH = 40
ARRET = {"E": 2, "T": 5, "N": 0, "M": 0}  # l'omnibus : réglage arret_omnibus


def lire(nom):
    with open(ENTREES / nom, newline="") as f:
        return list(csv.DictReader(f))


def hm(s):
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def texte_minute(t):
    j = date(ANNEE, 1, 1) + timedelta(days=t // 1440)
    return f"{j.isoformat()} {t % 1440 // 60:02d}:{t % 60:02d}"


class Reseau:
    def __init__(self):
        self.gares = {g["code"]: g for g in lire("gares.csv")}
        for g in self.gares.values():
            g["pk"] = round(float(g["pk"]) * 1000)  # en mètres
            g["altitude"], g["croisement_m"], g["voyageurs_jour"] = int(g["altitude"]), int(g["croisement_m"]), int(g["voyageurs_jour"])
        self.principale = [c for c, g in self.gares.items() if g["ligne"] == "principale"]
        self.croisement = {c for c, g in self.gares.items() if g["croisement_m"] > 0}
        self.terminus = {"VP", "CS", "CL"}
        self.ouvrages = [dict(o, pk_debut=round(float(o["pk_debut"]) * 1000), pk_fin=round(float(o["pk_fin"]) * 1000)) for o in lire("ouvrages.csv")]
        self.materiel = {m["type"]: {k: (int(v) if k not in ("type", "nom") else v) for k, v in m.items()} for m in lire("materiel.csv")}

    def route(self, dep, arr):
        """La suite des gares parcourues, dans l'ordre (la branche se prend à Pont-de-Varre)."""
        def chemin(c):
            return self.principale[: self.principale.index("PV") + 1] + ["CL"] if c == "CL" else self.principale
        if "CL" in (dep, arr):
            ch = chemin("CL")
        else:
            ch = self.principale
        i, j = ch.index(dep), ch.index(arr)
        return ch[i : j + 1] if i < j else list(reversed(ch[j : i + 1]))

    def troncon(self, a, b):
        """Longueur (m), pente (‰, entier), mètres en tunnel, sens montant, ligne."""
        ga, gb = self.gares[a], self.gares[b]
        ligne = "branche" if "CL" in (a, b) else "principale"
        if ligne == "branche":
            lo, hi = 0, gb["pk"] if b == "CL" else ga["pk"]
        else:
            lo, hi = min(ga["pk"], gb["pk"]), max(ga["pk"], gb["pk"])
        long_m = hi - lo
        tunnel = sum(max(0, min(hi, o["pk_fin"]) - max(lo, o["pk_debut"])) for o in self.ouvrages if o["ligne"] == ligne and o["nature"] == "tunnel")
        pente = abs(gb["altitude"] - ga["altitude"]) * 1000 // long_m
        return long_m, pente, tunnel, gb["altitude"] > ga["altitude"], ligne

    def canton(self, a, b):
        """Le canton qui contient le tronçon a→b : nommé par ses deux gares à croisement, dans l'ordre de la ligne."""
        ch = self.principale if "CL" not in (a, b) else ["PV", "CL"]
        if "CL" in (a, b):
            return "PV-CL"
        i, j = sorted((ch.index(a), ch.index(b)))
        g = i
        while ch[g] not in self.croisement:
            g -= 1
        d = j
        while ch[d] not in self.croisement:
            d += 1
        return f"{ch[g]}-{ch[d]}"

    def minutes_troncon(self, typ, a, b, neige_lente, vitesse_neige):
        m = self.materiel[typ]
        long_m, pente, tunnel, monte, _ = self.troncon(a, b)
        v = m["vitesse_plat"] * (100 - pente) // 100 if monte else m["vitesse_descente"]
        if neige_lente:
            v = v * vitesse_neige // 100
        vt = min(v, TUNNEL_KMH)
        sec = (18 * (long_m - tunnel) + 5 * v - 1) // (5 * v) + ((18 * tunnel + 5 * vt - 1) // (5 * vt) if tunnel else 0)
        return (sec + 59) // 60


class Annee:
    def __init__(self, reglages=None, ajouts=(), retraits=(), fermetures=()):
        self.net = Reseau()
        self.r = {g["id"]: int(g["defaut"]) for g in lire("reglages.csv")}
        self.r.update(reglages or {})
        self.meteo = [dict(m, temperature_midi=int(m["temperature_midi"]), neige_cm=int(m["neige_cm"])) for m in lire("meteo.csv")]
        self.evenements = lire("evenements.csv") + [dict(f) for f in fermetures]
        dem = lire("demande.csv")
        self.profil = {d["cle"]: [int(d[str(h)]) for h in range(24)] for d in dem if d["table"] == "profil"}
        self.mois = [int(next(d for d in dem if d["table"] == "mois")[str(h)]) for h in range(12)]
        self.horaire = [h for h in lire("horaire.csv") if h["numero"] not in set(map(str, retraits))] + [dict(a) for a in ajouts]
        self.cantons = sorted({self.net.canton(a, b) for a, b in zip(self.net.principale, self.net.principale[1:])},
                              key=lambda c: self.net.principale.index(c.split("-")[0])) + ["PV-CL"]
        self.neige = {c: 0 for c in self.cantons}
        self.alt_canton = {}
        for c in self.cantons:
            a, b = c.split("-")
            self.alt_canton[c] = (self.net.gares[a]["altitude"] + self.net.gares[b]["altitude"]) // 2

    # ---- le calendrier ----
    def jour(self, d):
        return date(ANNEE, 1, 1) + timedelta(days=d)

    def circule(self, h, d):
        j = self.jour(d)
        wd = j.weekday()  # lundi 0
        lettre = "D" if wd == 6 else "A" if wd == 5 else "S"
        ok = lettre in h["jours"] or (wd == 2 and "M" in h["jours"])
        if h["saison"] == "ete":
            ok = ok and DEBUT_ETE <= j <= FIN_ETE
        if h["saison"] == "neige":
            ok = self.meteo[d]["neige_cm"] > 0 or (d > 0 and self.meteo[d - 1]["neige_cm"] > 0)
        return ok

    def type_jour(self, d):
        wd = self.jour(d).weekday()
        return "D" if wd == 6 else "A" if wd == 5 else "S"

    def arret_de(self, typ):
        return self.r["arret_omnibus"] if typ == "O" else ARRET[typ]

    def dessertes(self, h, route):
        if h["arrets"] == "toutes":
            return set(route)
        return set(h["arrets"].split()) | {route[0], route[-1]}

    # ---- l'horaire théorique : sans neige, sans conflit ----
    def theorique(self, h, route, depart):
        net, arrets = self.net, self.dessertes(h, route)
        t, arr, dep = depart, {route[0]: None}, {route[0]: depart}
        for a, b in zip(route, route[1:]):
            t += net.minutes_troncon(h["type"], a, b, False, 100)
            arr[b] = t
            if b != route[-1]:
                t += self.arret_de(h["type"]) if b in arrets else 0
                dep[b] = t
        return arr, dep

    # ---- les fermetures du jour ----
    def ferme(self, canton, t):
        d, m = t // 1440, t % 1440
        j = self.jour(d).isoformat()
        for e in self.evenements:
            if e["nature"] in ("avalanche", "travaux", "eboulement", "fermeture") and e["lieu"] in (canton, "-".join(reversed(canton.split("-")))):
                if e["du"] <= j <= e["au"] and hm(e["debut"]) <= m <= hm(e["fin"]):
                    return True
        return False

    def panne(self, numero, gare, d):
        j = self.jour(d).isoformat()
        for e in self.evenements:
            if e["nature"] == "panne" and e["du"] <= j <= e["au"] and e["lieu"] == gare:
                n, mins = e["valeur"].split(":")
                if n == numero:
                    return int(mins)
        return 0

    def fete(self, gare, d):
        j = self.jour(d).isoformat()
        return max([int(e["valeur"]) for e in self.evenements if e["nature"] == "fete" and e["lieu"] == gare and e["du"] <= j <= e["au"]] or [100])

    # ---- l'année ----
    def jouer(self):
        net, r = self.net, self.r
        self.trains = []        # un par circulation : numéro, jour, route, horaire théorique, réel
        prevus = []
        for d in range(JOURS):
            for h in self.horaire:
                if self.circule(h, d):
                    route = net.route(h["depart"], h["terminus"])
                    dep0 = d * 1440 + hm(h["heure"])
                    arr_t, dep_t = self.theorique(h, route, dep0)
                    prevus.append({"id": f"{h['numero']}/{d}", "numero": h["numero"], "type": h["type"], "jour": d, "route": route,
                                   "dessertes": self.dessertes(h, route), "arr_t": arr_t, "dep_t": dep_t,
                                   "arr": {}, "dep": {}, "etat": "prevu", "i": 0, "attentes": [], "a_bord": {},
                                   "longueur": net.materiel[h["type"]]["longueur_m"], "places": net.materiel[h["type"]]["places"],
                                   "priorite": net.materiel[h["type"]]["priorite"], "charge": 0, "pret": dep0, "troncon": None})
        prevus.sort(key=lambda x: x["dep_t"][x["route"][0]])
        self.trains = prevus
        a_venir = list(prevus)
        actifs = []
        occupe = {c: None for c in self.cantons}       # le train dans le canton
        en_gare = {c: [] for c in net.croisement}     # trains arrêtés dans une gare à croisement
        quais = {g: [] for g in net.gares}            # voyageurs en attente : [arrivée, destination, nombre]
        self.stock, self.stock_max, self.tonnes = 0, 0, 0
        self.montes = self.renonces = self.descendus = 0
        self.supprimes, self.limites = [], []
        self.neige_journal = {}
        tete = 0
        for t in range(MINUTES):
            d, m = t // 1440, t % 1440
            # 1. à minuit, la carrière produit ; la neige du jour tombe en deux fois, la moitié (arrondie en
            #    dessous) à 6 h, le reste à 14 h, sur chaque canton selon son altitude
            if m == 0:
                self.stock += r["production_ardoise"]
                self.stock_max = max(self.stock_max, self.stock)
            if m in (360, 840):
                cm = self.meteo[d]["neige_cm"]
                part = cm // 2 if m == 360 else cm - cm // 2
                for c in self.cantons:
                    self.neige[c] += part * self.alt_canton[c] // 1000
            # à midi : la neige fond selon la température du canton (−6 °C par 1 000 m au-dessus de la plaine)
            if m == 720:
                for c in self.cantons:
                    temp = self.meteo[d]["temperature_midi"] - 6 * (self.alt_canton[c] - 420) // 1000
                    if temp > 0:
                        self.neige[c] = max(0, self.neige[c] - temp * r["fonte"])
            if m == 1439:
                self.neige_journal[d] = dict(self.neige)
            # 2. les voyageurs arrivent à l'heure pile
            if m % 60 == 0:
                self.arrivees_voyageurs(t, quais)
            # 3. les trains dont l'heure vient entrent en jeu
            while tete < len(a_venir) and a_venir[tete]["dep_t"][a_venir[tete]["route"][0]] <= t:
                tr = a_venir[tete]; tete += 1
                tr["etat"] = "en_gare"
                origine = tr["route"][0]
                if origine in net.croisement:
                    en_gare[origine].append(tr)
                actifs.append(tr)
            # 4. les arrivées au bout d'un tronçon
            for tr in actifs:
                if tr["etat"] == "roule" and tr["troncon"][3] == t:
                    self.arriver(tr, t, occupe, en_gare, quais)
            # 5. les départs, canton par canton, dans l'ordre de la ligne
            candidats = {}
            for tr in actifs:
                if tr["etat"] != "en_gare" or t < tr["pret"]:
                    continue
                g = tr["route"][tr["i"]]
                if t < tr["dep_t"].get(g, tr["arr_t"].get(g, 0)):
                    continue
                suiv = tr["route"][tr["i"] + 1]
                c = net.canton(g, suiv)
                if g in net.croisement:
                    candidats.setdefault(c, []).append(tr)
                else:
                    self.partir(tr, t, quais)  # une halte : le train est déjà dans son canton
            for c in self.cantons:
                cs = candidats.get(c)
                if not cs:
                    continue
                cs.sort(key=lambda x: (x["priorite"], -(t - x["dep_t"][x["route"][x["i"]]]), int(x["numero"]), x["jour"]))
                parti = False
                for tr in cs:
                    cause = None if not parti else "priorite"
                    if cause is None:
                        cause = self.obstacle(tr, c, t, occupe, en_gare)
                    if cause is None:
                        g = tr["route"][tr["i"]]
                        en_gare[g].remove(tr)
                        occupe[c] = tr
                        self.partir(tr, t, quais)
                        parti = True
                    else:
                        g = tr["route"][tr["i"]]
                        att = tr["attentes"]
                        if att and att[-1]["gare"] == g and att[-1]["cause"] == cause and att[-1]["fin"] == t - 1:
                            att[-1]["fin"] = t
                        else:
                            att.append({"gare": g, "cause": cause, "debut": t, "fin": t})
            # 6. suppressions et limitations
            for tr in actifs:
                if tr["etat"] != "en_gare":
                    continue
                g = tr["route"][tr["i"]]
                prevu = tr["dep_t"].get(g)
                if prevu is None:
                    continue
                if tr["i"] == 0 and t - prevu >= ATTENTE_SUPPRESSION:
                    tr["etat"] = "supprime"; self.supprimes.append(tr["id"])
                    if g in en_gare: en_gare[g].remove(tr)
                elif tr["i"] > 0 and t - prevu >= ATTENTE_LIMITATION:
                    tr["etat"] = "limite"; self.limites.append((tr["id"], g))
                    self.descendus += sum(tr["a_bord"].values()); tr["a_bord"] = {}
                    if g in en_gare: en_gare[g].remove(tr)
            actifs = [tr for tr in actifs if tr["etat"] in ("en_gare", "roule")]
            # 7. les voyageurs à bout de patience renoncent
            if m % 60 == 0 or True:
                for g, q in quais.items():
                    while q and t - q[0][0] > r["attente_max"]:
                        self.renonces += q.pop(0)[2]
        self.en_attente_fin = sum(n for q in quais.values() for _, _, n in q)
        self.stock_fin = self.stock
        return self

    def obstacle(self, tr, c, t, occupe, en_gare):
        """La première raison qui retient le train à l'entrée du canton, ou None."""
        if self.ferme(c, t):
            return "fermeture"
        if tr["type"] != "N" and self.neige[c] > self.r["seuil_neige"]:
            return "neige"
        if occupe[c] is not None:
            return "canton occupe"
        loin = tr["route"][tr["i"]]
        # la gare à croisement au bout du canton, dans le sens du train
        k = tr["i"] + 1
        while tr["route"][k] not in self.net.croisement:
            k += 1
        f = tr["route"][k]
        if f not in self.net.terminus:
            # ceux qui y sont, et ceux qui roulent vers elle depuis l'autre côté
            la = en_gare[f] + [x for x in occupe.values() if x is not None and self.prochaine_croisement(x) == f]
            if len(la) >= 2:
                return "gare pleine"
            if len(la) == 1 and min(la[0]["longueur"], tr["longueur"]) > self.net.gares[f]["croisement_m"]:
                return "croisement trop court"
        return None

    def prochaine_croisement(self, tr):
        k = tr["i"] + 1
        while tr["route"][k] not in self.net.croisement:
            k += 1
        return tr["route"][k]

    def partir(self, tr, t, quais):
        g = tr["route"][tr["i"]]
        b = tr["route"][tr["i"] + 1]
        tr["dep"][g] = t
        if g in tr["dessertes"] and tr["places"]:
            self.embarquer(tr, g, t, quais)
        if tr["type"] == "M" and g == "CL":
            tr["charge"] = min(self.stock, self.net.materiel["M"]["charge_t"])
            self.stock -= tr["charge"]
        c = self.net.canton(g, b)
        lent = tr["type"] != "N" and self.neige[c] > 10
        n = self.net.minutes_troncon(tr["type"], g, b, lent, self.r["vitesse_neige"])
        tr["troncon"] = (g, b, t, t + n)
        tr["etat"] = "roule"

    def arriver(self, tr, t, occupe, en_gare, quais):
        g, b, t0, t1 = tr["troncon"]
        tr["i"] += 1
        tr["arr"][b] = t
        tr["troncon"] = None
        if b in tr["dessertes"]:
            self.descendus += tr["a_bord"].pop(b, 0)
        if b in self.net.croisement:
            c = self.net.canton(g, b)
            if occupe.get(c) is tr:
                occupe[c] = None
            if tr["type"] == "N":
                self.neige[c] = 0
        if tr["i"] == len(tr["route"]) - 1:
            tr["etat"] = "arrive"
            if tr["type"] == "M" and b == "VP":
                self.tonnes += tr["charge"]
            self.descendus += sum(tr["a_bord"].values()); tr["a_bord"] = {}
            return
        tr["etat"] = "en_gare"
        arret = self.arret_de(tr["type"]) if b in tr["dessertes"] else 0
        arret += self.panne(tr["numero"], b, tr["jour"])
        tr["pret"] = t + arret
        if b in self.net.croisement:
            en_gare[b].append(tr)

    # ---- les voyageurs ----
    def arrivees_voyageurs(self, t, quais):
        d, h = t // 1440, t % 1440 // 60
        P = self.profil[self.type_jour(d)][h]
        if not P:
            return
        M = self.mois[self.jour(d).month - 1]
        gares = [g for g, x in self.net.gares.items() if x["voyageurs_jour"] > 0]
        for i in gares:
            Vi = self.net.gares[i]["voyageurs_jour"]
            F = self.fete(i, d)
            somme = sum(self.net.gares[k]["voyageurs_jour"] for k in gares if k != i)
            for j in gares:
                if j == i:
                    continue
                n = Vi * self.net.gares[j]["voyageurs_jour"] * P * M * F // (somme * 1000 * 100 * 100)
                if n:
                    quais[i].append([t, j, n])

    def embarquer(self, tr, g, t, quais):
        route = tr["route"]
        suite = set(route[tr["i"] + 1 :]) & tr["dessertes"]
        place = tr["places"] - sum(tr["a_bord"].values())
        q = quais[g]
        for grp in q:
            if place <= 0:
                break
            if grp[1] in suite and grp[0] <= t:
                k = min(place, grp[2])
                grp[2] -= k; place -= k
                tr["a_bord"][grp[1]] = tr["a_bord"].get(grp[1], 0) + k
                self.montes += k
        quais[g] = [grp for grp in q if grp[2] > 0]

    # ---- ce que le juge lit ----
    def bilan(self):
        circules = [x for x in self.trains if x["etat"] in ("arrive", "limite")]
        ok = [x for x in self.trains if x["etat"] == "arrive"]
        term = [x["arr"][x["route"][-1]] - x["arr_t"][x["route"][-1]] for x in ok]
        a_lheure = sum(1 for v in term if v <= 5)
        return {"circulations": len(self.trains), "arrivees": len(ok), "supprimes": len(self.supprimes), "limites": len(self.limites),
                "ponctualite_pct": round(100 * a_lheure / len(ok), 1) if ok else 0, "retard_moyen_min": round(sum(term) / len(term), 2) if term else 0,
                "retard_max_min": max(term) if term else 0, "montes": self.montes, "renonces": self.renonces,
                "en_attente_fin": self.en_attente_fin, "tonnes": self.tonnes, "stock_fin": self.stock_fin, "stock_max": self.stock_max}

    def position(self, tr, t):
        """(ligne, point kilométrique en mètres, où) d'un train à la minute t, ou None s'il n'est pas en ligne.
        Il existe de son heure de départ prévue à son arrivée au terminus (ou à sa limitation) ;
        à l'arrêt en gare entre son arrivée et son départ, sur le tronçon entre son départ et l'arrivée suivante,
        à une vitesse constante sur le tronçon."""
        route = tr["route"]
        if tr["etat"] == "supprime" or t < tr["dep_t"][route[0]]:
            return None
        for k, g in enumerate(route):
            debut = tr["dep_t"][g] if k == 0 else tr["arr"].get(g)
            if debut is None or t < debut:
                return None
            dp = tr["dep"].get(g)
            if dp is None or t < dp:
                if k == len(route) - 1 and t > debut:
                    return None  # arrivé : il quitte la vue la minute suivante
                if k < len(route) - 1 and dp is None and tr["etat"] == "limite" and t > debut + ATTENTE_LIMITATION + 1440:
                    return None
                return (self.ligne_de(g, route), self.pk_sur(g, route), g)
            b = route[k + 1]
            ab = tr["arr"].get(b)
            if ab is not None and t < ab:
                if "CL" in (g, b):
                    pa, pb = (0, 4500) if g == "PV" else (4500, 0)
                    return ("branche", pa + (pb - pa) * (t - dp) // (ab - dp), f"{g}-{b}")
                pa, pb = self.net.gares[g]["pk"], self.net.gares[b]["pk"]
                return ("principale", pa + (pb - pa) * (t - dp) // (ab - dp), f"{g}-{b}")
        return None

    def ligne_de(self, g, route):
        return "branche" if g == "CL" else "principale"

    def pk_sur(self, g, route):
        return 4500 if g == "CL" else self.net.gares[g]["pk"]

    def pk(self, g):
        return self.net.gares[g]["pk"]


def reglages_argv(argv):
    return {k: int(v) for k, v in (a.split("=") for a in argv if "=" in a and not a.startswith("--"))}


if __name__ == "__main__":
    args = sys.argv[1:]
    a = Annee(reglages_argv(args)).jouer()
    for k, v in a.bilan().items():
        print(f"{k:18} {v}")
    if "--train" in args:
        num, jour = args[args.index("--train") + 1], args[args.index("--date") + 1]
        d = (date.fromisoformat(jour) - date(ANNEE, 1, 1)).days
        tr = next(x for x in a.trains if x["numero"] == num and x["jour"] == d)
        print(f"\ntrain {num} du {jour} : {tr['etat']}")
        for g in tr["route"]:
            at, dt = tr["arr_t"].get(g), tr["dep_t"].get(g)
            ar, dr = tr["arr"].get(g), tr["dep"].get(g)
            f = lambda x: texte_minute(x)[11:] if x is not None else "  —  "
            print(f"  {g}  prévu {f(at)} → {f(dt)}   réel {f(ar)} → {f(dr)}   retard {((ar if ar is not None else dr) or 0) - ((at if at is not None else dt) or 0):+d}")
        for w in tr["attentes"]:
            print(f"  attend à {w['gare']} de {texte_minute(w['debut'])[11:]} à {texte_minute(w['fin'])[11:]} : {w['cause']}")
