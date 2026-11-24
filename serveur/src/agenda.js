/*
 * Étape 4 : agenda Google — lecture, et création de rendez-vous après confirmation.
 *
 * Relier : la page obtient de Google un « code d'autorisation » (fenêtre Google,
 * périmètre calendar.readonly) et l'envoie ici. Le serveur l'échange contre un jeton de
 * rafraîchissement, vérifie qu'il appartient bien au compte connecté, le chiffre
 * (AES-GCM) et le garde dans le Coffre. Les jetons d'accès (valables une heure) sont
 * redemandés à Google au besoin et gardés seulement en mémoire.
 *
 * Création : le modèle ne crée rien. Il prépare une proposition (preparerEvenement), que
 * l'utilisateur confirme à l'écran ; seule cette confirmation appelle creerEvenement.
 *
 * Secrets Cloudflare utilisés : GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET.
 */

/* Lire et créer des événements (remplace calendar.readonly, demandé par les premières liaisons). */
export const PERIMETRE_AGENDA = "https://www.googleapis.com/auth/calendar.events";
const PERIMETRES_LECTURE = [PERIMETRE_AGENDA, "https://www.googleapis.com/auth/calendar.readonly"];
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
  const accordes = String(j.scope || "").split(" ");
  if (!accordes.includes(PERIMETRE_AGENDA)) {
    throw new Error("L'accès à l'agenda n'a pas été coché dans la fenêtre Google. Recommencez en le cochant.");
  }
  if (!j.refresh_token) {
    throw new Error("Google n'a pas fourni d'accès durable. Réessayez.");
  }
  await coffre.enregistrerAgenda(email, await chiffrer(env, j.refresh_token, email), accordes.filter((p) => PERIMETRES_LECTURE.includes(p)).join(" "));
  jetonsAcces.set(email, { jeton: j.access_token, expire: Date.now() + (j.expires_in - 60) * 1000 });
}

export async function agendaRelie(coffre, email) {
  return Boolean(await coffre.lireAgenda(email));
}

/* { relie, ecriture } : ecriture faux pour une liaison faite en lecture seule (à refaire). */
export async function etatAgenda(coffre, email) {
  const portee = await coffre.porteeAgenda(email);
  if (portee === null) return { relie: false, ecriture: false };
  return { relie: true, ecriture: portee.split(" ").includes(PERIMETRE_AGENDA) };
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

/* ---------- création d'un rendez-vous ---------- */

const URL_CREATION = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/* Instant (Date) correspondant à « AAAA-MM-JJ HH:MM » à l'heure de Paris. */
function instantParis(jour, heure) {
  const approx = new Date(`${jour}T${heure}:00Z`);
  return new Date(approx.getTime() - decalageParis(approx) * 60_000);
}

function lireDateHeure(valeur, nom) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2})[:h](\d{2}))?$/.exec(String(valeur || "").trim());
  if (!m || isNaN(Date.parse(m[1]))) throw new Error(`${nom} : format attendu AAAA-MM-JJTHH:MM, ou AAAA-MM-JJ pour une journée entière.`);
  if (m[2] === undefined) return { jour: m[1], heure: null };
  if (+m[2] > 23 || +m[3] > 59) throw new Error(`${nom} : heure invalide.`);
  return { jour: m[1], heure: `${m[2].padStart(2, "0")}:${m[3]}` };
}

