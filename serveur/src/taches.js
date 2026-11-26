/*
 * Tâches partagées entre les postes.
 * Règles, appliquées ici côté serveur :
 *   - chacun voit les tâches qu'il a reçues et celles qu'il a données ; la direction voit tout ;
 *   - chacun peut se créer une tâche ; seule la direction peut en donner une à quelqu'un d'autre ;
 *   - une tâche est cochée par son destinataire (ou la direction) ; celui qui l'a donnée en est averti ;
 *   - modifier ou supprimer : celui qui l'a donnée, ou la direction ;
 *   - une tâche terminée est gardée (rayée à l'écran), elle n'est pas effacée.
 */
import { compteDe, listerComptes, PROFILS } from "./comptes.js";

const PRIORITES = ["normale", "haute", "urgente"];

export class TacheRefusee extends Error {
  constructor(message, statut = 400) {
    super(message);
    this.statut = statut;
  }
}

function nettoyerTexte(v) {
  const t = String(v ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!t) throw new TacheRefusee("Tâche vide.");
  return t;
}

function nettoyerPriorite(v) {
  const n = typeof v === "string" ? PRIORITES.indexOf(v) : Number(v);
  return n === 1 || n === 2 ? n : 0;
}

function nettoyerLimite(v) {
  const t = String(v ?? "");
  if (!t) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(Date.parse(t))) throw new TacheRefusee("Date limite invalide.");
  return t;
}

function presenter(t, noms) {
  return {
    id: t.id, texte: t.texte, auteur: t.auteur, pour: t.pour,
    auteur_nom: noms[t.auteur] || t.auteur.split("@")[0], pour_nom: noms[t.pour] || t.pour.split("@")[0],
    priorite: PRIORITES[t.priorite] || "normale", limite: t.limite || "", fait: !!t.fait, fait_le: t.fait || null, cree: t.cree,
  };
}

async function annuaire(env, coffre) {
  const comptes = (await listerComptes(env, coffre)).filter((c) => c.actif);
  return { comptes, noms: Object.fromEntries(comptes.map((c) => [c.email, c.nom || (c.proprietaire ? "Direction" : c.email.split("@")[0])])) };
}

/* Ce que la personne connectée a le droit de voir. */
export async function lireTaches(env, coffre, compte) {
  const direction = compte.profil === "direction";
  const { comptes, noms } = await annuaire(env, coffre);
  const lignes = await coffre.listerTaches(direction ? null : compte.email);
  return {
    taches: lignes.map((t) => presenter(t, noms)),
    avis: await coffre.lireAvis(compte.email),
    // la liste des personnes ne sert qu'à attribuer : elle n'est donnée qu'à la direction
    personnes: direction ? comptes.map((c) => ({ email: c.email, nom: noms[c.email], profil: c.profil, profil_nom: PROFILS[c.profil] })) : [],
    moi: compte.email,
  };
}

export async function agirTache(env, coffre, compte, corps) {
  const direction = compte.profil === "direction";
  const moi = compte.email;
  const action = String(corps?.action || "");
  const { noms } = await annuaire(env, coffre);
  const nomDe = (e) => noms[e] || e.split("@")[0];

  if (action === "lu") {
    await coffre.marquerAvisLus(moi);
    return;
  }

  if (action === "importer") {
    // reprise des tâches gardées jusque-là sur l'appareil : sans doublon avec ce qui existe déjà
    const liste = Array.isArray(corps?.taches) ? corps.taches.slice(0, 200) : [];
    const deja = new Set((await coffre.listerTaches(moi)).filter((t) => t.pour === moi).map((t) => t.texte.toLowerCase()));
    let n = 0;
    for (const x of liste) {
      let texte;
      try {
        texte = nettoyerTexte(x?.t ?? x?.texte);
      } catch {
        continue;
      }
      if (deja.has(texte.toLowerCase())) continue;
      deja.add(texte.toLowerCase());
      await coffre.creerTache(texte, moi, moi, 0, "", x?.f || x?.fait ? Date.now() : 0);
      n++;
    }
    if (n) await coffre.noter(moi, "Tâches reprises de l'appareil", `${n} tâche${n > 1 ? "s" : ""}`);
    return;
  }

  if (action === "creer") {
    const texte = nettoyerTexte(corps.texte);
    const pour = String(corps.pour || moi).trim().toLowerCase();
    if (pour !== moi) {
      if (!direction) throw new TacheRefusee("Seule la direction peut donner une tâche à une autre personne.", 403);
      if (!(await compteDe(env, coffre, pour))) throw new TacheRefusee("Destinataire inconnu ou désactivé.");
    }
    await coffre.creerTache(texte, moi, pour, nettoyerPriorite(corps.priorite), nettoyerLimite(corps.limite));
    if (pour !== moi) {
      await coffre.creerAvis(pour, `Nouvelle tâche de ${nomDe(moi)} : ${texte}`);
      await coffre.noter(moi, "Tâche donnée", `à ${pour} : ${texte}`);
    }
    return;
  }

  const id = Number(corps?.id);
  const t = Number.isInteger(id) && id > 0 ? await coffre.lireTache(id) : null;
  // une tâche que la personne n'a pas le droit de voir est traitée comme inexistante
  if (!t || (!direction && t.pour !== moi && t.auteur !== moi)) throw new TacheRefusee("Tâche introuvable.", 404);

  if (action === "cocher") {
    if (!direction && t.pour !== moi) throw new TacheRefusee("Cette tâche est à cocher par son destinataire.", 403);
    const fait = corps.fait !== false;
    if (!!t.fait === fait) return;
    await coffre.cocherTache(id, fait);
    if (t.auteur !== moi) await coffre.creerAvis(t.auteur, fait ? `${nomDe(moi)} a terminé : ${t.texte}` : `${nomDe(moi)} a rouvert : ${t.texte}`);
    if (t.pour !== t.auteur) await coffre.noter(moi, fait ? "Tâche terminée" : "Tâche rouverte", t.texte);
    return;
  }

  if (!direction && t.auteur !== moi) throw new TacheRefusee("Seule la personne qui a donné cette tâche peut la modifier.", 403);

  if (action === "modifier") {
    const texte = corps.texte === undefined ? t.texte : nettoyerTexte(corps.texte);
    const priorite = corps.priorite === undefined ? t.priorite : nettoyerPriorite(corps.priorite);
    const limite = corps.limite === undefined ? t.limite : nettoyerLimite(corps.limite);
    let pour = t.pour;
    if (corps.pour !== undefined && String(corps.pour).trim().toLowerCase() !== t.pour) {
      pour = String(corps.pour).trim().toLowerCase();
      if (pour !== moi && !direction) throw new TacheRefusee("Seule la direction peut donner une tâche à une autre personne.", 403);
      if (!(await compteDe(env, coffre, pour))) throw new TacheRefusee("Destinataire inconnu ou désactivé.");
      if (pour !== moi) await coffre.creerAvis(pour, `Nouvelle tâche de ${nomDe(moi)} : ${texte}`);
    } else if (t.pour !== moi && (texte !== t.texte || limite !== t.limite || priorite !== t.priorite)) {
      await coffre.creerAvis(t.pour, `Tâche modifiée par ${nomDe(moi)} : ${texte}`);
    }
    await coffre.modifierTache(id, texte, pour, priorite, limite);
    return;
  }

  if (action === "supprimer") {
    await coffre.supprimerTache(id);
    if (t.pour !== t.auteur) await coffre.noter(moi, "Tâche supprimée", `pour ${t.pour} : ${t.texte}`);
    return;
  }
  throw new TacheRefusee("Action inconnue.");
}
