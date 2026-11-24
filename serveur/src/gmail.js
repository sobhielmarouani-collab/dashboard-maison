/*
 * Gmail : lecture des messages et préparation de brouillons, avec la même liaison Google
 * que l'agenda (jeton chiffré dans le coffre).
 *
 * Ce module ne sait pas envoyer : il lit (messages.list, messages.get) et crée des brouillons
 * (drafts.create). Un brouillon ne part que si l'utilisateur clique sur Envoyer dans Gmail.
 * Le contenu des messages vient de l'extérieur : c'est une donnée, jamais une instruction.
 */
import { jetonAcces } from "./agenda.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const PERIMETRE_LECTURE_MAIL = "https://www.googleapis.com/auth/gmail.readonly";
export const PERIMETRE_BROUILLON_MAIL = "https://www.googleapis.com/auth/gmail.compose";

const enc = new TextEncoder();
const ID = /^[0-9a-f]{8,32}$/i;

async function appel(env, coffre, email, chemin, options = {}) {
  const jeton = await jetonAcces(env, coffre, email);
  const r = await fetch(API + chemin, {
    method: options.corps ? "POST" : "GET",
    headers: { Authorization: `Bearer ${jeton}`, ...(options.corps ? { "Content-Type": "application/json" } : {}) },
    body: options.corps ? JSON.stringify(options.corps) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) {
    if (r.status === 403) throw new Error("L'accès aux mails n'est pas autorisé : dans Réglages, reliez de nouveau Google en cochant Gmail (et vérifiez que l'API Gmail est activée).");
    throw new Error(`Gmail a répondu ${r.status}.`);
  }
  return r.json();
}

function deBase64Url(s) {
  const b = atob(String(s || "").replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8").decode(Uint8Array.from(b, (c) => c.charCodeAt(0)));
}
function enBase64(texte) {
  let b = "";
  for (const o of enc.encode(texte)) b += String.fromCharCode(o);
  return btoa(b);
}
const propre = (s, max) => String(s || "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const entete = (m, nom) => (m.payload?.headers || []).find((h) => String(h.name).toLowerCase() === nom.toLowerCase())?.value || "";

function resume(m) {
  const t = Number(m.internalDate);
  return {
    id: m.id,
    de: propre(entete(m, "From"), 120),
    objet: propre(entete(m, "Subject"), 200) || "(sans objet)",
    recu: Number.isFinite(t) ? new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(t)) : "",
    non_lu: (m.labelIds || []).includes("UNREAD"),
    extrait: propre(m.snippet, 220),
  };
}

/* Derniers messages : boîte de réception par défaut, ou recherche à la manière de Gmail. */
export async function listerMails(env, coffre, email, { recherche, nombre } = {}) {
  const n = Math.max(1, Math.min(10, Math.round(Number(nombre)) || 5));
  const q = propre(recherche, 200) || "in:inbox";
  const liste = await appel(env, coffre, email, `/messages?maxResults=${n}&q=${encodeURIComponent(q)}`);
  const ids = (liste.messages || []).map((m) => m.id).filter((id) => ID.test(id));
  const messages = await Promise.all(ids.map((id) => appel(env, coffre, email, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`)));
  return messages.map(resume);
}

function texteDuCorps(partie) {
  if (!partie) return "";
  if (partie.mimeType === "text/plain" && partie.body?.data) return deBase64Url(partie.body.data);
  for (const p of partie.parts || []) {
    const t = texteDuCorps(p);
    if (t) return t;
  }
  if (partie.mimeType === "text/html" && partie.body?.data) {
    return deBase64Url(partie.body.data).replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  }
  return "";
}

/* Un message en entier (texte seul, sans pièces jointes), borné pour rester lisible à l'oral. */
export async function lireMail(env, coffre, email, id) {
  if (!ID.test(String(id || ""))) throw new Error("Identifiant de message invalide : utilise un identifiant donné par lire_mails.");
  const m = await appel(env, coffre, email, `/messages/${id}?format=full`);
  const texte = texteDuCorps(m.payload).replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { ...resume(m), a: propre(entete(m, "To"), 200), texte: texte.slice(0, 4000), tronque: texte.length > 4000 };
}

const ADRESSE = /^[^\s<>@,;"]+@[^\s<>@,;"]+\.[a-z]{2,}$/i;
function adresseDe(champ) {
  const m = /<([^<>]+)>/.exec(champ || "");
  const a = (m ? m[1] : String(champ || "")).trim();
  return ADRESSE.test(a) ? a : "";
}

/* Crée un brouillon dans Gmail (nouveau message, ou réponse à un message reçu). N'envoie rien. */
export async function creerBrouillon(env, coffre, email, { destinataire, objet, texte, repondre_a } = {}) {
  const corps = String(texte || "").replace(/\r\n?/g, "\n").trim().slice(0, 6000);
  if (!corps) throw new Error("Le texte du message est vide.");
  let a = adresseDe(destinataire), sujet = propre(objet, 200), fil = null, references = "";
  if (repondre_a) {
    if (!ID.test(String(repondre_a))) throw new Error("Identifiant de message invalide pour la réponse.");
    const o = await appel(env, coffre, email, `/messages/${repondre_a}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Subject&metadataHeaders=Message-ID`);
    a = a || adresseDe(entete(o, "Reply-To")) || adresseDe(entete(o, "From"));
    const s = propre(entete(o, "Subject"), 190);
    sujet = sujet || (/^re\s*:/i.test(s) ? s : `Re: ${s}`);
    fil = o.threadId || null;
    references = propre(entete(o, "Message-ID"), 300);
  }
  if (!a) throw new Error("Adresse du destinataire manquante ou invalide : demande-la à l'utilisateur.");
  if (!sujet) throw new Error("Objet du message manquant.");
  const lignes = [
    `To: ${a}`,
    `Subject: =?UTF-8?B?${enBase64(sujet)}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    ...(references ? [`In-Reply-To: ${references}`, `References: ${references}`] : []),
    "",
    enBase64(corps).replace(/(.{76})/g, "$1\r\n"),
  ];
  const brut = enBase64(lignes.join("\r\n")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await appel(env, coffre, email, "/drafts", { corps: { message: { raw: brut, ...(fil ? { threadId: fil } : {}) } } });
  return { destinataire: a, objet: sujet };
}
