/*
 * Étape 3 : actions sur le dashboard.
 *
 * La page envoie, avec chaque phrase, un état résumé du dashboard (tâches, chantiers,
 * rendez-vous, minuteur, onglet, lumières…). Le modèle peut appeler l'outil
 * `action_dashboard`. Le serveur ne touche à rien : il vérifie chaque action sur une
 * copie de cet état, répond au modèle « fait » ou « erreur », et renvoie à la page la
 * liste des actions validées, que la page exécute elle-même.
 */

export const ONGLETS = ["accueil", "maison", "chantiers", "gestion", "agenda", "taches", "meteo", "reglages", "actualites", "personnel", "minuteur"];
export const PIECES = ["salon", "cuisine", "bureau", "chambres", "exterieur"];
const COULEURS = ["bleu", "violet", "vert"];

export const TYPES = [
  "ajouter_tache",
  "cocher_tache",
  "supprimer_tache",
  "supprimer_taches_terminees",
  "ajouter_chantier",
  "modifier_chantier",
  "supprimer_chantier",
  "ajouter_rendez_vous",
  "supprimer_rendez_vous",
  "lancer_minuteur",
  "arreter_minuteur",
  "changer_onglet",
  "lumiere",
  "volets",
  "chauffage",
  "presence",
  "actualiser_meteo",
  "changer_ville",
  "afficher_actualites",
  "jouer_radio",
  "arreter_musique",
  "volume_musique",
];

/** @type {import("@anthropic-ai/sdk").Anthropic.Beta.BetaTool} */
export const OUTIL_DASHBOARD = {
  name: "action_dashboard",
  description: [
    "Agit sur le dashboard affiché à l'écran. Appelle cet outil une fois par action ; plusieurs appels dans la même réponse sont exécutés dans l'ordre.",
    "Les noms de tâche, de chantier, de rendez-vous et de personne doivent désigner un élément de l'état du dashboard fourni avec la question ; un extrait du nom suffit s'il est sans ambiguïté.",
    "Types et champs de `donnees` :",
    "- ajouter_tache : { texte }",
    "- cocher_tache : { tache, faite (booléen, true par défaut) }",
    "- supprimer_tache : { tache }",
    "- supprimer_taches_terminees : {}",
    "- ajouter_chantier : { nom, avancement (0 à 100, 0 par défaut) }",
    "- modifier_chantier : { chantier, avancement (0 à 100) }",
    "- supprimer_chantier : { chantier }",
    "- ajouter_rendez_vous : { heure (HH:MM), titre, detail (facultatif), couleur (bleu, violet ou vert, facultatif) } — rendez-vous du jour, gardés sur l'appareil",
    "- supprimer_rendez_vous : { rendez_vous (titre), heure (facultatif, pour départager) }",
    "- lancer_minuteur : { minutes (nombre, décimales permises : 0.5 pour 30 secondes ; de 0.1 à 720) }",
    "- arreter_minuteur : {}",
    "- changer_onglet : { onglet : accueil, maison, chantiers, gestion (chiffres de gestion ProGBat), agenda, taches, meteo, reglages, actualites, personnel (salariés : sur chantier, au bureau, absents) ou minuteur (page du minuteur) }. « Finances » désigne l'onglet gestion ; « les salariés », « l'équipe » ou « le personnel » désignent l'onglet personnel",
    "- lumiere : { piece : salon, cuisine, bureau, chambres, exterieur ou toutes ; allume (booléen) ; intensite (0 à 100, facultatif) }",
    "- volets : { ouverts (booléen) }",
    "- chauffage : { consigne (degrés, de 15 à 25, par pas de 0.5) }",
    "- presence : { personne, a_la_maison (booléen) } — les personnes sont les salariés de l'entreprise ; a_la_maison vrai signifie « présent », faux « absent »",
    "- actualiser_meteo : {}",
    "- changer_ville : { ville, pays (facultatif) } — change la ville dont la météo est affichée, partout dans le monde",
    "- jouer_radio : { recherche } — lance une radio en ligne : nom de station (« RTL2 », « FIP », « France Info ») ou genre (« jazz », « rock », « classique »). Pour « mets de la musique » sans précision, reprends la dernière station du bloc musique ou choisis « FIP »",
    "- arreter_musique : {} — arrête la radio",
    "- volume_musique : { niveau (0 à 100) } — règle le volume de la radio ; pour « plus fort » ou « moins fort », pars du volume du bloc musique et change-le de 20",
    "- afficher_actualites : { rubrique (identifiant donné par rubriques_actualites, facultatif) } — affiche à l'écran les titres de cette rubrique, avec source, heure et lien",
  ].join("\n"),
  input_schema: {
    type: "object",
    properties: {
      type: { type: "string", enum: TYPES, description: "Type d'action." },
      donnees: { type: "object", description: "Paramètres de l'action, selon le type." },
    },
    required: ["type"],
  },
};

