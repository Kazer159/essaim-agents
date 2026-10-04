#!/usr/bin/env python3
"""Les réponses de référence de la mission « hôtel », calculées depuis missions/entrees/hotel/.

Le juge mécanique compare la page à ces chiffres-là. Les conventions suivies ici sont
exactement celles que la mission énonce — rien de plus.
"""
import csv
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

ENTREES = Path(__file__).resolve().parent.parent / "missions" / "entrees" / "hotel"
TAXE_PAR_ADULTE_NUIT = 1.50
REMISE = {"aucun": 0, "argent": 5, "or": 10}
DEBUT, FIN = date(2026, 6, 1), date(2026, 8, 31)  # nuits du 1er juin au 31 août comprises


def lire(nom):
    with open(ENTREES / nom, encoding="utf-8") as f:
        return list(csv.DictReader(f, delimiter=";"))


j = date.fromisoformat
chambres = {c["id"]: c for c in lire("chambres.csv")}
en_service = {i: c for i, c in chambres.items() if c["etat"] == "en_service"}
clients = {k["id"]: k for k in lire("clients.csv")}
services = {s["code"]: s for s in lire("services.csv")}
tarifs = {(t["saison"], t["type_chambre"]): float(t["prix_nuit"]) for t in lire("tarifs.csv")}
saisons = [(t["saison"], j(t["debut"]), j(t["fin"])) for t in lire("tarifs.csv")]
reservations = lire("reservations.csv")
for r in reservations:
    r["arrivee"], r["depart"] = j(r["arrivee"]), j(r["depart"])
    r["adultes"], r["enfants"] = int(r["adultes"]), int(r["enfants"])
    r["nuits"] = (r["depart"] - r["arrivee"]).days
    r["codes"] = [s for s in r["services"].split("|") if s]

confirmees = [r for r in reservations if r["statut"] == "confirmee"]


def saison_de(nuit):
    for nom, d, f in saisons:
        if d <= nuit <= f:
            return nom
    raise ValueError(nuit)


def nuits_de(r):
    return [r["arrivee"] + timedelta(days=i) for i in range(r["nuits"])]


def prix(r):
    """Hébergement, remise, services, taxe, total — tous au centime exact."""
    c = chambres[r["chambre"]]
    hebergement = sum(tarifs[(saison_de(n), c["type"])] for n in nuits_de(r))
    taux = REMISE[clients[r["client"]]["fidelite"]]
    remise = hebergement * taux / 100
    personnes = r["adultes"] + r["enfants"]
    extra = 0.0
    for code in r["codes"]:
        s = services[code]
        p = float(s["prix"])
        extra += p * personnes * r["nuits"] if s["unite"] == "personne_nuit" else p * r["nuits"] if s["unite"] == "nuit" else p
    taxe = TAXE_PAR_ADULTE_NUIT * r["adultes"] * r["nuits"]
    total = hebergement - remise + extra + taxe
    for montant in (hebergement, remise, extra, taxe, total):  # aucun arrondi ne doit être nécessaire
        assert abs(round(montant, 2) - montant) < 1e-9, (r["id"], montant)
    return {"hebergement": hebergement, "taux": taux, "remise": remise, "services": extra, "taxe": taxe, "total": total}


def occupees(nuit, sauf=None, en_plus=None):
    """Les chambres occupées la nuit du jour donné (arrivée comprise, départ exclu)."""
    lot = [r for r in confirmees if r["id"] != sauf] + (en_plus or [])
    return {r["chambre"] for r in lot if r["arrivee"] <= nuit < r["depart"]}


def libres(arrivee, depart, personnes, sauf=None):
    """Les chambres en service dont la capacité suffit et qu'aucune réservation confirmée n'occupe."""
    prises = set()
    for r in confirmees:
        if r["id"] == sauf:
            continue
        if r["arrivee"] < depart and arrivee < r["depart"]:  # deux séjours se recouvrent
            prises.add(r["chambre"])
    return sorted(c["id"] for c in en_service.values()
                  if int(c["capacite"]) >= personnes and c["id"] not in prises)


