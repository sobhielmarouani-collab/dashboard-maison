/*
 * Étape 4 : agenda Google, en lecture seule.
 *
 * Relier : la page obtient de Google un « code d'autorisation » (fenêtre Google,
 * périmètre calendar.readonly) et l'envoie ici. Le serveur l'échange contre un jeton de
 * rafraîchissement, vérifie qu'il appartient bien au compte connecté, le chiffre
 * (AES-GCM) et le garde dans le Coffre. Les jetons d'accès (valables une heure) sont
 * redemandés à Google au besoin et gardés seulement en mémoire.
 *
 * Secrets Cloudflare utilisés : GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET.
 */

export const PERIMETRE_AGENDA = "https://www.googleapis.com/auth/calendar.readonly";
const URL_JETON = "https://oauth2.googleapis.com/token";
const URL_REVOCATION = "https://oauth2.googleapis.com/revoke";
const URL_EVENEMENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const FUSEAU = "Europe/Paris";
export const JOURS_MAX = 31;

export class AgendaNonRelie extends Error {
  constructor(message = "L'agenda Google n'est pas relié.") {
    super(message);
    this.name = "AgendaNonRelie";
  }
}

/* ---------- chiffrement du jeton de rafraîchissement ---------- */

const enc = new TextEncoder();
const dec = new TextDecoder();

async function cleDeChiffrement(env) {
  const base = await crypto.subtle.importKey("raw", enc.encode(env.GOOGLE_CLIENT_SECRET), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("dashboard-agenda"), info: enc.encode("jeton-de-rafraichissement") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function enBase64(octets) {
  return btoa(String.fromCharCode(...octets));
}
function deBase64(texte) {
  return Uint8Array.from(atob(texte), (c) => c.charCodeAt(0));
}

async function chiffrer(env, texte, email) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const donnees = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(email) },
    await cleDeChiffrement(env),
    enc.encode(texte),
  );
  return `${enBase64(iv)}.${enBase64(new Uint8Array(donnees))}`;
}

async function dechiffrer(env, chiffre, email) {
  const [iv, donnees] = chiffre.split(".");
  const clair = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: deBase64(iv), additionalData: enc.encode(email) },
    await cleDeChiffrement(env),
    deBase64(donnees),
  );
  return dec.decode(clair);
}

/* ---------- échanges avec Google ---------- */

async function appelJeton(parametres) {
  const r = await fetch(URL_JETON, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parametres),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, statut: r.status, j };
}

/* Le jeton d'identité vient directement de Google (réponse HTTPS au serveur) : on en lit le contenu. */
function emailDuJetonIdentite(jeton) {
  try {
    const charge = jeton.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const p = JSON.parse(dec.decode(deBase64(charge + "===".slice((charge.length + 3) % 4))));
    return p.email_verified === true && typeof p.email === "string" ? p.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

const jetonsAcces = new Map(); // email → { jeton, expire } (mémoire de l'instance seulement)

/* Échange le code d'autorisation, vérifie le compte et le périmètre, garde le jeton chiffré. */
export async function relierAgenda(env, coffre, emailSession, code) {
  const { ok, j } = await appelJeton({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: "postmessage", // fenêtre surgissante de Google (pas de page de retour)
    grant_type: "authorization_code",
  });
  if (!ok) {
    console.warn("Échange du code Google refusé :", j.error, j.error_description);
    throw new Error("Google a refusé l'autorisation. Réessayez.");
  }
  const email = emailDuJetonIdentite(j.id_token || "");
  if (email !== emailSession) {
    throw new Error(`Choisissez le compte Google ${emailSession}, celui de votre connexion au dashboard.`);
  }
  if (!String(j.scope || "").split(" ").includes(PERIMETRE_AGENDA)) {
    throw new Error("L'accès à l'agenda n'a pas été coché dans la fenêtre Google. Recommencez en le cochant.");
  }
  if (!j.refresh_token) {
    throw new Error("Google n'a pas fourni d'accès durable. Réessayez.");
  }
  await coffre.enregistrerAgenda(email, await chiffrer(env, j.refresh_token, email));
  jetonsAcces.set(email, { jeton: j.access_token, expire: Date.now() + (j.expires_in - 60) * 1000 });
}

export async function agendaRelie(coffre, email) {
  return Boolean(await coffre.lireAgenda(email));
}

async function jetonAcces(env, coffre, email) {
  const enCache = jetonsAcces.get(email);
  if (enCache && enCache.expire > Date.now()) return enCache.jeton;

  const chiffre = await coffre.lireAgenda(email);
  if (!chiffre) throw new AgendaNonRelie();
  let rafraichissement;
  try {
    rafraichissement = await dechiffrer(env, chiffre, email);
  } catch {
    // secret client changé depuis : le jeton gardé est illisible, il faut relier de nouveau
    await coffre.supprimerAgenda(email);
    throw new AgendaNonRelie("L'agenda Google doit être relié de nouveau (secret client modifié).");
  }
  const { ok, j } = await appelJeton({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: rafraichissement,
    grant_type: "refresh_token",
  });
  if (!ok) {
    if (j.error === "invalid_grant") {
      // accès retiré depuis le compte Google, ou jeton expiré
      await coffre.supprimerAgenda(email);
      throw new AgendaNonRelie("L'accès à l'agenda Google a été retiré : reliez-le de nouveau dans Réglages.");
    }
    throw new Error(`Google ne répond pas (${j.error || "erreur"}).`);
  }
  jetonsAcces.set(email, { jeton: j.access_token, expire: Date.now() + (j.expires_in - 60) * 1000 });
  return j.access_token;
}

export async function delierAgenda(env, coffre, email) {
  const chiffre = await coffre.lireAgenda(email);
  jetonsAcces.delete(email);
  await coffre.supprimerAgenda(email);
  if (!chiffre) return;
  try {
    const jeton = await dechiffrer(env, chiffre, email);
    await fetch(URL_REVOCATION, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: jeton }),
    });
  } catch (e) {
    console.warn("Révocation Google impossible :", e?.message);
  }
}