/* ---------- état envoyé par la page : nettoyage et bornes ---------- */

function texte(v, max = 200) {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function nombre(v, a, b, defaut) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : defaut;
}
function tableau(v, max) {
  return Array.isArray(v) ? v.slice(0, max) : [];
}

export function nettoyerEtat(brut) {
  const e = brut && typeof brut === "object" ? brut : {};
  const lum = e.lumieres && typeof e.lumieres === "object" ? e.lumieres : {};
  const m = e.minuteur && typeof e.minuteur === "object" ? e.minuteur : {};
  return {
    onglet: ONGLETS.includes(e.onglet) ? e.onglet : "accueil",
    taches: tableau(e.taches, 100)
      .map((t) => ({ texte: texte(t?.texte), faite: t?.faite === true }))
      .filter((t) => t.texte),
    chantiers: tableau(e.chantiers, 50)
      .map((c) => ({ nom: texte(c?.nom), avancement: Math.round(nombre(c?.avancement, 0, 100, 0)) }))
      .filter((c) => c.nom),
    agenda: tableau(e.agenda, 50)
      .map((r) => ({ heure: /^\d{2}:\d{2}$/.test(r?.heure) ? r.heure : "", titre: texte(r?.titre), detail: texte(r?.detail) }))
      .filter((r) => r.titre),
    musique: {
      en_cours: e.musique?.en_cours === true,
      station: texte(e.musique?.station, 80),
      volume: Math.round(nombre(e.musique?.volume, 0, 100, 60)),
    },
    minuteur: {
      actif: m.actif === true,
      reste_secondes: Math.round(nombre(m.reste_secondes, 0, 720 * 60, 0)),
      sonne: m.sonne === true,
    },
    lumieres: Object.fromEntries(PIECES.map((p) => [p, Math.round(nombre(lum[p], 0, 100, 0))])),
    volets_ouverts: e.volets_ouverts === true,
    chauffage: nombre(e.chauffage, 15, 25, 21),
    famille: tableau(e.famille, 10)
      .map((p) => ({ nom: texte(p?.nom, 60), a_la_maison: p?.a_la_maison !== false }))
      .filter((p) => p.nom),
    meteo: texte(e.meteo, 1200),
    utilisateur: texte(e.utilisateur, 40),
  };
}

/* ---------- recherche d'un élément par son nom ---------- */

