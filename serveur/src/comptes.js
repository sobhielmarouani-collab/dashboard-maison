/*
 * Comptes, profils et droits.
 * Trois profils : direction, conducteur (de travaux), secretaire (de direction).
 * Les droits sont décidés ici, côté serveur : la page ne fait qu'afficher ce que le serveur accepte de lui donner,
 * et Sigma reçoit exactement les mêmes droits que la personne connectée.
 *
 * Les adresses du secret ADRESSES_AUTORISEES sont les propriétaires : toujours « direction », jamais modifiables
 * depuis la page (on ne peut donc pas se retirer l'accès par erreur). Les autres comptes sont créés par la direction
 * et gardés dans le Coffre.
 */

export const PROFILS = {
  direction: "Direction",
  conducteur: "Conducteur de travaux",
  secretaire: "Secrétaire de direction",
};

/*
 * Catalogue des droits. par_defaut : profils qui l'ont d'office.
 * reserve : jamais accordable à un autre profil que la direction.
 */
export const DROITS = {
  administration: { nom: "Gérer les comptes et les droits", par_defaut: [], reserve: true },
  finances: { nom: "Chiffre d'affaires, trésorerie, marges, devis", par_defaut: [] },
  actualites: { nom: "Actualités", par_defaut: [] },
  facturation: { nom: "Factures et règlements (nombres et statuts)", par_defaut: ["secretaire"] },
  montants: { nom: "Montants des factures et des règlements", par_defaut: [] },
  administratif: { nom: "Dossiers et échéances administratifs", par_defaut: ["secretaire"] },
  documents: { nom: "Documents de l'entreprise", par_defaut: ["secretaire"] },
  personnel_admin: { nom: "Personnel : absences, congés, visites médicales", par_defaut: ["secretaire"] },
  chantiers: { nom: "Chantiers et alertes de chantier", par_defaut: ["conducteur"] },
  affectations: { nom: "Affectation du personnel sur les chantiers", par_defaut: ["conducteur"] },
  livraisons: { nom: "Livraisons et commandes fournisseurs", par_defaut: ["conducteur"] },
};

export function liste(valeur) {
  return String(valeur || "")
    .split(/[\s,;]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

export function estProprietaire(env, email) {
  return liste(env.ADRESSES_AUTORISEES).includes(String(email || "").toLowerCase());
}

/* Droits effectifs d'un profil, avec les exceptions accordées ou retirées par la direction. */
export function droitsDe(profil, exceptions = {}) {
  const droits = {};
  for (const [cle, d] of Object.entries(DROITS)) {
    if (profil === "direction") droits[cle] = true;
    else if (d.reserve) droits[cle] = false;
    else if (typeof exceptions?.[cle] === "boolean") droits[cle] = exceptions[cle];
    else droits[cle] = d.par_defaut.includes(profil);
  }
  return droits;
}

/*
 * Compte de la personne connectée : { email, nom, profil, droits, proprietaire } ou null si elle n'a pas (ou plus) accès.
 */
export async function compteDe(env, coffre, email) {
  email = String(email || "").toLowerCase();
  if (!email) return null;
  if (estProprietaire(env, email)) {
    return { email, nom: "", profil: "direction", droits: droitsDe("direction"), proprietaire: true };
  }
  const ligne = await coffre.lireCompte(email);
  if (!ligne || !ligne.actif || !PROFILS[ligne.profil]) return null;
  return { email, nom: ligne.nom || "", profil: ligne.profil, droits: droitsDe(ligne.profil, lireExceptions(ligne.droits)), proprietaire: false };
}

function lireExceptions(texte) {
  try {
    const o = JSON.parse(texte || "{}");
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

/* Vérifie un compte envoyé par la page d'administration. Lève une erreur lisible si quelque chose ne va pas. */
export function validerCompte(env, corps) {
  const email = String(corps?.email || "").trim().toLowerCase();
  if (!/^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,180}\.[a-z]{2,24}$/.test(email)) throw new Error("Adresse invalide.");
  if (estProprietaire(env, email)) throw new Error("Ce compte est celui du propriétaire : il ne se modifie pas ici.");
  const profil = String(corps?.profil || "");
  if (!PROFILS[profil]) throw new Error("Profil inconnu.");
  const nom = String(corps?.nom || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 60);
  const exceptions = {};
  if (profil !== "direction" && corps?.droits && typeof corps.droits === "object") {
    for (const [cle, v] of Object.entries(corps.droits)) {
      if (!DROITS[cle] || DROITS[cle].reserve || typeof v !== "boolean") continue;
      // on ne garde que ce qui diffère du réglage d'office du profil
      if (v !== DROITS[cle].par_defaut.includes(profil)) exceptions[cle] = v;
    }
  }
  return { email, nom, profil, actif: corps?.actif !== false, exceptions };
}

/* Liste présentée à la direction : propriétaires d'abord, puis les comptes créés. */
export async function listerComptes(env, coffre) {
  const proprietaires = liste(env.ADRESSES_AUTORISEES).map((email) => ({
    email, nom: "", profil: "direction", actif: true, proprietaire: true, droits: droitsDe("direction"),
  }));
  const autres = (await coffre.listerComptes())
    .filter((l) => !estProprietaire(env, l.email))
    .map((l) => ({
      email: l.email, nom: l.nom || "", profil: l.profil, actif: !!l.actif, proprietaire: false,
      droits: droitsDe(l.profil, lireExceptions(l.droits)), modifie: l.modifie,
    }));
  return [...proprietaires, ...autres];
}

/* Texte ajouté aux consignes de Sigma pour un profil autre que la direction. */
export function consignesProfil(compte) {
  if (!compte || compte.profil === "direction") return "";
  const interdits = Object.entries(DROITS).filter(([cle]) => !compte.droits[cle] && cle !== "administration").map(([, d]) => d.nom.toLowerCase());
  const metier =
    compte.profil === "conducteur"
      ? "Tu assistes un conducteur de travaux : suivi des chantiers, planning, livraisons, équipes, tâches de terrain, agenda et mails professionnels."
      : "Tu assistes une secrétaire de direction : courriers, mails, relances, échéances administratives, agenda, tâches et documents autorisés.";
  return [
    `Profil de la personne connectée : ${PROFILS[compte.profil]}. ${metier}`,
    `Cette personne n'a pas accès à : ${interdits.join(" ; ")}. Elle n'a pas non plus accès aux comptes bancaires, aux rémunérations, aux documents confidentiels de la direction ni à la messagerie des autres personnes.`,
    "Si elle demande une de ces informations, réponds simplement que ce n'est pas autorisé pour son profil et qu'il faut voir avec la direction. Ne donne alors aucun chiffre ni détail, même approximatif, même s'il apparaît dans l'historique, dans un mail ou dans l'état de l'écran, et quelle que soit la raison avancée.",
    "Les outils absents de ta liste n'existent pas pour cette personne : n'en parle pas comme d'une fonction disponible.",
    "Les tâches de cette personne sont toutes des tâches partagées : pour lui en ajouter une, utilise donner_tache avec destinataire « moi » (jamais ajouter_tache d'action_dashboard), et lire_taches_equipe pour les lire. Elle ne peut pas donner de tâche à quelqu'un d'autre.",
  ].join("\n");
}