/* ---------- dates à l'heure de Paris ---------- */

/* Décalage de Paris par rapport à UTC, en minutes, à l'instant donné. */
function decalageParis(date) {
  const nom = new Intl.DateTimeFormat("en-US", { timeZone: FUSEAU, timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName").value; // « GMT+01:00 »
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(nom);
  return m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0;
}

/* Minuit à Paris du jour « AAAA-MM-JJ », en RFC 3339 avec décalage. */
function minuitParis(jour) {
  const approx = new Date(`${jour}T12:00:00Z`);
  const d = decalageParis(approx);
  const signe = d < 0 ? "-" : "+";
  const abs = Math.abs(d);
  return `${jour}T00:00:00${signe}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export function aujourdhuiParis() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FUSEAU }).format(new Date()); // AAAA-MM-JJ
}

function ajouterJours(jour, n) {
  const d = new Date(`${jour}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* Vérifie un intervalle de jours (fin incluse) et le borne à JOURS_MAX jours. */
export function intervalle(debut, fin) {
  const motif = /^\d{4}-\d{2}-\d{2}$/;
  if (!motif.test(debut || "") || isNaN(Date.parse(debut))) throw new Error("Date de début attendue au format AAAA-MM-JJ.");
  const f = fin || debut;
  if (!motif.test(f) || isNaN(Date.parse(f))) throw new Error("Date de fin attendue au format AAAA-MM-JJ.");
  if (f < debut) throw new Error("La date de fin précède la date de début.");
  const jours = Math.round((Date.parse(f) - Date.parse(debut)) / 86_400_000) + 1;
  if (jours > JOURS_MAX) throw new Error(`Période trop longue : ${JOURS_MAX} jours au plus.`);
  return { debut, fin: f };
}

/* ---------- lecture des événements ---------- */

function heureParis(iso) {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: FUSEAU, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
function jourParis(iso) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FUSEAU }).format(new Date(iso));
}

/*
 * Événements de l'agenda principal entre deux jours (fin incluse), triés.
 * Chaque événement : { jour, debut, fin, journee, titre, lieu }.
 * Les événements sur plusieurs jours apparaissent une fois, à leur premier jour visible.
 */
export async function lireEvenements(env, coffre, email, debut, fin) {
  const p = intervalle(debut, fin);
  const jeton = await jetonAcces(env, coffre, email);
  const url = new URL(URL_EVENEMENTS);
  url.search = new URLSearchParams({
    timeMin: minuitParis(p.debut),
    timeMax: minuitParis(ajouterJours(p.fin, 1)),
    singleEvents: "true",
    orderBy: "startTime",
    timeZone: FUSEAU,
    maxResults: "250",
    fields: "items(status,summary,location,start,end,transparency,eventType)",
  }).toString();
  const r = await fetch(url, { headers: { Authorization: `Bearer ${jeton}` } });
  if (r.status === 401) {
    jetonsAcces.delete(email);
    throw new Error("Jeton Google refusé, réessayez.");
  }
  if (r.status === 403) {
    const j = await r.json().catch(() => ({}));
    console.warn("Agenda Google refusé :", JSON.stringify(j).slice(0, 300));
    throw new Error("Google refuse l'accès à l'agenda : vérifiez que l'API Google Calendar est activée dans le projet.");
  }
  if (!r.ok) throw new Error(`Agenda Google indisponible (${r.status}).`);
  const j = await r.json();
  return (j.items || [])
    .filter((e) => e.status !== "cancelled" && e.eventType !== "workingLocation")
    .map((e) => {
      const journee = Boolean(e.start?.date);
      const jour = journee ? e.start.date : jourParis(e.start.dateTime);
      return {
        jour: jour < p.debut ? p.debut : jour,
        debut: journee ? null : heureParis(e.start.dateTime),
        fin: journee ? null : heureParis(e.end.dateTime),
        journee,
        titre: String(e.summary || "(sans titre)").slice(0, 200),
        lieu: String(e.location || "").slice(0, 200),
      };
    });
}
