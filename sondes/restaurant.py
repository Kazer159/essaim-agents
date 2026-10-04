#!/usr/bin/env python3
# restaurant.py — la référence de la mission « restaurant » (missions/restaurant.md) : applique les règles
# de la mission aux données de missions/entrees/restaurant/ sur un service que la mission ne cite pas, et écrit les
# valeurs attendues du juge (sondes/juge-restaurant.mjs). Écrite depuis la mission seule, avant de regarder ce que
# le livrable affiche. Usage : python3 sondes/restaurant.py [sortie.json]
#
# Le service du juge (horloge réglée) :
#   12:20  réservations créées : « Juge A » 12:45, 3 couverts (attribuée) ; « Juge Z » 12:40, 8 couverts (refusée) ;
#          Martin (12:00) est « non venue » ; installations T5 (3), T3 réservée Lefèvre (4), T10 (4), T9 (2) ;
#          envoi T5 : 2 E1, 1 P1, 2 P3, 1 B4, 1 B1 ; la ligne B1 est annulée aussitôt.
#   12:25  envoi T10 : 1 E3, 3 P2, 1 P4, 4 B6 ; envoi T3 : 2 E4, 2 P5, 4 D4, 2 B3.
#   12:40  les quatre lignes de T5 passent en préparation puis prêtes (attente 20).
#   12:52  les quatre lignes de T10 prêtes (attente 27) ; B4 de T5 offert ; T9 : 13 D4 envoyés (reste 1 fromage,
#          D4 encore commandable) puis 1 D4 (rupture) ; commande fournisseur Laiterie du Col proposée puis reçue ;
#          carte : B3 passe à 300 c et sa recette à 10 g de café ; T9 : 2 B3 envoyés.
#          Additions : T5 en une fois carte ; T10 en 3 parts égales (carte, espèces 50 €, espèces 40 €) ;
#          T3 par articles (E4 + P5 en carte, le reste en espèces 50 €) ; T9 carte 100 € + espèces 50 €.
#          T5 débarrassée ; T11 installée (3 couverts), sans commande.
#   13:05  « Juge A » passe non venue, T4 redevient libre.
import csv
import json
import sys
from pathlib import Path

D = Path(__file__).resolve().parent.parent / "missions" / "entrees" / "restaurant"


