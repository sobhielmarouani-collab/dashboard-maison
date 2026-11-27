/*
 * Boîte à idées : chaque personne connectée peut proposer une amélioration du tableau de bord.
 * Chacun voit ses propres idées ; la direction (droit « administration ») les voit toutes,
 * leur donne une suite (retenue, faite, écartée) et peut les supprimer.
 */
const ETATS = ["nouvelle", "retenue", "faite", "ecartee"];
const TEXTE_MAX = 500;
const EN_ATTENTE_MAX = 30; // idées encore « nouvelles » par personne

export class IdeeRefusee extends Error {
  constructor(message, statut = 400) {
    super(message);
    this.statut = statut;
  }
}

export async function listerIdees(coffre, compte) {
  const gestion = !!compte.droits.administration;
  const lignes = await coffre.listerIdees(gestion ? null : compte.email);
  return {
    gestion,
    nouvelles: gestion ? lignes.filter((l) => l.etat === "nouvelle").length : 0,
    idees: lignes.map((l) => ({ id: l.id, texte: l.texte, de: l.auteur_nom || l.auteur, quand: l.quand, etat: ETATS.includes(l.etat) ? l.etat : "nouvelle", mienne: l.auteur === compte.email })),
  };
}

export async function agirIdee(coffre, compte, corps) {
  const gestion = !!compte.droits.administration;
  const action = String(corps?.action || "");
  if (action === "creer") {
    const texte = String(corps.texte ?? "").replace(/[\u0000-\u0008\u000b-\u001f<>]/g, " ").replace(/[ \t]+/g, " ").trim().slice(0, TEXTE_MAX);
    if (texte.length < 3) throw new IdeeRefusee("Écrivez votre idée en quelques mots.");
    const miennes = await coffre.listerIdees(compte.email);
    if (miennes.filter((l) => l.etat === "nouvelle").length >= EN_ATTENTE_MAX) throw new IdeeRefusee("Vous avez déjà beaucoup d'idées en attente de réponse.");
    await coffre.creerIdee(compte.email, compte.nom || "", texte);
    return;
  }
  const id = Number(corps?.id);
  const idee = Number.isInteger(id) ? await coffre.lireIdee(id) : null;
  if (!idee) throw new IdeeRefusee("Idée introuvable.", 404);
  if (action === "etat") {
    if (!gestion) throw new IdeeRefusee("Accès non autorisé pour ce profil.", 403);
    if (!ETATS.includes(corps.etat)) throw new IdeeRefusee("État inconnu.");
    await coffre.etatIdee(id, corps.etat);
    return;
  }
  if (action === "supprimer") {
    // chacun peut retirer sa propre idée tant qu'elle n'a pas reçu de suite ; la direction peut tout retirer
    if (!gestion && !(idee.auteur === compte.email && idee.etat === "nouvelle")) throw new IdeeRefusee("Accès non autorisé pour ce profil.", 403);
    await coffre.supprimerIdee(id);
    return;
  }
  throw new IdeeRefusee("Action inconnue.");
}
