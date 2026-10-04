#!/usr/bin/env python3
"""Des questions que la mission festival ne cite pas, et leurs réponses (sondes/festival.py).

Programmes « et si » (autre arrivée, autre dernier train, envies modifiées), foule à des instants
tirés au hasard, pics de chaque jour. Graine fixe. Usage : python3 sondes/festival-questions.py > f.json
"""
import importlib.util, json, random, sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("festival", Path(__file__).resolve().parent / "festival.py")
F = importlib.util.module_from_spec(spec); spec.loader.exec_module(F)

r = random.Random(20260927)
programmes = []
for fid in F.festivaliers:
    for j in F.JOURS:
        p = F.programme(fid, j)
        programmes.append({"fid": fid, "jour": j, "envies": [{"id": c, "prio": v} for c, v in F.envies[fid].items()], **p})
ids = [c["id"] for c in F.concerts]
while len(programmes) < 32 + 60:
    fid = r.choice(sorted(F.festivaliers))
    j = r.choice(F.JOURS)
    env = dict(F.envies[fid])
    for c in r.sample(ids, r.randint(0, 6)):
        env[c] = r.randint(1, 3)
    for c in r.sample(sorted(env), min(len(env), r.randint(0, 3))):
        del env[c]
    arr = f"{r.randint(14, 21):02d}:{r.choice(['00', '15', '30', '45'])}"
    dep = r.choice(["22:30", "23:30", "00:45", "01:10", "02:00", "03:00", "04:00"])
    p = F.programme(fid, j, envies_f=env, arrivee=arr, depart=dep)
    programmes.append({"fid": fid, "jour": j, "arrivee": arr, "limite": dep, "envies": [{"id": c, "prio": v} for c, v in env.items()], **p})

foule = []
for _ in range(60):
    j = r.choice(F.JOURS)
    t = r.randint(14 * 60, 28 * 60)
    foule.append({"jour": j, "cle": t, "site": F.foule_a(j, t)})
pics = {j: {"valeur": F.foule(j)[0], "heure": F.hm(F.foule(j)[1])} for j in F.JOURS}
json.dump({"programmes": programmes, "foule": foule, "pics": pics}, sys.stdout, ensure_ascii=False, indent=1)
