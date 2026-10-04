// Le cerveau de l'essaim : la scène 3D de l'onglet Cerveau. Un neurone par agent, un trait de celui
// qui parle vers celui qu'il nomme, dans sa couleur, plus épais et plus lumineux quand il l'a nommé souvent ;
// autour, le contour d'un cerveau humain, en transparence. Figé à la fin du run, puis rejoué dans le temps.
// Les valeurs viennent d'une maquette validée et ne se règlent pas à l'œil ici. Script classique, comme Vue : three.js est attendu en global
// (window.THREE), aucun module ES, aucune import map. Le module ne touche au DOM que dans le conteneur reçu et
// rend compte à la vue par deux rappels, surEtat et surChoix ; c'est la vue qui écrit tout le texte.
(function () {
  "use strict";

  // Les vingt feutres de nuit, dans l'ordre des agents (celui de la vue) ; la vue passe sa propre copie, lue du CSS.
  const FEUTRES_NUIT = ["#5B94F0", "#3FC57D", "#F25C5C", "#A57BEA", "#FF9A4D", "#3FC6C8", "#C98A5E", "#F26AB3", "#B5C93B", "#9FB2C4", "#F2C14E", "#7F8EF5", "#4FD1F0", "#E36AD8", "#A8E63A", "#F0857D", "#5FD3D3", "#D9A06A", "#AFC45A", "#D77BC0"];
  const COULEUR_ANNEAU = { perdu: "#FF9A4D", vire: "#F25C5C" }; // l'anneau pointillé de ceux qui ne sont pas partis proprement
  const SECONDES_PAR_RUN = 60; // à ×1, tout le run passe en une minute
  const ETENDUE = { x: 3.45, y: 2.2, z: 4.4 }; // les neurones remplissent le cerveau jusqu'à sa paroi
  const cle = (a, b) => a + "→" + b;
  // Rôles des agents : l'icône du rôle dessinée sur chaque neurone, sombre sur sa couleur. Les mêmes tracés
  // (24 × 24) que les symboles r-* de la vue ; seul ajout à la scène, qui reste celle de la maquette.
  const ICONES_ROLES = {
    chef: ["M4 7h16M4 12h10M4 17h6", "M21 16a3 3 0 1 1-6 0a3 3 0 1 1 6 0z"],
    integrateur: ["M4 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM15 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1zM10 6.5h4v7.5"],
    constructeur: ["M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.1-.4-.4-2.1z"],
    recette: ["M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0z", "M8.5 12.5l2.5 2.5 4.5-5"],
    gardien: ["M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z", "M12 8v5l3 2"],
  };

  function creer(conteneur, donnees, options) {
    const THREE = window.THREE;
    if (!THREE) throw new Error("three.js n'est pas chargé");
    const o = Object.assign({ feutres: FEUTRES_NUIT, surEtat: () => {}, surChoix: () => {}, reduit: false, roles: {}, libelles: {} }, options || {});

    // ---- les données : les agents dans l'ordre reçu, les mentions dans l'ordre du temps ----
    const agents = donnees.agents || [];
    const index = new Map(agents.map((a, i) => [a.nom, i]));
    const feutre = (nom) => (index.has(nom) ? o.feutres[index.get(nom) % o.feutres.length] : "#9FB2C4");
    const messages = (donnees.messages || []).map((m) => ({ ...m, t: m.t == null ? 0 : m.t }));
    const mentions = [];
    for (const m of messages) for (const c of m.cibles || []) if (index.has(c) && index.has(m.auteur)) mentions.push({ t: m.t, a: m.auteur, b: c });
    mentions.sort((x, y) => x.t - y.t);
    const liens = new Map(); // "A→B" → { a, b, n, mesh, courbe }
    for (const m of mentions) { const l = liens.get(cle(m.a, m.b)) || { a: m.a, b: m.b, n: 0, mesh: null, courbe: null }; l.n++; liens.set(cle(m.a, m.b), l); }
    const DUREE = Math.max(1, donnees.duree_ms || (messages.length ? messages[messages.length - 1].t : 0) || 1);

    // ---- la scène ----
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const canvas = renderer.domElement;
    canvas.style.touchAction = "none";
    conteneur.prepend(canvas);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const lampe = new THREE.DirectionalLight(0xffffff, 0.9); lampe.position.set(4, 6, 8); scene.add(lampe);

    function redimensionner() {
      const w = conteneur.clientWidth, h = conteneur.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    const observateur = new ResizeObserver(redimensionner);
    observateur.observe(conteneur);
    redimensionner();

    // ---- l'orbite maison : glisser pour tourner, molette pour zoomer, rotation lente au repos ----
    const CIBLE = new THREE.Vector3(0, -1.0, 0); // la caméra vise sous le centre : le cerveau monte dans le cadre
    const orbite = { theta: 1.05, phi: 1.28, dist: 12.6, vTheta: 0, vPhi: 0, auto: !o.reduit };
    let glisse = null, bouge = 0;
    function placerCamera() {
      orbite.phi = Math.min(Math.PI - 0.2, Math.max(0.2, orbite.phi));
      camera.position.set(orbite.dist * Math.sin(orbite.phi) * Math.sin(orbite.theta), orbite.dist * Math.cos(orbite.phi), orbite.dist * Math.sin(orbite.phi) * Math.cos(orbite.theta)).add(CIBLE);
      camera.lookAt(CIBLE);
    }
    placerCamera();

    // ---- les textures : un halo doux, un anneau pointillé, une étiquette de texte ----
    function texHalo() {
      const c = document.createElement("canvas"); c.width = c.height = 128;
      const g = c.getContext("2d"); const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grd.addColorStop(0, "rgba(255,255,255,0.9)"); grd.addColorStop(0.25, "rgba(255,255,255,0.45)"); grd.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    }
    function texAnneau() {
      const c = document.createElement("canvas"); c.width = c.height = 128;
      const g = c.getContext("2d"); g.strokeStyle = "white"; g.lineWidth = 6; g.setLineDash([12, 9]); g.beginPath(); g.arc(64, 64, 56, 0, Math.PI * 2); g.stroke();
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    }
    const HALO = texHalo(), ANNEAU = texAnneau();
    // l'icône d'un rôle : les tracés de la vue, trait sombre, sur fond transparent ; une texture par rôle, partagée
    const icones = new Map();
    function texIcone(role) {
      if (!icones.has(role)) {
        const c = document.createElement("canvas"); c.width = c.height = 128;
        const g = c.getContext("2d"); g.scale(128 / 32, 128 / 32); g.translate(4, 4); // 24 unités au centre, 4 de marge
        g.strokeStyle = "#0F151B"; g.lineWidth = 2.4; g.lineCap = "round"; g.lineJoin = "round";
        for (const d of ICONES_ROLES[role]) g.stroke(new Path2D(d));
        const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; icones.set(role, t);
      }
      return icones.get(role);
    }
    function etiquette(texte) { // le prénom : IBM Plex Sans 600 14 px, clair, ombre noire ; largeur en unités = pixels / 92
      const c = document.createElement("canvas"); const g = c.getContext("2d"); const k = 2, taille = 14;
      const police = `600 ${taille * k}px "IBM Plex Sans", system-ui, sans-serif`;
      g.font = police;
      const w = Math.ceil(g.measureText(texte).width) + 8 * k, h = Math.round((taille + 6) * k);
      c.width = w; c.height = h;
      g.font = police; g.textAlign = "center"; g.textBaseline = "middle";
      g.shadowColor = "rgba(0,0,0,0.9)"; g.shadowBlur = 8 * k; g.fillStyle = "#E6EBF0";
      g.fillText(texte, w / 2, h / 2 + 1);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.minFilter = THREE.LinearFilter;
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, depthWrite: false }));
      s.scale.set(w / k / 92, h / k / 92, 1);
      return s;
    }

    // ---- le contour d'un cerveau humain : deux hémisphères, la scissure, des plis, rendu en lisière lumineuse ----
    function cerveauHumain() {
      const geo = new THREE.SphereGeometry(1, 180, 120);
      const pos = geo.attributes.position; const v = new THREE.Vector3();
      const plis = new Float32Array(pos.count);
      const bruit = (x, y, z) => 0.55 * Math.sin(6.3 * x + 2.1 * Math.sin(3.7 * z + 1.3)) * Math.cos(5.1 * y + 1.7 * Math.sin(4.3 * x))
        + 0.3 * Math.sin(9.7 * z + 2.9 * Math.cos(6.1 * y + 0.7)) * Math.cos(8.3 * x + 1.1 * Math.sin(7.9 * z))
        + 0.15 * Math.sin(15.1 * y + 3.3 * Math.sin(11.7 * x)) * Math.cos(13.9 * z);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        let y = v.y * 0.82; const x = v.x, z = v.z * 1.25;          // plus long d'avant en arrière, plus bas que large
        if (y < -0.3) y = -0.3 + (y + 0.3) * 0.4;                   // le dessous, aplati
        const fissure = Math.exp(-((v.x / 0.09) ** 2)) * THREE.MathUtils.smoothstep(v.y, -0.5, 0.15); // la scissure entre les hémisphères
        const pli = bruit(v.x * 1.6, v.y * 1.6, v.z * 1.6);
        const relief = 1 - 0.2 * fissure + 0.05 * pli * (1 - fissure);
        pos.setXYZ(i, x * relief, y * relief, z * relief);
        plis[i] = pli;
      }
      geo.setAttribute("pli", new THREE.BufferAttribute(plis, 1));
      geo.computeVertexNormals();
      return geo;
    }
    const cerveau = new THREE.Mesh(cerveauHumain(), new THREE.ShaderMaterial({
      uniforms: { couleur: { value: new THREE.Color("#8FB0D8") }, force: { value: 0.85 } },
      vertexShader: `attribute float pli; varying vec3 vN; varying vec3 vV; varying float vPli;
        void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vPli = pli; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 couleur; uniform float force; varying vec3 vN; varying vec3 vV; varying float vPli;
        void main() { float d = abs(dot(normalize(vN), normalize(vV))); float rim = pow(1.0 - d, 3.0);
          float plis = smoothstep(0.25, 0.9, vPli) * 0.055 * (1.0 - rim) * (gl_FrontFacing ? 1.0 : 0.3);
          gl_FragColor = vec4(couleur, rim * force * (gl_FrontFacing ? 1.0 : 0.45) + plis + 0.012); }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }));
    cerveau.scale.setScalar(3.8); cerveau.position.y = -0.6;
    scene.add(cerveau);

    // ---- les neurones ----
    const neurones = new Map();
    const spheres = [];
    for (const a of agents) {
      const couleur = new THREE.Color(feutre(a.nom));
      const r = 0.05 + 0.018 * Math.sqrt(a.messages || 0);
      const groupe = new THREE.Group();
      const corps = new THREE.Mesh(new THREE.SphereGeometry(r, 40, 28), new THREE.MeshStandardMaterial({ color: couleur, emissive: couleur, emissiveIntensity: 0.55, roughness: 0.35, metalness: 0.05 }));
      corps.userData.nom = a.nom;
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: HALO, color: couleur, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
      halo.scale.setScalar(r * 7.5);
      const nom = etiquette(o.libelles[a.nom] ?? a.nom); nom.position.set(0, r + 0.2, 0);
      const anneau = new THREE.Sprite(new THREE.SpriteMaterial({ map: ANNEAU, color: new THREE.Color(COULEUR_ANNEAU[a.etat] || "#ffffff"), transparent: true, opacity: 0.85, depthWrite: false }));
      anneau.scale.setScalar(r * 4.2); anneau.visible = a.etat in COULEUR_ANNEAU;
      groupe.add(corps, halo, nom, anneau);
      // l'icône du rôle, posée devant la sphère (placée face à la caméra à chaque image) ; aucune sans rôle
      const role = o.roles[a.nom];
      const icone = role in ICONES_ROLES ? new THREE.Sprite(new THREE.SpriteMaterial({ map: texIcone(role), transparent: true, depthWrite: false })) : null;
      if (icone) { icone.scale.setScalar(r * 1.9); groupe.add(icone); }
      scene.add(groupe);
      spheres.push(corps);
      neurones.set(a.nom, { agent: a, groupe, corps, halo, nom, anneau, icone, r, flash: 0, presence: 1, eclat: 1, position: groupe.position });
    }

    // ---- les traits : un tube courbe, dans la couleur de celui qui parle, qui s'éteint vers celui qu'il nomme ----
    const groupeLiens = new THREE.Group(); scene.add(groupeLiens);
    function courbeDe(a, b) {
      const pa = neurones.get(a).position, pb = neurones.get(b).position;
      const dir = pb.clone().sub(pa); const d = dir.length(); dir.normalize();
      let perp = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
      if (perp.lengthSq() < 1e-4) perp = new THREE.Vector3(1, 0, 0);
      perp.normalize().multiplyScalar(0.22 * d * (a < b ? 1 : -1)); // les deux sens se courbent chacun de son côté
      const milieu = pa.clone().add(pb).multiplyScalar(0.5).add(perp);
      return new THREE.QuadraticBezierCurve3(pa.clone(), milieu, pb.clone());
    }
    function retirerTube(lien) {
      if (!lien.mesh) return;
      lien.mesh.geometry.dispose(); lien.mesh.material.dispose(); groupeLiens.remove(lien.mesh); lien.mesh = null;
    }
    function construireTube(lien) {
      retirerTube(lien);
      if (lien.n <= 0) return;
      const courbe = courbeDe(lien.a, lien.b); lien.courbe = courbe;
      const seg = 28, rad = 6;
      const geo = new THREE.TubeGeometry(courbe, seg, 0.0025 + 0.002 * Math.sqrt(lien.n), rad, false);
      const couleur = new THREE.Color(feutre(lien.a)); const sombre = couleur.clone().multiplyScalar(0.18);
      const cols = new Float32Array(geo.attributes.position.count * 3);
      for (let i = 0; i <= seg; i++) { const c = couleur.clone().lerp(sombre, Math.pow(i / seg, 1.4)); for (let j = 0; j <= rad; j++) { const k = (i * (rad + 1) + j) * 3; cols[k] = c.r; cols[k + 1] = c.g; cols[k + 2] = c.b; } }
      geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
      lien.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
      groupeLiens.add(lien.mesh);
    }

    // ---- la disposition : un nuage où les agents qui se parlent se rapprochent, étiré jusqu'à la paroi ----
    function fibonacci(i, n, rayon) {
      const y = 1 - (i / Math.max(1, n - 1)) * 2; const r = Math.sqrt(Math.max(0, 1 - y * y)); const phi = i * 2.399963;
      return new THREE.Vector3(Math.cos(phi) * r * rayon, y * rayon, Math.sin(phi) * r * rayon);
    }
    function dispositionNuage() {
      const n = agents.length;
      const p = agents.map((_, i) => fibonacci(i, n, 2.5));
      if (n === 1) p[0].set(0, 0, 0);
      const v = p.map(() => new THREE.Vector3());
      const L = [...liens.values()].map((l) => ({ a: index.get(l.a), b: index.get(l.b), w: l.n }));
      const f = p.map(() => new THREE.Vector3()); const d = new THREE.Vector3();
      for (let it = 0; it < 700 && n > 1; it++) {
        for (const q of f) q.set(0, 0, 0);
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { d.subVectors(p[i], p[j]); const dist = Math.max(d.length(), 0.08); d.multiplyScalar(5.5 / (dist * dist * dist)); f[i].add(d); f[j].sub(d); }
        for (const l of L) { d.subVectors(p[l.b], p[l.a]); const dist = d.length(); d.multiplyScalar(0.09 * Math.log2(1 + l.w) * (dist - 1.6) / Math.max(dist, 1e-3)); f[l.a].add(d); f[l.b].sub(d); }
        for (let i = 0; i < n; i++) { f[i].addScaledVector(p[i], -0.12); v[i].addScaledVector(f[i], 0.05).multiplyScalar(0.82); p[i].add(v[i]); }
      }
      // on étire vers la paroi : ceux du centre sont poussés dehors pour que le réseau occupe tout le volume
      const rmax = Math.max(1e-6, ...p.map((q) => q.length()));
      for (const q of p) { const r = q.length() / rmax; if (r > 1e-6) q.multiplyScalar(Math.pow(r, 0.45) / q.length()); q.x *= ETENDUE.x; q.y *= ETENDUE.y; q.z *= ETENDUE.z; }
      return p;
    }
    const positions = dispositionNuage();
    agents.forEach((a, i) => neurones.get(a.nom).position.copy(positions[i]));

    // ---- le focus : survol ou clic sur un neurone, ses traits ressortent, les autres s'effacent ----
    let survole = null, choisi = null;
    const raycaster = new THREE.Raycaster(); const souris = new THREE.Vector2(-2, -2);
    function appliquerFocus() {
      const f = choisi || survole;
      for (const l of liens.values()) {
        if (!l.mesh) continue;
        const touche = !f || l.a === f || l.b === f;
        l.mesh.material.opacity = touche ? Math.min(0.95, (f ? 0.5 : 0.3) + 0.08 * l.n) : 0.05;
      }
      const voisins = new Set();
      if (f) for (const l of liens.values()) { if (l.n > 0 && l.a === f) voisins.add(l.b); if (l.n > 0 && l.b === f) voisins.add(l.a); }
      for (const ne of neurones.values()) {
        const plein = !f || ne.agent.nom === f || voisins.has(ne.agent.nom);
        ne.eclat = plein ? 1 : 0.32;
        ne.corps.scale.setScalar(ne.agent.nom === f ? 1.18 : 1);
      }
    }
    function reconstruireTout() { for (const l of liens.values()) construireTube(l); appliquerFocus(); }
    reconstruireTout();

    const surPointerMove = (e) => {
      const r = canvas.getBoundingClientRect();
      souris.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      if (!glisse) return;
      const dx = e.clientX - glisse.x, dy = e.clientY - glisse.y; glisse = { x: e.clientX, y: e.clientY }; bouge += Math.abs(dx) + Math.abs(dy);
      orbite.vTheta -= dx * 0.0045; orbite.vPhi -= dy * 0.0045;
    };
    const surPointerLeave = () => { souris.set(-2, -2); glisse = null; };
    const surPointerDown = (e) => { glisse = { x: e.clientX, y: e.clientY }; bouge = 0; try { canvas.setPointerCapture(e.pointerId); } catch {} };
    const surPointerUp = () => {
      glisse = null;
      if (bouge > 6) return; // c'était une rotation, pas un clic
      choisir(survole && survole === choisi ? null : survole);
    };
    const surWheel = (e) => { e.preventDefault(); orbite.dist = Math.min(24, Math.max(5, orbite.dist * Math.exp(e.deltaY * 0.0012))); };
    canvas.addEventListener("pointermove", surPointerMove);
    canvas.addEventListener("pointerleave", surPointerLeave);
    canvas.addEventListener("pointerdown", surPointerDown);
    canvas.addEventListener("pointerup", surPointerUp);
    canvas.addEventListener("wheel", surWheel, { passive: false });

    function choisir(nom) {
      choisi = nom && neurones.has(nom) ? nom : null;
      appliquerFocus();
      o.surChoix(choisi);
      emettre(true);
    }

    // ---- les impulsions : de petites lumières qui courent le long des traits ----
    const impulsions = [], reserve = [], toutes = [];
    function impulsion(lien, dureeMs) {
      if (!lien.courbe) return;
      let p = reserve.pop();
      if (!p) {
        const corps = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 10), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }));
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: HALO, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })); halo.scale.setScalar(0.26);
        const g = new THREE.Group(); g.add(corps, halo); scene.add(g);
        p = { g, corps, halo }; toutes.push(p);
      }
      p.halo.material.color.set(feutre(lien.a)); p.g.visible = true;
      impulsions.push({ p, courbe: lien.courbe, t0: performance.now(), duree: dureeMs });
    }
    function avancerImpulsions(now) {
      for (let i = impulsions.length - 1; i >= 0; i--) {
        const im = impulsions[i]; const u = (now - im.t0) / im.duree;
        if (u >= 1) { im.p.g.visible = false; reserve.push(im.p); impulsions.splice(i, 1); continue; }
        im.p.g.position.copy(im.courbe.getPointAt(u));
        im.p.halo.material.opacity = 0.9 * (1 - u * 0.5);
      }
    }

    // ---- la lecture du run : figé à la fin, puis on rejoue les messages dans le temps ----
    let mode = "fin"; // fin | lecture | pause
    let tRun = DUREE, vitesse = 1, prochaine = mentions.length, dernierMessage = messages.length - 1;
    function comptesA(t) { // l'état des traits à l'instant t, sans impulsions
      for (const l of liens.values()) l.n = 0;
      let i = 0; for (; i < mentions.length && mentions[i].t <= t; i++) liens.get(cle(mentions[i].a, mentions[i].b)).n++;
      prochaine = i;
      dernierMessage = -1; for (let k = 0; k < messages.length && messages[k].t <= t; k++) dernierMessage = k;
      reconstruireTout();
    }
    function presenceA(t) { // pendant la lecture, un agent sorti de la salle s'assombrit ; à la fin, tout le monde est là
      for (const ne of neurones.values()) {
        const sorti = mode !== "fin" && ne.agent.t_fin != null && t >= ne.agent.t_fin;
        ne.presence = sorti ? 0.45 : 1;
        ne.anneau.visible = ne.agent.etat in COULEUR_ANNEAU && (mode === "fin" || sorti);
      }
    }
    function jouer() {
      if (detruit) return;
      if (mode === "fin") { tRun = 0; comptesA(0); }
      mode = "lecture"; orbite.auto = false; presenceA(tRun); emettre(true);
    }
    function pause() { if (detruit) return; mode = "pause"; emettre(true); }
    function finir() { if (detruit) return; mode = "fin"; tRun = DUREE; comptesA(DUREE); orbite.auto = !o.reduit; presenceA(DUREE); emettre(true); }
    function allerA(t) {
      if (detruit) return;
      if (t >= DUREE) { finir(); return; }
      mode = "pause"; tRun = Math.max(0, t); comptesA(tRun); presenceA(tRun); emettre(true);
    }
    function reglerVitesse(v) { vitesse = [1, 2, 4].includes(v) ? v : 1; }

    // ---- ce que la vue affiche : au plus dix fois par seconde, plus à chaque changement ----
    let dernierEnvoi = 0;
    function emettre(force) {
      const now = performance.now();
      if (!force && now - dernierEnvoi < 100) return;
      dernierEnvoi = now;
      let liensVus = 0; for (const l of liens.values()) if (l.n > 0) liensVus++;
      const direct = mode === "fin" || dernierMessage < 0 ? null : messages[dernierMessage];
      o.surEtat({ mode, t: tRun, duree: DUREE, messagesVus: dernierMessage + 1, liensVus, liens: liens.size, messages: messages.length, mentions: mentions.length,
        direct: direct ? { auteur: direct.auteur, titre: direct.titre, cibles: direct.cibles || [] } : null, survole, choisi });
    }

    // ---- la boucle ----
    let avant = performance.now(), prochaineImpulsionLibre = 0, trame = 0, detruit = false;
    function boucle(now) {
      if (detruit) return;
      trame = requestAnimationFrame(boucle);
      const dt = Math.min(0.1, (now - avant) / 1000); avant = now;

      if (mode === "lecture") {
        tRun = Math.min(DUREE, tRun + dt * 1000 * (DUREE / (SECONDES_PAR_RUN * 1000)) * vitesse);
        while (prochaine < mentions.length && mentions[prochaine].t <= tRun) {
          const m = mentions[prochaine++]; const l = liens.get(cle(m.a, m.b)); l.n++; construireTube(l);
          neurones.get(m.a).flash = 1; impulsion(l, 1100 / Math.sqrt(vitesse));
        }
        while (dernierMessage + 1 < messages.length && messages[dernierMessage + 1].t <= tRun) { dernierMessage++; const ne = neurones.get(messages[dernierMessage].auteur); if (ne) ne.flash = 1; }
        presenceA(tRun); appliquerFocus(); emettre(false);
        if (tRun >= DUREE) finir();
      } else if (mode === "fin" && !o.reduit && now > prochaineImpulsionLibre) { // au repos, le cerveau respire : une impulsion de temps en temps, plutôt sur les traits forts
        const pool = [...liens.values()].filter((l) => l.n > 0); const total = pool.reduce((s, l) => s + l.n, 0);
        let r = Math.random() * total; for (const l of pool) { r -= l.n; if (r <= 0) { impulsion(l, 1600); break; } }
        prochaineImpulsionLibre = now + 420;
      }

      // le survol
      raycaster.setFromCamera(souris, camera);
      const touche = raycaster.intersectObjects(spheres)[0];
      const nouveau = touche ? touche.object.userData.nom : null;
      if (nouveau !== survole) { survole = nouveau; canvas.classList.toggle("pointe", !!survole); appliquerFocus(); emettre(true); }

      // l'éclat de chaque neurone : son focus, sa présence, son éclair quand il parle
      for (const ne of neurones.values()) {
        ne.flash = Math.max(0, ne.flash - dt * 1.6);
        const e = ne.eclat * ne.presence;
        ne.corps.material.emissiveIntensity = 0.45 * e + 1.4 * ne.flash;
        ne.halo.material.opacity = 0.5 * e + 0.45 * ne.flash;
        ne.halo.scale.setScalar(ne.r * (7.5 + 3 * ne.flash));
        ne.nom.material.opacity = 0.35 + 0.65 * e;
        ne.anneau.material.opacity = 0.85 * e;
        if (ne.icone) { // devant la sphère, du côté de la caméra, à sa taille (le focus la grossit)
          const k = ne.corps.scale.x;
          ne.icone.position.copy(camera.position).sub(ne.position).normalize().multiplyScalar(ne.r * k * 1.02);
          ne.icone.scale.setScalar(ne.r * k * 1.9);
          ne.icone.material.opacity = 0.9 * e;
        }
      }
      avancerImpulsions(now);
      if (orbite.auto && !glisse) orbite.theta += 0.05 * dt;
      orbite.theta += orbite.vTheta; orbite.phi += orbite.vPhi; orbite.vTheta *= 0.86; orbite.vPhi *= 0.86;
      placerCamera();
      renderer.render(scene, camera);
    }
    // les prénoms sont redessinés quand la police de la vue est prête (sinon ils gardent la police de secours)
    if (document.fonts && document.fonts.load) {
      document.fonts.load('600 14px "IBM Plex Sans"').then(() => {
        if (detruit) return;
        for (const ne of neurones.values()) { const s = etiquette(o.libelles[ne.agent.nom] ?? ne.agent.nom); s.position.copy(ne.nom.position); ne.groupe.remove(ne.nom); ne.nom.material.map.dispose(); ne.nom.material.dispose(); ne.nom = s; ne.groupe.add(s); }
      }).catch(() => {});
    }
    presenceA(DUREE);
    emettre(true);
    trame = requestAnimationFrame(boucle);

    // ---- tout rendre : plus une image, plus un écouteur, plus un octet de carte graphique ----
    function detruire() {
      if (detruit) return;
      detruit = true;
      cancelAnimationFrame(trame);
      observateur.disconnect();
      canvas.removeEventListener("pointermove", surPointerMove);
      canvas.removeEventListener("pointerleave", surPointerLeave);
      canvas.removeEventListener("pointerdown", surPointerDown);
      canvas.removeEventListener("pointerup", surPointerUp);
      canvas.removeEventListener("wheel", surWheel);
      for (const l of liens.values()) retirerTube(l);
      for (const ne of neurones.values()) {
        ne.corps.geometry.dispose(); ne.corps.material.dispose();
        ne.halo.material.dispose(); ne.anneau.material.dispose();
        if (ne.icone) ne.icone.material.dispose();
        ne.nom.material.map.dispose(); ne.nom.material.dispose();
        scene.remove(ne.groupe);
      }
      for (const p of toutes) { p.corps.geometry.dispose(); p.corps.material.dispose(); p.halo.material.dispose(); scene.remove(p.g); }
      cerveau.geometry.dispose(); cerveau.material.dispose(); scene.remove(cerveau);
      HALO.dispose(); ANNEAU.dispose();
      for (const t of icones.values()) t.dispose();
      renderer.dispose();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }

    return { jouer, pause, finir, allerA, vitesse: reglerVitesse, choisir, detruire };
  }

  window.Cerveau = { creer };
})();
