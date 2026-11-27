/*
 * Listes partagées entre les postes : chantiers, alertes, affectations, livraisons, planning…
 * Chaque liste est un petit tableau gardé dans le Coffre. Pour chacune, le droit exigé est vérifié ici,
 * côté serveur, en lecture comme en écriture. Tout ce qui arrive est nettoyé champ par champ :
 * rien d'autre que les champs prévus n'est enregistré.
 */
const texte = (max = 80, requis = false) => ({ type: "texte", max, requis });
const choix = (...valeurs) => ({ type: "choix", valeurs });
const nombre = (min, max) => ({ type: "nombre", min, max });
const date = (requis = false) => ({ type: "date", requis });
const lien = () => ({ type: "lien" });

export const LISTES = {
  chantiers: { droit: "chantiers", champs: { nom: texte(60, true), lieu: texte(60), avancement: nombre(0, 100), statut: choix("en_cours", "preparation", "finition", "arret", "termine"), dossier: lien() } },
  // raccourcis vers les dossiers de l'entreprise : lisibles par tous les comptes (sauf les lignes réservées à la direction), modifiables par la direction seule
  dossiers: {
    droit: null,
    ecriture: "administration",
    champs: { nom: texte(40, true), detail: texte(60), lien: lien(), icone: choix("dossier", "bouclier", "document", "casque", "personnes", "plan", "boite"), acces: choix("tous", "direction") },
    visible: (compte, ligne) => compte.profil === "direction" || ligne.acces !== "direction",
  },
  alertes: { droit: "chantiers", champs: { chantier: texte(60, true), texte: texte(200, true), niveau: choix("bloquant", "attention") } },
  planning: { droit: "chantiers", champs: { chantier: texte(60, true), lot: texte(60, true), debut: date(true), fin: date(true) } },
  affectations: { droit: "affectations", champs: { equipe: texte(60, true), chantier: texte(60, true), effectif: nombre(0, 99) } },
  livraisons: { droit: "livraisons", champs: { date: date(true), fournisseur: texte(60), materiaux: texte(100, true), chantier: texte(60), statut: choix("prevue", "confirmee", "retard", "livree") } },
};
const LIGNES_MAX = 200;

export class PartageRefuse extends Error {
  constructor(message, statut = 400) {
    super(message);
    this.statut = statut;
  }
}

function nettoyerLigne(champs, brut, rang) {
  const ligne = { id: /^[a-z0-9]{6,16}$/.test(String(brut?.id || "")) ? String(brut.id) : crypto.randomUUID().replace(/-/g, "").slice(0, 12) };
  for (const [cle, c] of Object.entries(champs)) {
    const v = brut?.[cle];
    if (c.type === "texte") {
      const t = String(v ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, c.max);
      if (c.requis && !t) throw new PartageRefuse(`Ligne ${rang} : « ${cle} » est vide.`);
      ligne[cle] = t;
    } else if (c.type === "choix") {
      ligne[cle] = c.valeurs.includes(v) ? v : c.valeurs[0];
    } else if (c.type === "nombre") {
      const n = Math.round(Number(v));
      ligne[cle] = Number.isFinite(n) ? Math.min(c.max, Math.max(c.min, n)) : c.min;
    } else if (c.type === "lien") {
      // seul un lien https est gardé (dossier Google Drive, par exemple)
      const t = String(v ?? "").trim().slice(0, 300);
      ligne[cle] = /^https:\/\/[^\s<>"'`]+$/.test(t) ? t : "";
    } else if (c.type === "date") {
      const t = String(v ?? "");
      const ok = /^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(Date.parse(t));
      if (!ok && (c.requis || t)) throw new PartageRefuse(`Ligne ${rang} : date invalide.`);
      ligne[cle] = ok ? t : "";
    }
  }
  return ligne;
}

/* Listes demandées, limitées à celles que la personne a le droit de lire. */
export async function lirePartage(coffre, compte, cles) {
  const listes = {};
  const refuses = [];
  for (const cle of cles) {
    const def = LISTES[cle];
    if (!def) continue;
    if (def.droit && !compte.droits[def.droit]) {
      refuses.push(cle);
      continue;
    }
    const l = await coffre.lirePartage(cle);
    let lignes = [];
    try {
      lignes = l ? JSON.parse(l.valeur) : [];
    } catch {}
    lignes = Array.isArray(lignes) ? lignes : [];
    if (def.visible) lignes = lignes.filter((x) => def.visible(compte, x));
    listes[cle] = { lignes, modifie: l?.modifie || null };
  }
  return { listes, refuses };
}

/* Remplace une liste entière, après vérification du droit et nettoyage de chaque ligne. */
export async function ecrirePartage(coffre, compte, corps) {
  const cle = String(corps?.cle || "");
  const def = LISTES[cle];
  if (!def) throw new PartageRefuse("Liste inconnue.", 404);
  if (!compte.droits[def.ecriture || def.droit]) throw new PartageRefuse("Accès non autorisé pour ce profil.", 403);
  if (!Array.isArray(corps.lignes) || corps.lignes.length > LIGNES_MAX) throw new PartageRefuse("Liste invalide ou trop longue.");
  const lignes = corps.lignes.map((l, i) => nettoyerLigne(def.champs, l, i + 1));
  await coffre.ecrirePartage(cle, JSON.stringify(lignes), compte.email);
  return cle;
}
