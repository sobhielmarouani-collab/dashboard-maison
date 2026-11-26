/*
 * Serveur de l'assistant vocal du dashboard.
 * Étape 1 : conversation libre. Étape 2 : connexion Google et accès réservé.
 * Étape 3 : actions sur le dashboard (outil action_dashboard, exécuté par la page).
 * Étape 4 : agenda Google (outils lire_agenda et creer_evenement, onglet Agenda).
 *   Une création n'a lieu que par POST /agenda/confirmer, appelé par la page quand l'utilisateur confirme.
 *
 * Points d'entrée (tous refusés si l'appel ne vient pas d'une origine autorisée) :
 *   GET  /config       → { client_id }                 identifiant client Google, public
 *   POST /connexion    { jeton_google } → { session, email, expire }
 *   GET  /session      (Authorization: Bearer <session>) → { email, expire }
 *   POST /deconnexion  (Authorization: Bearer <session>) → { ok: true }
 *   POST /assistant    (Authorization: Bearer <session>) { phrase, historique, etat } → { reponse, actions, confirmation, restant }
 *   GET  /agenda/etat        (session) → { relie, ecriture }
 *   POST /agenda/relier      (session) { code } → { relie: true }    code d'autorisation Google
 *   POST /agenda/delier      (session) → { relie: false }
 *   GET  /agenda/evenements  (session) ?debut=AAAA-MM-JJ&fin=AAAA-MM-JJ → { evenements, ecriture }
 *   POST /agenda/confirmer   (session) { id } → { cree: true, resume, lien }   crée la proposition confirmée
 *   POST /agenda/annuler     (session) { id } → { annule: true }
 *   GET  /actualites         (session) ?rubrique=<id> → { rubriques, rubrique: { id, nom, articles, sources } }
 *   GET  /mails              (session) → { autorise, non_lus, messages: [{ id, fil, de, objet, t, non_lu, extrait }] } pour le panneau de l'accueil
 *   POST /voix               (session) { texte, vitesse } → { audio (MP3 en base64), mots: [{ m, t }], minutage } ou { configure: false }
 *   GET  /progbat            (session) ?annee=AAAA&forcer=1 → chiffres lus dans ProGBat (lecture seule) ou { configure: false }
 *   GET  /actualites/sources (session) → { rubriques, par_defaut }
 *   POST /actualites/sources (session) { rubriques } ou { reinitialiser: true } → { rubriques, tests }   teste chaque source puis enregistre
 *   GET  /comptes            (direction) → { comptes, profils, droits }
 *   POST /comptes            (direction) { email, nom, profil, actif, droits } → crée ou modifie un compte
 *   GET  /journal            (direction) → historique des actions importantes
 *
 * Profils : /connexion et /session renvoient { profil, droits }. Chaque point d'entrée sensible vérifie le droit
 * (voir DROIT_EXIGE) : progbat et actualités sont refusés (403) aux profils qui n'y ont pas droit.
 *
 * Aucun secret dans ce fichier. Secrets Cloudflare attendus :
 *   ANTHROPIC_API_KEY, GOOGLE_CLIENT_ID, ADRESSES_AUTORISEES (adresses séparées par des virgules),
 *   GOOGLE_CLIENT_SECRET (étape 4, agenda).
 */
import Anthropic from "@anthropic-ai/sdk";
import { verifierJetonGoogle } from "./google.js";
import { demanderAuModele, nettoyerHistorique, LONGUEUR_MAX_PHRASE } from "./modele.js";
import { lireRubriques, enregistrerRubriques, validerRubriques, trouverRubrique, lireRubrique, lireFlux, RUBRIQUES_PAR_DEFAUT } from "./actualites.js";
import { compteDe, validerCompte, listerComptes, PROFILS, DROITS } from "./comptes.js";
import { boiteReception } from "./gmail.js";
import { synthetiser, VoixNonConfiguree, LONGUEUR_MAX_VOIX } from "./voix.js";
import { resumeProgbat, ProgbatNonConfigure } from "./progbat.js";
import { relierAgenda, delierAgenda, etatAgenda, lireEvenements, creerEvenement, preparerEvenement, chevauchements, AgendaNonRelie, PERIMETRE_AGENDA, PERIMETRES_MAIL } from "./agenda.js";

export { Coffre } from "./coffre.js";

