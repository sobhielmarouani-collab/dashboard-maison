/*
 * Serveur de l'assistant vocal du dashboard.
 * Étape 1 : conversation libre. Étape 2 : connexion Google et accès réservé.
 *
 * Points d'entrée (tous refusés si l'appel ne vient pas d'une origine autorisée) :
 *   GET  /config       → { client_id }                 identifiant client Google, public
 *   POST /connexion    { jeton_google } → { session, email, expire }
 *   GET  /session      (Authorization: Bearer <session>) → { email, expire }
 *   POST /deconnexion  (Authorization: Bearer <session>) → { ok: true }
 *   POST /assistant    (Authorization: Bearer <session>) { phrase, historique } → { reponse, restant }
 *
 * Aucun secret dans ce fichier. Secrets Cloudflare attendus :
 *   ANTHROPIC_API_KEY, GOOGLE_CLIENT_ID, ADRESSES_AUTORISEES (adresses séparées par des virgules).
 */
import Anthropic from "@anthropic-ai/sdk";
import { verifierJetonGoogle } from "./google.js";
import { demanderAuModele, nettoyerHistorique, LONGUEUR_MAX_PHRASE } from "./modele.js";

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

function adresseAutorisee(env, email) {
  return liste(env.ADRESSES_AUTORISEES).map((a) => a.toLowerCase()).includes(email);
}

/* Renvoie { email, empreinte } si la session est valide et l'adresse toujours autorisée, sinon null. */
async function sessionValide(requete, env) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(requete.headers.get("Authorization") || "");
  if (!m) return null;
  const e = await empreinte(m[1]);
  const email = await coffre(env).lireSession(e);
  if (!email || !adresseAutorisee(env, email)) return null;
  return { email, empreinte: e };
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
  if (!adresseAutorisee(env, email)) {
    console.warn("Adresse non autorisée :", email);
    return json({ erreur: "Cette adresse n'est pas autorisée." }, 403, origine);
  }
  const jeton = nouveauJeton();
  const expire = Date.now() + entier(env.JOURS_SESSION, JOURS_SESSION_PAR_DEFAUT) * 24 * 60 * 60 * 1000;
  await coffre(env).creerSession(await empreinte(jeton), email, expire);
  return json({ session: jeton, email, expire }, 200, origine);
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
    const reponse = await demanderAuModele(env, phrase, nettoyerHistorique(corps.historique));
    return json({ reponse, restant: quota.restant }, 200, origine);
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

const ROUTES = {
  "/config": "GET",
  "/connexion": "POST",
  "/session": "GET",
  "/deconnexion": "POST",
  "/assistant": "POST",
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
    if (requete.method !== ROUTES[chemin]) {
      return json({ erreur: "Méthode non autorisée." }, 405, autorisee);
    }

    if (chemin === "/config") return json({ client_id: env.GOOGLE_CLIENT_ID || null }, 200, autorisee);
    if (chemin === "/connexion") return connexion(requete, env, autorisee);

    // tout ce qui suit exige une session valide pour une adresse autorisée
    const session = await sessionValide(requete, env);
    if (!session) return json({ erreur: "Connexion requise." }, 401, autorisee);

    if (chemin === "/session") return json({ email: session.email }, 200, autorisee);
    if (chemin === "/deconnexion") {
      await coffre(env).supprimerSession(session.empreinte);
      return json({ ok: true }, 200, autorisee);
    }
    return assistant(requete, env, autorisee, session);
  },
};
