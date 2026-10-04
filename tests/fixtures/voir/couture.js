// Le JS crée la table avec le nom que la feuille de style attend, et pose selected/erreur plus tard.
const t = document.createElement("table"); t.className = "feuille"; t.innerHTML = "<tr><td>1</td></tr>";
document.getElementById("grid").appendChild(t);
t.addEventListener("click", (e) => { e.target.classList.add("selected"); e.target.classList.add("erreur"); });