const TAILLE_MAX_CORPS = 64 * 1024; // octets
const JOURS_SESSION_PAR_DEFAUT = 30;
const LIMITE_PAR_HEURE_PAR_DEFAUT = 60;

/* ---------- utilitaires ---------- */

function liste(valeur) {
  return String(valeur || "")
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function entier(valeur, defaut) {
  const n = parseInt(valeur, 10);
  return Number.isFinite(n) && n > 0 ? n : defaut;
}

function entetesCors(origine) {
  return {
    "Access-Control-Allow-Origin": origine,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(corps, statut, origine, entetes = {}) {
  return new Response(JSON.stringify(corps), {
    status: statut,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(origine ? entetesCors(origine) : {}),
      ...entetes,
    },
  });
}

async function lireCorps(requete) {
  const texte = await requete.text();
  if (texte.length > TAILLE_MAX_CORPS) throw new Error("trop long");
  return JSON.parse(texte);
}

function nouveauJeton() {
  const octets = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...octets)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function empreinte(jeton) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(jeton));
  return [...new Uint8Array(h)].map((o) => o.toString(16).padStart(2, "0")).join("");
}

function coffre(env) {
  return env.COFFRE.get(env.COFFRE.idFromName("principal"));
}

/*
 * Droit exigé par chaque point d'entrée sensible. Vérifié ici, pour chaque appel :
 * masquer une fenêtre dans la page ne suffit pas, le serveur refuse lui-même.
 */
const DROIT_EXIGE = {
  "/progbat": "finances",
  "/actualites": "actualites",
  "/actualites/sources": "actualites",
  "/comptes": "administration",
  "/journal": "administration",
};

/* Renvoie { email, empreinte, compte } si la session est valide et le compte toujours actif, sinon null. */
async function sessionValide(requete, env) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(requete.headers.get("Authorization") || "");
  if (!m) return null;
  const e = await empreinte(m[1]);
  const email = await coffre(env).lireSession(e);
  const compte = email ? await compteDe(env, coffre(env), email) : null;
  if (!compte) return null;
  return { email, empreinte: e, compte };
}

/* ---------- points d'entrée ---------- */

async function connexion(requete, env, origine) {
  if (!env.GOOGLE_CLIENT_ID || !liste(env.ADRESSES_AUTORISEES).length) {
    return json({ erreur: "Connexion non configurée sur le serveur." }, 503, origine);
  }
  let corps;
  try {
    corps = await lireCorps(requete);
  } catch {
    return json({ erreur: "Corps JSON invalide." }, 400, origine);
  }
  if (typeof corps?.jeton_google !== "string" || !corps.jeton_google) {
    return json({ erreur: "Jeton Google manquant." }, 400, origine);
  }
  let email;
  try {
    email = await verifierJetonGoogle(corps.jeton_google, env);
  } catch (e) {
    console.warn("Jeton Google refusé :", e?.code || e?.message);
    return json({ erreur: "Connexion Google refusée." }, 401, origine);
  }
  const compte = await compteDe(env, coffre(env), email);
  if (!compte) {
    console.warn("Adresse non autorisée :", email);
    return json({ erreur: "Cette adresse n'est pas autorisée." }, 403, origine);
  }
  const jeton = nouveauJeton();
  const expire = Date.now() + entier(env.JOURS_SESSION, JOURS_SESSION_PAR_DEFAUT) * 24 * 60 * 60 * 1000;
  await coffre(env).creerSession(await empreinte(jeton), email, expire);
  return json({ session: jeton, email, expire, profil: compte.profil, nom: compte.nom, droits: compte.droits }, 200, origine);
}

