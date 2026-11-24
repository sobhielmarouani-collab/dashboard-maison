/*
 * Vérification du jeton d'identité renvoyé par « Se connecter avec Google ».
 * Contrôles : signature (clés publiques de Google), émetteur, destinataire
 * (notre identifiant client), date d'expiration, adresse vérifiée par Google.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";

const CLES_GOOGLE = "https://www.googleapis.com/oauth2/v3/certs";
const EMETTEURS = ["https://accounts.google.com", "accounts.google.com"];

const jeuxDeCles = new Map(); // gardé en mémoire entre les requêtes (cache des clés)

function cles(url) {
  if (!jeuxDeCles.has(url)) jeuxDeCles.set(url, createRemoteJWKSet(new URL(url)));
  return jeuxDeCles.get(url);
}

/*
 * Pour les essais sur un ordinateur seulement : GOOGLE_CLES_TEST peut désigner
 * un serveur local (http://localhost…). Toute autre valeur est ignorée.
 */
function urlDesCles(env) {
  const test = String(env.GOOGLE_CLES_TEST || "");
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(test) ? test : CLES_GOOGLE;
}

/* Renvoie l'adresse mail (en minuscules) si le jeton est valide, sinon lève une erreur. */
export async function verifierJetonGoogle(jeton, env) {
  const { payload } = await jwtVerify(jeton, cles(urlDesCles(env)), {
    issuer: EMETTEURS,
    audience: env.GOOGLE_CLIENT_ID,
    algorithms: ["RS256"],
    clockTolerance: 30,
  });
  if (payload.email_verified !== true || typeof payload.email !== "string") {
    throw new Error("adresse non vérifiée par Google");
  }
  return payload.email.toLowerCase();
}