function simplifier(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const MOTS_VIDES = new Set("le la les l un une des de du d au aux a et ma mon mes ta ton tes sa son ses ce cette tache chantier rendez vous".split(" "));

/* Renvoie l'élément trouvé, ou lève une erreur lisible par le modèle. */
function trouver(liste, cle, demande, quoi, filtre = () => true) {
  const d = simplifier(demande);
  if (!d) throw new Error(`Précise ${quoi}.`);
  const candidats = liste.filter(filtre);
  const exacts = candidats.filter((x) => simplifier(x[cle]) === d);
  if (exacts.length >= 1) return exacts[0];
  // tous les mots significatifs de la demande doivent se retrouver dans le nom
  const mots = d.split(" ").filter((m) => !MOTS_VIDES.has(m));
  const partiels = candidats.filter((x) => {
    const nom = simplifier(x[cle]);
    return nom.includes(d) || (mots.length > 0 && mots.every((m) => nom.includes(m)));
  });
  if (partiels.length === 1) return partiels[0];
  const noms = candidats.map((x) => `« ${x[cle]} »`).join(", ") || "aucun";
  if (partiels.length > 1) {
    throw new Error(`Plusieurs correspondances pour « ${demande} » : ${partiels.map((x) => `« ${x[cle]} »`).join(", ")}. Demande laquelle.`);
  }
  throw new Error(`Aucun élément ne correspond à « ${demande} ». Existants : ${noms}.`);
}

function booleen(v, defaut) {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  if (defaut !== undefined) return defaut;
  throw new Error("Valeur vraie ou fausse attendue.");
}

function nombreRequis(v, a, b, nom) {
  const n = typeof v === "number" ? v : parseFloat(v);
  if (!Number.isFinite(n)) throw new Error(`${nom} : nombre attendu.`);
  if (n < a || n > b) throw new Error(`${nom} : entre ${a} et ${b}.`);
  return n;
}

function majuscule(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/*
 * Vérifie une action et l'applique à la copie de l'état (pour que les actions suivantes
 * de la même réponse voient le résultat). Renvoie { action, compte_rendu } ou lève une erreur.
 */
export function verifierAction(etat, entree) {
  const type = entree?.type;
  const d = entree?.donnees && typeof entree.donnees === "object" ? entree.donnees : {};
  if (!TYPES.includes(type)) throw new Error(`Type d'action inconnu : ${type}. Types possibles : ${TYPES.join(", ")}.`);

  switch (type) {
    case "ajouter_tache": {
      const t = majuscule(texte(d.texte));
      if (!t) throw new Error("Texte de la tâche manquant.");
      etat.taches.unshift({ texte: t, faite: false });
      return { action: { type, donnees: { texte: t } }, compte_rendu: `Tâche « ${t} » ajoutée.` };
    }
    case "cocher_tache": {
      const t = trouver(etat.taches, "texte", d.tache, "la tâche");
      const faite = booleen(d.faite, true);
      t.faite = faite;
      return { action: { type, donnees: { texte: t.texte, faite } }, compte_rendu: `Tâche « ${t.texte} » marquée ${faite ? "faite" : "à faire"}.` };
    }
    case "supprimer_tache": {
      const t = trouver(etat.taches, "texte", d.tache, "la tâche");
      etat.taches.splice(etat.taches.indexOf(t), 1);
      return { action: { type, donnees: { texte: t.texte } }, compte_rendu: `Tâche « ${t.texte} » supprimée.` };
    }
    case "supprimer_taches_terminees": {
      const n = etat.taches.filter((t) => t.faite).length;
      etat.taches = etat.taches.filter((t) => !t.faite);
      return { action: { type, donnees: {} }, compte_rendu: `${n} tâche(s) terminée(s) supprimée(s).` };
    }
    case "ajouter_chantier": {
      const nom = majuscule(texte(d.nom));
      if (!nom) throw new Error("Nom du chantier manquant.");
      const avancement = Math.round(d.avancement == null ? 0 : nombreRequis(d.avancement, 0, 100, "avancement"));
      etat.chantiers.push({ nom, avancement });
      return { action: { type, donnees: { nom, avancement } }, compte_rendu: `Chantier « ${nom} » ajouté à ${avancement} %.` };
    }
    case "modifier_chantier": {
      const c = trouver(etat.chantiers, "nom", d.chantier, "le chantier");
      const avancement = Math.round(nombreRequis(d.avancement, 0, 100, "avancement"));
      c.avancement = avancement;
      return { action: { type, donnees: { nom: c.nom, avancement } }, compte_rendu: `Chantier « ${c.nom} » à ${avancement} %.` };
    }
    case "supprimer_chantier": {
      const c = trouver(etat.chantiers, "nom", d.chantier, "le chantier");
      etat.chantiers.splice(etat.chantiers.indexOf(c), 1);
      return { action: { type, donnees: { nom: c.nom } }, compte_rendu: `Chantier « ${c.nom} » supprimé.` };
    }
    case "ajouter_rendez_vous": {
      const m = /^(\d{1,2})[:h](\d{2})?$/.exec(texte(d.heure, 10));
      if (!m || +m[1] > 23 || +(m[2] || 0) > 59) throw new Error("Heure attendue au format HH:MM.");
      const heure = `${m[1].padStart(2, "0")}:${m[2] || "00"}`;
      const titre = majuscule(texte(d.titre));
      if (!titre) throw new Error("Titre du rendez-vous manquant.");
      const couleur = COULEURS.includes(d.couleur) ? d.couleur : "bleu";
      const detail = texte(d.detail);
      etat.agenda.push({ heure, titre, detail });
      return { action: { type, donnees: { heure, titre, detail, couleur } }, compte_rendu: `Rendez-vous « ${titre} » ajouté à ${heure}.` };
    }
    case "supprimer_rendez_vous": {
      const heure = texte(d.heure, 5);
      const r = trouver(etat.agenda, "titre", d.rendez_vous, "le rendez-vous", (x) => !heure || x.heure === heure);
      etat.agenda.splice(etat.agenda.indexOf(r), 1);
      return { action: { type, donnees: { heure: r.heure, titre: r.titre } }, compte_rendu: `Rendez-vous « ${r.titre} » de ${r.heure} supprimé.` };
    }
    case "lancer_minuteur": {
      const minutes = Math.round(nombreRequis(d.minutes, 0.1, 720, "minutes") * 60) / 60;
      etat.minuteur = { actif: true, reste_secondes: Math.round(minutes * 60), sonne: false };
      return { action: { type, donnees: { minutes } }, compte_rendu: `Minuteur lancé pour ${Math.round(minutes * 60)} secondes.` };
    }
    case "arreter_minuteur": {
      etat.minuteur = { actif: false, reste_secondes: 0, sonne: false };
      return { action: { type, donnees: {} }, compte_rendu: "Minuteur arrêté." };
    }
    case "changer_onglet": {
      const onglet = simplifier(d.onglet).replace(/s$/, "").replace(/^tache$/, "taches").replace(/^reglage$/, "reglages").replace(/^chantier$/, "chantiers").replace(/^(actualite|info|nouvelle)$/, "actualites").replace(/^(finance|chiffre)$/, "gestion").replace(/^(salarie|equipe|effectif)$/, "personnel").replace(/^(chrono|chronometre|timer)$/, "minuteur");
      if (!ONGLETS.includes(onglet)) throw new Error(`Onglet inconnu. Onglets : ${ONGLETS.join(", ")}.`);
      etat.onglet = onglet;
      return { action: { type, donnees: { onglet } }, compte_rendu: `Onglet ${onglet} affiché.` };
    }
    case "lumiere": {
      const piece = simplifier(d.piece).replace(/ /g, "");
      const pieces = piece === "toutes" || piece === "tout" ? PIECES : PIECES.filter((p) => p === piece || p === piece + "s");
      if (!pieces.length) throw new Error(`Pièce inconnue. Pièces : ${PIECES.join(", ")} ou toutes.`);
      const allume = booleen(d.allume, d.intensite != null ? Number(d.intensite) > 0 : undefined);
      const intensite = d.intensite == null ? null : Math.round(nombreRequis(d.intensite, 0, 100, "intensité"));
      pieces.forEach((p) => (etat.lumieres[p] = allume ? (intensite ?? (etat.lumieres[p] || 100)) : 0));
      const nomPiece = pieces.length > 1 ? "toutes les pièces" : pieces[0];
      return {
        action: { type, donnees: { piece: pieces.length > 1 ? "toutes" : pieces[0], allume, intensite } },
        compte_rendu: `Lumière ${allume ? "allumée" : "éteinte"} : ${nomPiece}${allume && intensite != null ? ` à ${intensite} %` : ""} (affichage de démonstration).`,
      };
    }
    case "volets": {
      const ouverts = booleen(d.ouverts);
      etat.volets_ouverts = ouverts;
      return { action: { type, donnees: { ouverts } }, compte_rendu: `Volets ${ouverts ? "ouverts" : "fermés"} (affichage de démonstration).` };
    }
    case "chauffage": {
      const consigne = Math.round(nombreRequis(d.consigne, 15, 25, "consigne") * 2) / 2;
      etat.chauffage = consigne;
      return { action: { type, donnees: { consigne } }, compte_rendu: `Consigne de chauffage à ${consigne} °C (affichage de démonstration).` };
    }
    case "presence": {
      const p = trouver(etat.famille, "nom", d.personne, "le salarié");
      const ici = booleen(d.a_la_maison);
      p.a_la_maison = ici;
      return { action: { type, donnees: { nom: p.nom, a_la_maison: ici } }, compte_rendu: `${p.nom} : ${ici ? "présent" : "absent"}.` };
    }
    case "jouer_radio": {
      const recherche = texte(d.recherche, 60);
      if (!recherche) throw new Error("Indique la station ou le genre.");
      return { action: { type, donnees: { recherche } }, compte_rendu: `Recherche de la radio « ${recherche} » lancée : l'écran la joue si une station est trouvée. Ne dis pas qu'elle joue déjà, dis que tu la lances.` };
    }
    case "arreter_musique":
      return { action: { type, donnees: {} }, compte_rendu: "Radio arrêtée." };
    case "volume_musique": {
      const niveau = Math.round(nombreRequis(d.niveau, 0, 100, "le niveau"));
      return { action: { type, donnees: { niveau } }, compte_rendu: `Volume de la radio réglé à ${niveau} %.` };
    }
    case "actualiser_meteo":
      return { action: { type, donnees: {} }, compte_rendu: "Météo en cours d'actualisation." };
    case "afficher_actualites": {
      const rubrique = simplifier(d.rubrique).replace(/ /g, "-").slice(0, 20);
      etat.onglet = "actualites";
      return { action: { type, donnees: { rubrique } }, compte_rendu: `Actualités${rubrique ? ` (${rubrique})` : ""} affichées à l'écran.` };
    }
    case "changer_ville": {
      const ville = texte(d.ville, 80), pays = texte(d.pays, 60);
      if (!ville) throw new Error("Indique la ville.");
      return { action: { type, donnees: { ville, pays } }, compte_rendu: `Recherche de la météo de ${ville}${pays ? ", " + pays : ""} lancée : l'écran l'affichera si la ville est trouvée. Tu ne connais pas encore ces prévisions : ne les invente pas, propose de reposer la question dans un instant.` };
    }
  }
  throw new Error("Action non prise en charge.");
}

/* Texte de l'état joint à la question, pour le modèle. */
export function decrireEtat(etat) {
  return JSON.stringify(etat);
}