async function assistant(requete, env, origine, session) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ erreur: "Clé d'API absente sur le serveur." }, 500, origine);
  }
  let corps;
  try {
    corps = await lireCorps(requete);
  } catch {
    return json({ erreur: "Corps JSON invalide." }, 400, origine);
  }
  const phrase = typeof corps?.phrase === "string" ? corps.phrase.trim() : "";
  if (!phrase) return json({ erreur: "Phrase vide." }, 400, origine);
  if (phrase.length > LONGUEUR_MAX_PHRASE) return json({ erreur: "Phrase trop longue." }, 413, origine);

  const limite = entier(env.LIMITE_PAR_HEURE, LIMITE_PAR_HEURE_PAR_DEFAUT);
  const quota = await coffre(env).compterDemande(session.email, limite);
  if (!quota.accepte) {
    const minutes = Math.max(1, Math.ceil(quota.reessayerDans / 60));
    return json(
      { erreur: `Limite de ${limite} demandes par heure atteinte. Réessayez dans ${minutes} minute${minutes > 1 ? "s" : ""}.` },
      429,
      origine,
      { "Retry-After": String(quota.reessayerDans) },
    );
  }

  try {
    const { reponse, actions, confirmation } = await demanderAuModele(env, phrase, nettoyerHistorique(corps.historique), corps.etat, {
      coffre: coffre(env),
      email: session.email,
      compte: session.compte,
    });
    return json({ reponse, actions, confirmation: confirmation || null, restant: quota.restant }, 200, origine);
  } catch (e) {
    // le détail reste dans les journaux Cloudflare, jamais renvoyé à la page
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      console.error("Clé d'API refusée :", e.status, e.message);
      return json({ erreur: "Clé d'API refusée." }, 502, origine);
    }
    if (e instanceof Anthropic.RateLimitError) {
      console.error("Limite de débit de l'API atteinte :", e.message);
      return json({ erreur: "Trop de demandes, réessayez dans un instant." }, 503, origine);
    }
    if (e instanceof Anthropic.APIConnectionError) {
      console.error("API injoignable :", e.message);
      return json({ erreur: "Service d'IA injoignable." }, 502, origine);
    }
    if (e instanceof Anthropic.APIError) {
      console.error("Erreur de l'API :", e.status, e.message);
      return json({ erreur: "Erreur du service d'IA." }, 502, origine);
    }
    console.error("Erreur inattendue :", e);
    return json({ erreur: "Erreur du serveur." }, 500, origine);
  }
}

/* ---------- agenda Google ---------- */

async function agenda(chemin, requete, env, origine, session) {
  const c = coffre(env);
  if (!env.GOOGLE_CLIENT_SECRET) {
    return json({ erreur: "Agenda Google non configuré sur le serveur (secret GOOGLE_CLIENT_SECRET absent)." }, 503, origine);
  }
  try {
    if (chemin === "/agenda/etat") {
      return json(await etatAgenda(c, session.email), 200, origine);
    }
    if (chemin === "/agenda/confirmer" || chemin === "/agenda/annuler") {
      let corps;
      try {
        corps = await lireCorps(requete);
      } catch {
        return json({ erreur: "Corps JSON invalide." }, 400, origine);
      }
      if (typeof corps?.id !== "string" || !/^[A-Za-z0-9_-]{10,40}$/.test(corps.id)) {
        return json({ erreur: "Proposition inconnue." }, 400, origine);
      }
      // usage unique : la proposition est effacée dès qu'elle est lue
      const donnees = await c.prendreProposition(corps.id, session.email);
      if (chemin === "/agenda/annuler") return json({ annule: true }, 200, origine);
      if (!donnees) return json({ erreur: "Proposition expirée ou déjà traitée : redemandez le rendez-vous." }, 410, origine);
      const p = JSON.parse(donnees);
      const cree = await creerEvenement(env, c, session.email, p);
      return json({ cree: true, resume: p.resume, lien: cree.lien || null }, 200, origine);
    }
    if (chemin === "/agenda/creer") {
      // création demandée directement dans le formulaire de la page Agenda : l'utilisateur a saisi et validé lui-même
      let corps, p;
      try {
        corps = await lireCorps(requete);
      } catch {
        return json({ erreur: "Corps JSON invalide." }, 400, origine);
      }
      try {
        p = preparerEvenement(corps);
      } catch (e) {
        return json({ erreur: String(e?.message || e).slice(0, 200) }, 400, origine);
      }
      const conflits = await chevauchements(env, c, session.email, p).catch(() => []);
      const cree = await creerEvenement(env, c, session.email, p);
      return json({ cree: true, resume: p.resume, conflits, lien: cree.lien || null }, 200, origine);
    }
    if (chemin === "/agenda/relier") {
      let corps;
      try {
        corps = await lireCorps(requete);
      } catch {
        return json({ erreur: "Corps JSON invalide." }, 400, origine);
      }
      if (typeof corps?.code !== "string" || !corps.code || corps.code.length > 2000) {
        return json({ erreur: "Code d'autorisation manquant." }, 400, origine);
      }
      await relierAgenda(env, c, session.email, corps.code);
      return json({ relie: true }, 200, origine);
    }
    if (chemin === "/agenda/delier") {
      await delierAgenda(env, c, session.email);
      return json({ relie: false }, 200, origine);
    }
    // /agenda/evenements
    const params = new URL(requete.url).searchParams;
    const evenements = await lireEvenements(env, c, session.email, params.get("debut"), params.get("fin"));
    const { ecriture, mail, brouillons } = await etatAgenda(c, session.email);
    return json({ evenements, ecriture, mail, brouillons }, 200, origine);
  } catch (e) {
    if (e instanceof AgendaNonRelie) return json({ erreur: e.message, relie: false }, 409, origine);
    console.warn("Agenda :", e?.message);
    return json({ erreur: e?.message || "Erreur de l'agenda." }, 502, origine);
  }
}