function texteBorne(v, max) {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

const fJourLong = new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" });
function jourLisible(jour) {
  return fJourLong.format(new Date(`${jour}T12:00:00Z`));
}

/*
 * Vérifie et met en forme une demande de création (venue du modèle).
 * Renvoie { titre, journee, jour, debut, jourFin, fin, lieu, description, resume } ou lève une erreur lisible.
 * Heures à Paris ; fin par défaut : une heure après le début (ou le même jour pour une journée entière).
 */
export function preparerEvenement(entree) {
  const titre = texteBorne(entree?.titre, 200);
  if (!titre) throw new Error("Titre du rendez-vous manquant.");
  const d = lireDateHeure(entree?.debut, "debut");
  const journee = d.heure === null;
  let f;
  if (entree?.fin) {
    f = lireDateHeure(entree.fin, "fin");
    if ((f.heure === null) !== journee) throw new Error("debut et fin doivent être tous deux des dates (journée entière) ou tous deux des dates avec heure.");
  } else if (journee) {
    f = { jour: d.jour, heure: null };
  } else {
    const fin = new Date(instantParis(d.jour, d.heure).getTime() + 3_600_000);
    f = {
      jour: new Intl.DateTimeFormat("en-CA", { timeZone: FUSEAU }).format(fin),
      heure: new Intl.DateTimeFormat("fr-FR", { timeZone: FUSEAU, hour: "2-digit", minute: "2-digit" }).format(fin),
    };
  }
  const debutT = journee ? Date.parse(d.jour) : instantParis(d.jour, d.heure).getTime();
  const finT = journee ? Date.parse(f.jour) : instantParis(f.jour, f.heure).getTime();
  if (journee ? finT < debutT : finT <= debutT) throw new Error("La fin doit être après le début.");
  if (finT - debutT > 14 * 86_400_000) throw new Error("Durée trop longue : 14 jours au plus.");
  const maintenant = Date.now();
  const limitePassee = journee ? Date.parse(aujourdhuiParis()) : maintenant - 5 * 60_000;
  if (debutT < limitePassee) throw new Error("Cette date est déjà passée. Vérifie le jour avec l'utilisateur.");
  if (debutT > maintenant + 2 * 365 * 86_400_000) throw new Error("Date trop lointaine : deux ans au plus.");

  const lieu = texteBorne(entree?.lieu, 200);
  const description = texteBorne(entree?.description, 1000);
  const quand = journee
    ? d.jour === f.jour
      ? `${jourLisible(d.jour)}, toute la journée`
      : `du ${jourLisible(d.jour)} au ${jourLisible(f.jour)}, journées entières`
    : d.jour === f.jour
      ? `${jourLisible(d.jour)}, de ${d.heure} à ${f.heure}`
      : `du ${jourLisible(d.jour)} à ${d.heure} au ${jourLisible(f.jour)} à ${f.heure}`;
  return { titre, journee, jour: d.jour, debut: d.heure, jourFin: f.jour, fin: f.heure, lieu, description, resume: `« ${titre} », ${quand}${lieu ? `, à ${lieu}` : ""}` };
}

/* Événements déjà présents qui chevauchent la proposition (pour prévenir l'utilisateur). */
export async function chevauchements(env, coffre, email, p) {
  const evenements = await lireEvenements(env, coffre, email, p.jour, p.jourFin);
  if (p.journee) return evenements.filter((e) => !e.journee).map((e) => `${e.titre} (${e.jour === p.jour ? "" : e.jour + " "}${e.debut}–${e.fin})`).slice(0, 5);
  return evenements
    .filter((e) => !e.journee && e.jour === p.jour && e.debut < (p.jourFin === p.jour ? p.fin : "24:00") && e.fin > p.debut)
    .map((e) => `${e.titre} (${e.debut}–${e.fin})`)
    .slice(0, 5);
}

/* Crée l'événement confirmé dans l'agenda principal. */
export async function creerEvenement(env, coffre, email, p) {
  const { ecriture } = await etatAgenda(coffre, email);
  if (!ecriture) throw new AgendaNonRelie("L'agenda est relié en lecture seule : reliez-le de nouveau dans Réglages pour autoriser la création.");
  const jeton = await jetonAcces(env, coffre, email);
  const lendemain = (jour) => {
    const x = new Date(`${jour}T12:00:00Z`);
    x.setUTCDate(x.getUTCDate() + 1);
    return x.toISOString().slice(0, 10);
  };
  const corps = {
    summary: p.titre,
    location: p.lieu || undefined,
    description: p.description || undefined,
    start: p.journee ? { date: p.jour } : { dateTime: `${p.jour}T${p.debut}:00`, timeZone: FUSEAU },
    end: p.journee ? { date: lendemain(p.jourFin) } : { dateTime: `${p.jourFin}T${p.fin}:00`, timeZone: FUSEAU },
    extendedProperties: { private: { source: "assistant-dashboard" } },
  };
  const r = await fetch(`${URL_CREATION}?fields=id,htmlLink`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jeton}`, "Content-Type": "application/json" },
    body: JSON.stringify(corps),
  });
  if (r.status === 401) {
    jetonsAcces.delete(email);
    throw new Error("Jeton Google refusé, réessayez.");
  }
  if (r.status === 403) {
    const j = await r.json().catch(() => ({}));
    console.warn("Création refusée par Google :", JSON.stringify(j).slice(0, 300));
    throw new Error("Google refuse la création : reliez l'agenda de nouveau dans Réglages (accès en écriture).");
  }
  if (!r.ok) throw new Error(`Création impossible (${r.status}).`);
  const j = await r.json();
  return { id: j.id, lien: j.htmlLink };
}
