# ligne-references.py — les réponses du juge de la mission « ligne », calculées
# par sondes/vallee.py sur les entrées missions/entrees/ligne : bilans (réglages par défaut, trois variantes annoncées,
# six changements que la mission ne cite pas), positions des trains à quatre instants, fiches de quatre trains.
# Usage : python3 sondes/ligne-references.py <sortie.json>
import json, sys, importlib.util
from datetime import date
from pathlib import Path
spec = importlib.util.spec_from_file_location("v", "sondes/vallee.py"); V = importlib.util.module_from_spec(spec); spec.loader.exec_module(V)
V.ENTREES = Path("missions/entrees/ligne").resolve()

def minute(iso, hm):
    return (date.fromisoformat(iso) - date(2027, 1, 1)).days * 1440 + int(hm[:2]) * 60 + int(hm[3:])

AJOUT = {"numero": "901", "type": "E", "depart": "VP", "terminus": "CS", "heure": "14:30", "jours": "S", "saison": "toute", "arrets": "SA PV OH PS"}
FERMETURE = {"du": "2027-06-10", "au": "2027-06-10", "nature": "fermeture", "lieu": "PV-OH", "debut": "08:00", "fin": "12:00", "valeur": "", "recit": ""}
VARIANTES = {
    "defaut": {},
    "patience120": {"reglages": {"attente_max": 120}},
    "ardoise600": {"reglages": {"production_ardoise": 600}},
    "arret3": {"reglages": {"arret_omnibus": 3}},
    # non annoncées
    "neige_lente50": {"reglages": {"vitesse_neige": 50}},
    "seuil15": {"reglages": {"seuil_neige": 15}},
    "fonte1": {"reglages": {"fonte": 1}},
    "ajout901": {"ajouts": [AJOUT]},
    "retrait203": {"retraits": ["203"]},
    "fermeture_juin": {"fermetures": [FERMETURE]},
}
INSTANTS = [("2027-02-12", "08:17"), ("2027-01-14", "10:00"), ("2027-07-15", "12:00"), ("2027-02-20", "19:00")]
TRAINS = [("203", "2027-02-03"), ("101", "2027-11-11"), ("104", "2027-01-14"), ("102", "2027-06-02")]

out = {"variantes": {}, "positions": {}, "fiches": {}}
for nom, ch in VARIANTES.items():
    a = V.Annee(ch.get("reglages"), ch.get("ajouts", ()), ch.get("retraits", ()), ch.get("fermetures", ())).jouer()
    out["variantes"][nom] = {"changement": ch, "bilan": a.bilan()}
    if nom == "defaut":
        for iso, hm in INSTANTS:
            t = minute(iso, hm)
            out["positions"][f"{iso} {hm}"] = sorted([[x["numero"], p[0], p[1]] for x in a.trains if (p := a.position(x, t))], key=lambda r: r[0])
        for num, iso in TRAINS:
            d = (date.fromisoformat(iso) - date(2027, 1, 1)).days
            x = next(x for x in a.trains if x["numero"] == num and x["jour"] == d)
            g = x["route"][-1]
            out["fiches"][f"{num} {iso}"] = {"etat": x["etat"], "retard_terminus": (x["arr"][g] - x["arr_t"][g]) if x["etat"] == "arrive" else None,
                                               "causes": sorted({w["cause"] for w in x["attentes"]})}
json.dump(out, open(sys.argv[1], "w"), ensure_ascii=False, indent=1)
for k, v in out["variantes"].items(): print(k, v["bilan"]["circulations"], v["bilan"]["ponctualite_pct"], v["bilan"]["montes"], v["bilan"]["renonces"], v["bilan"]["tonnes"])
print(out["positions"]); print(out["fiches"])