/* ---------- actualités ---------- */

async function actualites(chemin, requete, env, origine) {
  const c = coffre(env);
  if (chemin === "/actualites") {
    const rubriques = await lireRubriques(c);
    const demande = new URL(requete.url).searchParams.get("rubrique");
    const rubrique = trouverRubrique(rubriques, demande) || rubriques[0];
    return json({ rubriques: rubriques.map(({ id, nom, description }) => ({ id, nom, description })), rubrique: await lireRubrique(rubrique) }, 200, origine);
  }
  if (requete.method === "GET") {
    const brut = await c.lireReglage("actualites.rubriques");
    return json({ rubriques: await lireRubriques(c), par_defaut: !brut }, 200, origine);
  }
  // POST /actualites/sources : on vérifie le format, on teste chaque flux, puis on enregistre
  let corps;
  try {
    corps = await lireCorps(requete);
  } catch {
    return json({ erreur: "Corps JSON invalide." }, 400, origine);
  }
  let rubriques;
  try {
    rubriques = corps?.reinitialiser === true ? RUBRIQUES_PAR_DEFAUT : validerRubriques(corps?.rubriques);
  } catch (e) {
    return json({ erreur: e.message }, 400, origine);
  }
  const tests = await Promise.all(
    rubriques.flatMap((r) =>
      r.sources.map(async (s) => {
        const f = await lireFlux(s.url, { forcer: true });
        return { rubrique: r.nom, nom: s.nom, url: s.url, ok: !f.erreur, erreur: f.erreur, articles: f.articles.length };
      }),
    ),
  );
  await enregistrerRubriques(c, corps?.reinitialiser === true ? null : rubriques);
  return json({ rubriques, tests }, 200, origine);
}

/* ---------- comptes et droits (direction seulement) ---------- */

async function comptes(chemin, requete, env, origine, session) {
  const c = coffre(env);
  if (chemin === "/journal") return json({ journal: await c.lireJournal(200) }, 200, origine);
  if (requete.method === "GET") {
    return json({ comptes: await listerComptes(env, c), profils: PROFILS, droits: Object.fromEntries(Object.entries(DROITS).map(([k, d]) => [k, { nom: d.nom, reserve: !!d.reserve, par_defaut: d.par_defaut }])) }, 200, origine);
  }
  let corps, v;
  try {
    corps = await lireCorps(requete);
  } catch {
    return json({ erreur: "Corps JSON invalide." }, 400, origine);
  }
  try {
    v = validerCompte(env, corps);
  } catch (e) {
    return json({ erreur: e.message }, 400, origine);
  }
  const avant = await c.lireCompte(v.email);
  await c.ecrireCompte(v.email, v.nom, v.profil, v.actif, JSON.stringify(v.exceptions));
  const quoi = !avant ? "Compte créé" : avant.actif && !v.actif ? "Compte désactivé" : !avant.actif && v.actif ? "Compte réactivé" : "Compte modifié";
  const exceptions = Object.entries(v.exceptions).map(([k, b]) => `${b ? "+" : "−"}${k}`).join(" ");
  await c.noter(session.email, quoi, `${v.email} · ${PROFILS[v.profil]}${exceptions ? ` · ${exceptions}` : ""}`);
  return json({ ok: true, comptes: await listerComptes(env, c) }, 200, origine);
}

const ROUTES = {
  "/config": "GET",
  "/connexion": "POST",
  "/session": "GET",
  "/deconnexion": "POST",
  "/assistant": "POST",
  "/agenda/etat": "GET",
  "/agenda/relier": "POST",
  "/agenda/delier": "POST",
  "/agenda/evenements": "GET",
  "/agenda/creer": "POST",
  "/agenda/confirmer": "POST",
  "/agenda/annuler": "POST",
  "/actualites": "GET",
  "/progbat": "GET",
  "/mails": "GET",
  "/voix": "POST",
  "/actualites/sources": ["GET", "POST"],
  "/comptes": ["GET", "POST"],
  "/journal": "GET",
};

