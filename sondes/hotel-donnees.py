#!/usr/bin/env python3
"""Génère les données de la mission « hôtel » dans missions/entrees/hotel/.

Déterministe (graine fixe) : relancer ce script redonne exactement les mêmes fichiers.
Les pièges sont posés volontairement — un enchaînement départ/arrivée le même jour, un
séjour à cheval sur deux saisons, une chambre jamais occupée, des réservations annulées,
une chambre remplie à sa capacité exacte — parce que c'est là que les coutures cassent.
"""
import csv, random
from datetime import date, timedelta
from pathlib import Path

SORTIE = Path(__file__).resolve().parent.parent / "missions" / "entrees" / "hotel"
DEBUT, FIN = date(2026, 6, 1), date(2026, 8, 31)

TYPES = {  # type -> (capacité, nombre de chambres)
    "simple": (1, 4), "double": (2, 12), "twin": (2, 8), "familiale": (4, 5), "suite": (3, 3),
}
SAISONS = [  # nom, début, fin (bornes comprises)
    ("basse", date(2026, 6, 1), date(2026, 6, 30)),
    ("haute", date(2026, 7, 1), date(2026, 8, 20)),
    ("moyenne", date(2026, 8, 21), date(2026, 8, 31)),
]
PRIX = {  # (saison, type) -> prix d'une nuit
    ("basse", "simple"): 78.00, ("basse", "double"): 96.00, ("basse", "twin"): 92.00,
    ("basse", "familiale"): 134.00, ("basse", "suite"): 185.00,
    ("haute", "simple"): 112.00, ("haute", "double"): 148.00, ("haute", "twin"): 142.00,
    ("haute", "familiale"): 198.00, ("haute", "suite"): 265.00,
    ("moyenne", "simple"): 94.00, ("moyenne", "double"): 121.00, ("moyenne", "twin"): 116.00,
    ("moyenne", "familiale"): 167.00, ("moyenne", "suite"): 224.00,
}
SERVICES = [  # code, nom, prix, unité
    ("PDJ", "Petit-déjeuner", 14.50, "personne_nuit"),
    ("PARK", "Parking", 12.00, "nuit"),
    ("SPA", "Accès spa", 35.00, "sejour"),
    ("ANIM", "Animal de compagnie", 18.00, "nuit"),
    ("LATE", "Départ tardif", 25.00, "sejour"),
]
FIDELITE = {"aucun": 0, "argent": 5, "or": 10}  # remise en % sur l'hébergement

PRENOMS = ["Camille", "Hugo", "Léa", "Paul", "Nadia", "Thomas", "Inès", "Marc", "Sofia", "Élias",
           "Jeanne", "Karim", "Alice", "Victor", "Nour", "Simon", "Clara", "Yanis", "Manon", "Basile",
           "Rosa", "Teodor", "Ana", "Piotr", "Maya", "Lucas", "Elsa", "Omar", "Juliette", "Noé"]
NOMS = ["Bertrand", "Nakamura", "Oliveira", "Schmidt", "Dubois", "Kowalski", "Rossi", "Andersen",
        "Martins", "Vasquez", "Leroy", "Haddad", "Novak", "Fontaine", "Moreau", "Silva", "Weber",
        "Girard", "Petit", "Lambert", "Costa", "Ivanov", "Garnier", "Meyer", "Perrin", "Roux"]
PAYS = ["France", "Allemagne", "Espagne", "Italie", "Belgique", "Pays-Bas", "Royaume-Uni", "Suisse",
        "Portugal", "Pologne", "Canada", "Japon"]


# Huit demandes de réservation encore à placer : c'est le cœur de « qui est libre, du X au Y ».
# Elles ne sont pas toutes tenables, et c'est voulu — une salle qui les accepte toutes se trompe.
DEMANDES = [
    {"id": "D1", "client": "K007", "arrivee": "2026-07-13", "depart": "2026-07-16", "adultes": 2, "enfants": 0, "vue_souhaitee": "mer", "services": "PDJ"},
    {"id": "D2", "client": "K015", "arrivee": "2026-08-10", "depart": "2026-08-14", "adultes": 2, "enfants": 1, "vue_souhaitee": "", "services": "PDJ|PARK"},
    {"id": "D3", "client": "K022", "arrivee": "2026-06-08", "depart": "2026-06-15", "adultes": 2, "enfants": 2, "vue_souhaitee": "jardin", "services": ""},
    {"id": "D4", "client": "K031", "arrivee": "2026-08-29", "depart": "2026-08-30", "adultes": 1, "enfants": 0, "vue_souhaitee": "", "services": "LATE"},
    {"id": "D5", "client": "K044", "arrivee": "2026-06-28", "depart": "2026-07-04", "adultes": 2, "enfants": 0, "vue_souhaitee": "mer", "services": "PDJ|SPA"},
    {"id": "D6", "client": "K009", "arrivee": "2026-07-02", "depart": "2026-07-05", "adultes": 3, "enfants": 1, "vue_souhaitee": "", "services": "PDJ"},
    {"id": "D7", "client": "K050", "arrivee": "2026-08-18", "depart": "2026-08-25", "adultes": 2, "enfants": 0, "vue_souhaitee": "cour", "services": "PARK"},
    {"id": "D8", "client": "K003", "arrivee": "2026-07-20", "depart": "2026-07-22", "adultes": 2, "enfants": 0, "vue_souhaitee": "", "services": ""},
]