def conflits(lot):
    par_chambre = defaultdict(list)
    for r in lot:
        par_chambre[r["chambre"]].append(r)
    out = []
    for id_chambre, rs in par_chambre.items():
        rs.sort(key=lambda r: r["arrivee"])
        for a, b in zip(rs, rs[1:]):
            if b["arrivee"] < a["depart"]:
                out.append((id_chambre, a["id"], b["id"]))
    return out


def euro(x):
    return f"{x:,.2f} €".replace(",", " ").replace(".", ",")


if __name__ == "__main__":
    toutes = list(en_service)
    jours = [DEBUT + timedelta(days=i) for i in range((FIN - DEBUT).days + 1)]
    print(f"{len(chambres)} chambres dont {len(en_service)} en service, {len(clients)} clients, {len(reservations)} réservations "
          f"dont {len(confirmees)} confirmées et {len(reservations) - len(confirmees)} annulées")

    print("\n--- Les totaux du trimestre (réservations confirmées, nuits du 1er juin au 31 août) ---")
    nuitees = sum(len([n for n in nuits_de(r) if DEBUT <= n <= FIN]) for r in confirmees)
    tous = {r["id"]: prix(r) for r in confirmees}
    ca = sum(p["total"] for p in tous.values())
    heb = sum(p["hebergement"] - p["remise"] for p in tous.values())
    print(f"nuitées vendues : {nuitees}")
    print(f"revenu total : {euro(ca)}  (hébergement remisé {euro(heb)}, "
          f"services {euro(sum(p['services'] for p in tous.values()))}, "
          f"taxe {euro(sum(p['taxe'] for p in tous.values()))}, "
          f"remises accordées {euro(sum(p['remise'] for p in tous.values()))})")
    occ = {n: len(occupees(n)) for n in jours}
    moyenne = sum(occ.values()) / len(jours) / len(en_service) * 100
    print(f"occupation moyenne : {moyenne:.2f} %  ({sum(occ.values())} chambres-nuits sur {len(jours) * len(en_service)})")
    plein = max(occ.items(), key=lambda kv: (kv[1], -kv[0].toordinal()))
    creux = min(occ.items(), key=lambda kv: (kv[1], kv[0].toordinal()))
    print(f"nuit la plus remplie : {plein[0]} ({plein[1]}/{len(en_service)})")
    print(f"nuit la plus creuse : {creux[0]} ({creux[1]}/{len(en_service)})")
    for mois, nom in ((6, "juin"), (7, "juillet"), (8, "août")):
        jm = [n for n in jours if n.month == mois]
        rm = [r for r in confirmees if r["arrivee"].month == mois]
        print(f"  {nom} : occupation {sum(occ[n] for n in jm) / len(jm) / len(en_service) * 100:.2f} %, "
              f"{len(rm)} arrivées, revenu des séjours arrivés ce mois-là {euro(sum(tous[r['id']]['total'] for r in rm))}")

    print("\n--- Quelques nuits ---")
    for d in (date(2026, 6, 14), date(2026, 7, 14), date(2026, 8, 15), date(2026, 8, 31)):
        o = occupees(d)
        print(f"{d} : {len(o)}/{len(en_service)} chambres ({len(o) / len(en_service) * 100:.2f} %), "
              f"libres : {', '.join(sorted(set(toutes) - o)) or 'aucune'}")

    print("\n--- Le détail du prix de quelques séjours ---")
    a_cheval = [r for r in confirmees if r["arrivee"] <= date(2026, 6, 30) < r["depart"]]
    exemples = [r["id"] for r in confirmees[:2]]
    exemples += [r["id"] for r in a_cheval[:2]]
    exemples += [r["id"] for r in confirmees if clients[r["client"]]["fidelite"] == "or" and len(r["codes"]) >= 2][:2]
    exemples += [r["id"] for r in confirmees if r["nuits"] == 14][:1]
    for id_r in dict.fromkeys(exemples):
        r = next(x for x in confirmees if x["id"] == id_r)
        p, c, k = tous[id_r], chambres[r["chambre"]], clients[r["client"]]
        sais = sorted({saison_de(n) for n in nuits_de(r)})
        print(f"{id_r} {k['nom']} ({k['fidelite']}) · {c['nom']} {c['type']} · {r['arrivee']}→{r['depart']} "
              f"{r['nuits']} nuits · {r['adultes']}a {r['enfants']}e · saisons {'+'.join(sais)} · "
              f"services {','.join(r['codes']) or 'aucun'}")
        print(f"    hébergement {euro(p['hebergement'])} − remise {p['taux']} % ({euro(p['remise'])}) "
              f"+ services {euro(p['services'])} + taxe {euro(p['taxe'])} = {euro(p['total'])}")

    print("\n--- Cohérence des données ---")
    print(f"conflits parmi les confirmées : {len(conflits(confirmees))}")
    enchainees = sum(1 for c, a, b in [(ch, x, y) for ch in en_service
                                       for x, y in zip(sorted([r for r in confirmees if r['chambre'] == ch], key=lambda r: r['arrivee']),
                                                       sorted([r for r in confirmees if r['chambre'] == ch], key=lambda r: r['arrivee'])[1:])
                                       if x['depart'] == y['arrivee']])
    print(f"départs suivis d'une arrivée le jour même : {enchainees}")
    jamais = [c for c in en_service if not any(r["chambre"] == c for r in confirmees)]
    print(f"chambres jamais occupées : {', '.join(jamais) or 'aucune'}")
    pleines = [r["id"] for r in confirmees if r["adultes"] + r["enfants"] == int(chambres[r["chambre"]]["capacite"])]
    print(f"séjours à capacité exacte : {len(pleines)}")

    print("\n--- Les huit demandes à placer ---")
    demandes = lire("demandes.csv")
    for d in demandes:
        a, dep = j(d["arrivee"]), j(d["depart"])
        personnes = int(d["adultes"]) + int(d["enfants"])
        nuits = (dep - a).days
        l = libres(a, dep, personnes)
        k = clients[d["client"]]
        if not l:
            assez_grandes = [c for c in en_service.values() if int(c["capacite"]) >= personnes]
            raison = "aucune chambre de cette capacité dans l'hôtel" if not assez_grandes else "toutes les chambres assez grandes sont prises"
            print(f"{d['id']} {k['nom']} · {a}→{dep} {nuits} nuits · {personnes} pers. : IMPOSSIBLE — {raison}")
            continue
        souhait = [i for i in l if not d["vue_souhaitee"] or en_service[i]["vue"] == d["vue_souhaitee"]]
        faux = {"id": d["id"], "client": d["client"], "chambre": l[0], "arrivee": a, "depart": dep,
                "adultes": int(d["adultes"]), "enfants": int(d["enfants"]), "nuits": nuits,
                "codes": [x for x in d["services"].split("|") if x]}
        p = prix(faux)
        vu = f", vue {d['vue_souhaitee']} : {', '.join(souhait) if souhait else 'aucune'}" if d["vue_souhaitee"] else ""
        print(f"{d['id']} {k['nom']} ({k['fidelite']}) · {a}→{dep} {nuits} nuits · {personnes} pers. : "
              f"{len(l)} chambre(s) — {', '.join(l)}{vu}")
        print(f"    dans {l[0]} ({en_service[l[0]]['type']}) : hébergement {euro(p['hebergement'])} "
              f"− remise {p['taux']} % + services {euro(p['services'])} + taxe {euro(p['taxe'])} = {euro(p['total'])}")

    print("\n--- Pourquoi une demande est impossible : les nuits qui bloquent ---")
    for d in demandes:
        a, dep = j(d["arrivee"]), j(d["depart"])
        personnes = int(d["adultes"]) + int(d["enfants"])
        if libres(a, dep, personnes):
            continue
        bloquantes = [n for n in (a + timedelta(days=i) for i in range((dep - a).days))
                      if not [c for c in en_service.values()
                              if int(c["capacite"]) >= personnes and c["id"] not in occupees(n)]]
        print(f"{d['id']} ({personnes} pers.) : {len(bloquantes)} nuit(s) sans aucune chambre assez grande de libre — "
              + (", ".join(str(x) for x in bloquantes) if bloquantes else "aucune nuit ne bloque seule : c'est la suite complète qui ne passe pas"))

    print("\n--- Quand on y touche ---")
    # un déplacement vers un autre type, un déplacement refusé, une prolongation, une annulation
    cas = None
    for r in confirmees:
        if not (3 <= r["nuits"] <= 5 and r["arrivee"].month == 7):
            continue
        ailleurs = [i for i in libres(r["arrivee"], r["depart"], r["adultes"] + r["enfants"], sauf=r["id"])
                    if en_service[i]["type"] != chambres[r["chambre"]]["type"]]
        occupee = [i for i in en_service if i != r["chambre"] and i not in libres(r["arrivee"], r["depart"], 1, sauf=r["id"])]
        if ailleurs and occupee:
            cas = (r, ailleurs[0], occupee[0])
            break
    r, vers, bloquee = cas
    avant = prix(r)
    apres = prix({**r, "chambre": vers})
    k = clients[r["client"]]
    print(f"déplacer {r['id']} ({k['nom']}, {k['fidelite']}) de {r['chambre']} ({chambres[r['chambre']]['type']}) "
          f"vers {vers} ({en_service[vers]['type']}), {r['arrivee']}→{r['depart']} {r['nuits']} nuits :")
    print(f"    {euro(avant['total'])} devient {euro(apres['total'])} "
          f"(hébergement {euro(avant['hebergement'])} → {euro(apres['hebergement'])})")
    genant = [x["id"] for x in confirmees if x["chambre"] == bloquee and x["arrivee"] < r["depart"] and r["arrivee"] < x["depart"]]
    print(f"déplacer {r['id']} vers {bloquee} : refusé, {', '.join(genant)} y est déjà")
    plus = {**r, "depart": r["depart"] + timedelta(days=2)}
    plus["nuits"] = (plus["depart"] - plus["arrivee"]).days
    suivante = [x["id"] for x in confirmees if x["chambre"] == r["chambre"] and x["id"] != r["id"]
                and x["arrivee"] < plus["depart"] and plus["arrivee"] < x["depart"]]
    print(f"prolonger {r['id']} de 2 nuits (départ le {plus['depart']}) : {euro(prix(plus)['total'])}"
          + (f" — mais refusé : {', '.join(suivante)} occupe déjà la chambre" if suivante else " — la chambre est libre après"))
    nuit = r["arrivee"]
    print(f"annuler {r['id']} : la nuit du {nuit} passe de {len(occupees(nuit))} à {len(occupees(nuit, sauf=r['id']))} chambres occupées, "
          f"et le revenu total de {euro(ca)} à {euro(ca - avant['total'])}")

    print("\n--- Disponibilité : « qui est libre ? » ---")
    for arrivee, depart, personnes in ((date(2026, 8, 10), date(2026, 8, 14), 3),
                                       (date(2026, 7, 20), date(2026, 7, 22), 2),
                                       (date(2026, 6, 8), date(2026, 6, 15), 4),
                                       (date(2026, 7, 13), date(2026, 7, 16), 2)):
        l = libres(arrivee, depart, personnes)
        nuits = (depart - arrivee).days
        detail = []
        for id_c in l[:4]:
            c = chambres[id_c]
            p = sum(tarifs[(saison_de(arrivee + timedelta(days=i)), c["type"])] for i in range(nuits))
            detail.append(f"{id_c} {c['type']} {euro(p)}")
        print(f"{arrivee}→{depart} ({nuits} nuits) pour {personnes} : {len(l)} chambre(s) — "
              f"{', '.join(l) if l else 'aucune'}")
        if detail:
            print(f"    hébergement nu : {' · '.join(detail)}")