export default {
  async fetch(requete, env) {
    const chemin = new URL(requete.url).pathname;
    const origine = requete.headers.get("Origin");
    const autorisee = origine && liste(env.ORIGINES_AUTORISEES).includes(origine) ? origine : null;

    if (!ROUTES[chemin]) return json({ erreur: "Introuvable." }, 404, autorisee);
    if (!autorisee) return json({ erreur: "Origine non autorisée." }, 403, null);
    if (requete.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: entetesCors(autorisee) });
    }
    if (![].concat(ROUTES[chemin]).includes(requete.method)) {
      return json({ erreur: "Méthode non autorisée." }, 405, autorisee);
    }

    if (chemin === "/config") {
      return json(
        {
          client_id: env.GOOGLE_CLIENT_ID || null,
          agenda: env.GOOGLE_CLIENT_SECRET ? { perimetre: [PERIMETRE_AGENDA, ...PERIMETRES_MAIL].join(" ") } : null,
        },
        200,
        autorisee,
      );
    }
    if (chemin === "/connexion") return connexion(requete, env, autorisee);

    // tout ce qui suit exige une session valide pour une adresse autorisée
    const session = await sessionValide(requete, env);
    if (!session) return json({ erreur: "Connexion requise." }, 401, autorisee);

    const { compte } = session;
    if (chemin === "/session") return json({ email: session.email, profil: compte.profil, nom: compte.nom, droits: compte.droits }, 200, autorisee);
    const exige = DROIT_EXIGE[chemin];
    if (exige && !compte.droits[exige]) return json({ erreur: "Accès non autorisé pour ce profil.", refuse: exige }, 403, autorisee);
    if (chemin === "/comptes" || chemin === "/journal") return comptes(chemin, requete, env, autorisee, session);
    if (chemin === "/deconnexion") {
      await coffre(env).supprimerSession(session.empreinte);
      return json({ ok: true }, 200, autorisee);
    }
    if (chemin.startsWith("/agenda/")) return agenda(chemin, requete, env, autorisee, session);
    if (chemin.startsWith("/actualites")) return actualites(chemin, requete, env, autorisee);
    if (chemin === "/mails") {
      const c = coffre(env);
      try {
        const etat = await etatAgenda(c, session.email);
        if (!etat.mail) return json({ autorise: false }, 200, autorisee);
        return json({ autorise: true, ...(await boiteReception(env, c, session.email, 6)) }, 200, autorisee);
      } catch (e) {
        if (e instanceof AgendaNonRelie) return json({ autorise: false }, 200, autorisee);
        return json({ erreur: String(e?.message || e).slice(0, 300) }, 502, autorisee);
      }
    }
    if (chemin === "/voix") {
      let corps;
      try {
        corps = await lireCorps(requete);
      } catch {
        return json({ erreur: "Corps JSON invalide." }, 400, autorisee);
      }
      if (typeof corps?.texte !== "string" || !corps.texte.trim()) return json({ erreur: "Texte vide." }, 400, autorisee);
      if (corps.texte.length > LONGUEUR_MAX_VOIX * 2) return json({ erreur: "Texte trop long." }, 413, autorisee);
      try {
        return json({ configure: true, ...(await synthetiser(env, corps)) }, 200, autorisee);
      } catch (e) {
        if (e instanceof VoixNonConfiguree) return json({ configure: false, erreur: e.message }, 200, autorisee);
        return json({ erreur: String(e?.message || e).slice(0, 400) }, 502, autorisee);
      }
    }
    if (chemin === "/progbat") {
      const q = new URL(requete.url).searchParams;
      try {
        return json({ configure: true, ...(await resumeProgbat(env, { annee: q.get("annee"), forcer: q.get("forcer") === "1" })) }, 200, autorisee);
      } catch (e) {
        if (e instanceof ProgbatNonConfigure) return json({ configure: false, erreur: e.message }, 200, autorisee);
        return json({ erreur: String(e?.message || e).slice(0, 300) }, 502, autorisee);
      }
    }
    return assistant(requete, env, autorisee, session);
  },
};