def chambres():
    lignes, n = [], 0
    for typ, (cap, combien) in TYPES.items():
        for _ in range(combien):
            n += 1
            etage = 1 + (n - 1) // 8  # 8 chambres par étage, quatre étages
            numero = f"{etage}{(n - 1) % 8 + 1:02d}"
            vue = "jardin" if (n % 3 == 0) else ("mer" if etage >= 3 else "cour")
            etat = "travaux" if numero in ("405", "208") else "en_service"
            lignes.append({"id": f"C{numero}", "nom": f"Chambre {numero}", "type": typ,
                           "capacite": cap, "etage": etage, "vue": vue, "etat": etat})
    return lignes


def saison(j):
    for nom, d, f in SAISONS:
        if d <= j <= f:
            return nom
    raise ValueError(j)


def generer():
    r = random.Random(20260923)
    ch = chambres()
    clients, reservations = [], []
    for i in range(1, 61):
        niveau = r.choices(["aucun", "argent", "or"], weights=[60, 28, 12])[0]
        clients.append({"id": f"K{i:03d}", "nom": f"{r.choice(PRENOMS)} {r.choice(NOMS)}",
                        "pays": r.choice(PAYS), "fidelite": niveau})

    # occupation par chambre : on remplit chaque chambre par séjours successifs, avec des trous
    idr = 0
    for c in ch:
        if c["etat"] != "en_service":  # deux chambres en travaux : jamais occupées, jamais proposées
            continue
        jour = DEBUT + timedelta(days=r.randint(0, 6))
        while jour < FIN:
            nuits = r.choice([1, 2, 2, 3, 3, 4, 5, 7, 7, 14])
            depart = jour + timedelta(days=nuits)
            if depart > FIN + timedelta(days=1):
                break
            idr += 1
            k = r.choice(clients)
            cap = c["capacite"]
            adultes = min(cap, r.choice([1, 2, 2, 2, 3])) if cap > 1 else 1
            enfants = r.randint(0, cap - adultes) if cap - adultes > 0 and r.random() < 0.4 else 0
            services = []
            if r.random() < 0.55: services.append("PDJ")
            if r.random() < 0.3: services.append("PARK")
            if r.random() < 0.15: services.append("SPA")
            if r.random() < 0.08: services.append("ANIM")
            if r.random() < 0.1: services.append("LATE")
            statut = "annulee" if r.random() < 0.07 else "confirmee"
            reservations.append({
                "id": f"R{idr:03d}", "client": k["id"], "chambre": c["id"],
                "arrivee": jour.isoformat(), "depart": depart.isoformat(),
                "adultes": adultes, "enfants": enfants, "statut": statut,
                "services": "|".join(services),
            })
            # une fois sur trois, la chambre est reprise le jour même du départ (le piège)
            jour = depart if r.random() < 0.34 else depart + timedelta(days=r.randint(1, 4))

    SORTIE.mkdir(parents=True, exist_ok=True)
    def ecrire(nom, colonnes, lignes):
        with open(SORTIE / nom, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=colonnes, delimiter=";")
            w.writeheader()
            w.writerows(lignes)
        print(f"{nom} : {len(lignes)} lignes")

    ecrire("chambres.csv", ["id", "nom", "type", "capacite", "etage", "vue", "etat"], ch)
    ecrire("clients.csv", ["id", "nom", "pays", "fidelite"], clients)
    ecrire("reservations.csv", ["id", "client", "chambre", "arrivee", "depart", "adultes", "enfants", "statut", "services"], reservations)
    ecrire("tarifs.csv", ["saison", "debut", "fin", "type_chambre", "prix_nuit"],
           [{"saison": s, "debut": d.isoformat(), "fin": f.isoformat(), "type_chambre": t,
             "prix_nuit": f"{PRIX[(s, t)]:.2f}"} for s, d, f in SAISONS for t in TYPES])
    ecrire("services.csv", ["code", "nom", "prix", "unite"],
           [{"code": c, "nom": n, "prix": f"{p:.2f}", "unite": u} for c, n, p, u in SERVICES])
    ecrire("demandes.csv", ["id", "client", "arrivee", "depart", "adultes", "enfants", "vue_souhaitee", "services"], DEMANDES)


if __name__ == "__main__":
    generer()