def lire(nom):
    with open(D / nom, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def hm(m):
    return f"{m // 60:02d}:{m % 60:02d}"


def mn(s):
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def arrondi(num, den):
    # au plus proche, au-dessus à égalité (entiers positifs)
    return (2 * num + den) // (2 * den)


TABLES = lire("tables.csv")
CARTE = {r["code"]: {**r, "prix": int(r["prix_ttc_cts"]), "tva": int(r["tva_pct"])} for r in lire("carte.csv")}
ORDRE_CARTE = [r["code"] for r in lire("carte.csv")]
RECETTES = {}
for r in lire("recettes.csv"):
    RECETTES.setdefault(r["plat"], {})[r["ingredient"]] = int(r["quantite"])
ING = {r["code"]: r for r in lire("ingredients.csv")}
STOCK = {k: int(v["stock_depart"]) for k, v in ING.items()}
PRIX_ACHAT = {k: float(v["prix_achat_cts_par_unite"]) for k, v in ING.items()}


def valeur_stock():
    # somme de stock × prix d'achat, arrondie au centime (prix d'achat décimaux : calcul en millièmes exacts)
    from fractions import Fraction
    s = sum(Fraction(STOCK[k]) * Fraction(ING[k]["prix_achat_cts_par_unite"]) for k in STOCK)
    return int((s * 2 + 1) // 2)


def rupture(code):
    return any(STOCK[i] < q for i, q in RECETTES[code].items())


def ruptures():
    return [c for c in ORDRE_CARTE if rupture(c)]


def alertes():
    return [k for k in STOCK if STOCK[k] < int(ING[k]["seuil_alerte"])]


def envoyer(lignes, recettes=None):
    rec = recettes or RECETTES
    for code, q in lignes:
        assert not rupture(code), f"{code} en rupture"
        for i, qi in rec[code].items():
            STOCK[i] -= qi * q


def annuler(code, q):
    for i, qi in RECETTES[code].items():
        STOCK[i] += qi * q


# ---- réservations : attribution selon la règle (plus petite table libre sur [h-15, h+90], ordre de tables.csv)
def attribuer(resas, heure, couverts):
    deb, fin = mn(heure) - 15, mn(heure) + 90
    cand = [t for t in TABLES if int(t["places"]) >= couverts]
    cand.sort(key=lambda t: int(t["places"]))  # tri stable : ordre de tables.csv à places égales
    for t in cand:
        prise = any(r["table"] == t["table"] and not (fin <= r["deb"] or r["fin"] <= deb) for r in resas)
        if not prise:
            return t["table"]
    return None


resas = []
for r in lire("reservations.csv"):
    t = attribuer(resas, r["heure"], int(r["couverts"]))
    resas.append({"nom": r["nom"], "heure": r["heure"], "couverts": int(r["couverts"]), "table": t,
                  "deb": mn(r["heure"]) - 15, "fin": mn(r["heure"]) + 90})
resa_csv = {r["nom"]: r["table"] for r in resas}
jugeA = attribuer(resas, "12:45", 3)
resas.append({"nom": "Juge A", "heure": "12:45", "couverts": 3, "table": jugeA, "deb": mn("12:45") - 15, "fin": mn("12:45") + 90})
jugeZ = attribuer(resas, "12:40", 8)


def etat_tables(horloge, installees):
    # table -> état attendu à l'horloge donnée (hors tables installées)
    out = {}
    for t in TABLES:
        n = t["table"]
        if n in installees:
            out[n] = "occupée"
            continue
        out[n] = "libre"
        for r in resas:
            h = mn(r["heure"])
            if r["table"] == n and r["nom"] not in installees.values() and h - 15 <= horloge < h + 15:
                out[n] = "réservée"
    return out


# ---- le service
valeur_depart = valeur_stock()
lignes_servies = []  # (table, code, q, envoi, prete)
additions = {}


def ajouter(table, code, q, envoi, prix=None):
    additions.setdefault(table, []).append({"code": code, "q": q, "prix": CARTE[code]["prix"] if prix is None else prix,
                                            "tva": CARTE[code]["tva"], "envoi": envoi, "prete": None, "offert": False,
                                            "annulee": False})
    return additions[table][-1]


T5 = [("E1", 2), ("P1", 1), ("P3", 2), ("B4", 1), ("B1", 1)]
envoyer(T5)
for c, q in T5:
    ajouter("T5", c, q, mn("12:20"))
stock_apres_envoi_T5 = dict(STOCK)
annuler("B1", 1)
additions["T5"][-1]["annulee"] = True
stock_apres_annulation = dict(STOCK)

T10 = [("E3", 1), ("P2", 3), ("P4", 1), ("B6", 4)]
T3 = [("E4", 2), ("P5", 2), ("D4", 4), ("B3", 2)]
envoyer(T10)
for c, q in T10:
    ajouter("T10", c, q, mn("12:25"))
envoyer(T3)
for c, q in T3:
    ajouter("T3", c, q, mn("12:25"))

for l in additions["T5"]:
    if not l["annulee"]:
        l["prete"] = mn("12:40")
for l in additions["T10"]:
    l["prete"] = mn("12:52")
for l in additions["T5"]:
    if l["code"] == "B4":
        l["offert"] = True

envoyer([("D4", 13)])
ajouter("T9", "D4", 13, mn("12:52"))
fromage_avant_rupture = STOCK["fromage"]
d4_commandable_a_13 = not rupture("D4")
envoyer([("D4", 1)])
ajouter("T9", "D4", 1, mn("12:52"))
fromage_rupture = STOCK["fromage"]
ruptures_apres = ruptures()
alertes_apres_rupture = alertes()

# commande fournisseur Laiterie du Col : pour chaque ingrédient sous le seuil, cible − stock
FOUR = "Laiterie du Col"
proposee = {k: int(ING[k]["stock_cible"]) - STOCK[k] for k in ING
            if ING[k]["fournisseur"] == FOUR and STOCK[k] < int(ING[k]["seuil_alerte"])}
stock_laiterie_avant = {k: STOCK[k] for k in ING if ING[k]["fournisseur"] == FOUR}
for k, q in proposee.items():
    STOCK[k] += q
d4_revenu = not rupture("D4")

# carte : B3 à 300 c, recette café 10 g ; les B3 déjà envoyés (T3) gardent 250 c
CARTE["B3"]["prix"] = 300
RECETTES["B3"] = {"cafe": 10}
cafe_avant = STOCK["cafe"]
envoyer([("B3", 2)])
ajouter("T9", "B3", 2, mn("12:52"))
cafe_apres = STOCK["cafe"]


def total(table, lignes=None):
    ls = lignes if lignes is not None else [l for l in additions[table] if not l["annulee"]]
    return sum(0 if l["offert"] else l["prix"] * l["q"] for l in ls)


def tva_par_taux(ls):
    par = {}
    for l in ls:
        if l["annulee"]:
            continue
        par[l["tva"]] = par.get(l["tva"], 0) + (0 if l["offert"] else l["prix"] * l["q"])
    return {str(t): {"ttc": v, "tva": arrondi(v * t, 100 + t), "ht": v - arrondi(v * t, 100 + t)} for t, v in sorted(par.items())}


def parts(tot, n):
    b = tot // n
    return [b + 1 if i < tot - n * b else b for i in range(n)]


tickets = {}
for t in ["T5", "T10", "T3", "T9"]:
    ls = [l for l in additions[t] if not l["annulee"]]
    tickets[t] = {"total": total(t), "tva": tva_par_taux(ls),
                  "lignes": [{"code": l["code"], "q": l["q"], "montant": 0 if l["offert"] else l["prix"] * l["q"]} for l in ls]}
tickets["T5"]["paiements"] = [{"mode": "carte", "montant": tickets["T5"]["total"]}]
p10 = parts(tickets["T10"]["total"], 3)
tickets["T10"]["parts"] = p10
tickets["T10"]["paiements"] = [{"mode": "carte", "montant": p10[0]},
                               {"mode": "especes", "montant": p10[1], "donne": 5000, "rendu": 5000 - p10[1]},
                               {"mode": "especes", "montant": p10[2], "donne": 4000, "rendu": 4000 - p10[2]}]
e4p5 = sum(l["prix"] * l["q"] for l in additions["T3"] if l["code"] in ("E4", "P5"))
reste3 = tickets["T3"]["total"] - e4p5
tickets["T3"]["paiements"] = [{"mode": "carte", "montant": e4p5, "articles": ["E4", "P5"]},
                              {"mode": "especes", "montant": reste3, "donne": 5000, "rendu": 5000 - reste3}]
t9 = tickets["T9"]["total"]
tickets["T9"]["paiements"] = [{"mode": "carte", "montant": 10000},
                              {"mode": "especes", "montant": t9 - 10000, "donne": 5000, "rendu": 5000 - (t9 - 10000)}]

# ---- tableau de bord (fin de service, horloge 13:05)
couverts = {"T5": 3, "T3": 4, "T10": 4, "T9": 2, "T11": 3}
toutes = [l for t in additions.values() for l in t if not l["annulee"]]
ca = sum(tickets[t]["total"] for t in tickets)
tva_jour = tva_par_taux(toutes)
tva_somme_tickets = {}
for t in tickets.values():
    for taux, v in t["tva"].items():
        tva_somme_tickets[taux] = tva_somme_tickets.get(taux, 0) + v["tva"]
tva_totale = sum(v["tva"] for v in tva_jour.values())
attentes = [l["prete"] - l["envoi"] for l in toutes if l["prete"] is not None]
portions = {}
for l in toutes:
    portions[l["code"]] = portions.get(l["code"], 0) + l["q"]
top5 = sorted(portions.items(), key=lambda kv: (-kv[1], ORDRE_CARTE.index(kv[0])))[:5]
nb_couverts = sum(couverts.values())

R = {
    "noms": {"carte": {c: CARTE[c]["nom"] for c in ORDRE_CARTE}, "ingredients": {k: v["nom"] for k, v in ING.items()},
             "unites": {k: v["unite"] for k, v in ING.items()}},
    "horloge": {"debut": "12:20", "envoi_2": "12:25", "pret_T5": "12:40", "pret_T10": "12:52", "fin": "13:05"},
    "reservations": {
        "csv": resa_csv,
        "non_venues_a_12h20": ["Martin"],
        "juge_A": {"heure": "12:45", "couverts": 3, "table": jugeA},
        "juge_Z": {"heure": "12:40", "couverts": 8, "table": jugeZ, "refusee": jugeZ is None},
        "non_venues_a_13h05": ["Martin", "Rossi", "Dubois", "Juge A"],
        "tables_a_12h20_avant_installation": etat_tables(mn("12:20"), {}),
    },
    "installations": couverts,
    "commandes": {"T5": T5, "T10": T10, "T3": T3, "T9": [("D4", 13), ("D4", 1), ("B3", 2)], "annulee": ["T5", "B1", 1]},
    "stocks": {
        "depart": {k: int(v["stock_depart"]) for k, v in ING.items()},
        "apres_envoi_T5": stock_apres_envoi_T5,
        "apres_annulation_B1": stock_apres_annulation,
        "fromage_avant_rupture": fromage_avant_rupture,
        "D4_commandable_a_1_portion": d4_commandable_a_13,
        "fromage_a_la_rupture": fromage_rupture,
        "ruptures_a_la_rupture": ruptures_apres,
        "alertes_a_la_rupture": alertes_apres_rupture,
        "laiterie_avant_commande": stock_laiterie_avant,
        "commande_proposee": {"fournisseur": FOUR, "lignes": proposee},
        "D4_revenu_apres_reception": d4_revenu,
        "cafe_avant_B3": cafe_avant,
        "cafe_apres_B3": cafe_apres,
        "fin": dict(STOCK),
        "valeur_depart": valeur_depart,
        "valeur_fin": valeur_stock(),
        "alertes_fin": alertes(),
        "ruptures_fin": ruptures(),
    },
    "tickets": tickets,
    "tableau": {
        "ca_ttc": ca,
        "ca_ht": ca - tva_totale,
        "tva_par_taux": {t: v["tva"] for t, v in tva_jour.items()},
        "tva_par_taux_somme_des_tickets": tva_somme_tickets,
        "couverts": nb_couverts,
        "ticket_moyen": arrondi(ca, nb_couverts),
        "attente_moyenne": arrondi(sum(attentes), len(attentes)),
        "attente_max": max(attentes),
        "attentes": attentes,
        "top5": [{"code": c, "nom": CARTE[c]["nom"], "portions": q} for c, q in top5],
        "tables_occupees": ["T11"],
        "a_debarrasser": ["T10", "T3", "T9"],
        "offerts": [{"table": "T5", "code": "B4"}],
    },
}

if __name__ == "__main__":
    s = json.dumps(R, ensure_ascii=False, indent=1)
    if len(sys.argv) > 1:
        Path(sys.argv[1]).write_text(s, encoding="utf-8")
    print(s)
