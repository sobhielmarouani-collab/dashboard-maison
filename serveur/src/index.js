/*
 * Serveur de l'assistant vocal du dashboard — étape 1 : conversation libre.
 *
 * Point d'entrée : POST /assistant
 *   corps   : { "phrase": "texte reconnu", "historique": [ { "role": "user"|"assistant", "content": "..." }, ... ] }
 *   réponse : { "reponse": "texte à lire à voix haute" }
 *
 * Aucun secret ici : la clé d'API est lue dans la variable d'environnement
 * ANTHROPIC_API_KEY, enregistrée comme « secret » chez Cloudflare.
 */
import Anthropic from "@anthropic-ai/sdk";

const MODELE_PAR_DEFAUT = "claude-opus-5-5";
const LONGUEUR_MAX_PHRASE = 1000; // caractères
const LONGUEUR_MAX_MESSAGE = 2000; // caractères par message d'historique
const HISTORIQUE_MAX = 20; // messages (10 échanges)

function consignes() {
  const aujourdhui = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
  return [
    "Tu es l'assistant vocal du tableau de bord d'une maison familiale, près d'Albi.",
    "Tes réponses sont lues à voix haute par une synthèse vocale puis affichées sous ton avatar.",
    "Réponds en français, en deux ou trois phrases courtes et naturelles, comme à l'oral.",
    "N'utilise ni titres, ni listes, ni gras, ni émojis, ni liens : seulement des phrases.",
    "Pour une question qui demande plus de détails, donne l'essentiel et propose de continuer.",
    "Tu ne peux pas encore lire l'agenda, envoyer des mails, donner les actualités du jour, lancer de la musique ni ouvrir WhatsApp.",
    "Si on te le demande, dis simplement que cette fonction arrive bientôt, sans inventer de résultat.",
    `Nous sommes le ${aujourdhui}, heure de Paris.`,
  ].join("\n");
}

function originesAutorisees(env) {
  return String(env.ORIGINES_AUTORISEES || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function entetesCors(origine) {
  return {
    "Access-Control-Allow-Origin": origine,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(corps, statut, origine) {
  return new Response(JSON.stringify(corps), {
    status: statut,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(origine ? entetesCors(origine) : {}),
    },
  });
}

/* Garde un historique propre : rôles alternés, textes bornés, commence par l'utilisateur. */
function nettoyerHistorique(brut) {
  if (!Array.isArray(brut)) return [];
  const propre = [];
  for (const m of brut.slice(-HISTORIQUE_MAX)) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    if (typeof m.content !== "string" || !m.content.trim()) continue;
    const texte = m.content.slice(0, LONGUEUR_MAX_MESSAGE);
    const dernier = propre[propre.length - 1];
    if (dernier && dernier.role === m.role) dernier.content += "\n" + texte;
    else propre.push({ role: m.role, content: texte });
  }
  while (propre.length && propre[0].role !== "user") propre.shift();
  // le message suivant sera la nouvelle phrase de l'utilisateur
  while (propre.length && propre[propre.length - 1].role !== "assistant") propre.pop();
  return propre;
}

async function demanderAuModele(env, phrase, historique) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 25_000 });
  const message = await client.beta.messages.create({
    model: env.MODELE || MODELE_PAR_DEFAUT,
    max_tokens: 2048,
    // conversation courte à l'oral : effort bas, réponse rapide
    output_config: { effort: "low" },
    // si le modèle décline une demande, l'API la relance sur un modèle de repli
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: consignes(),
    messages: [...historique, { role: "user", content: phrase }],
  });

  if (message.stop_reason === "refusal") {
    return "Je préfère ne pas répondre à cette demande.";
  }
  const texte = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
  return texte || "Je n'ai pas de réponse à cela.";
}

export default {
  async fetch(requete, env) {
    const url = new URL(requete.url);
    const origine = requete.headers.get("Origin");
    const autorisee = origine && originesAutorisees(env).includes(origine) ? origine : null;

    if (url.pathname !== "/assistant") {
      return json({ erreur: "Introuvable." }, 404, autorisee);
    }
    if (!autorisee) {
      return json({ erreur: "Origine non autorisée." }, 403, null);
    }
    if (requete.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: entetesCors(autorisee) });
    }
    if (requete.method !== "POST") {
      return json({ erreur: "Méthode non autorisée." }, 405, autorisee);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ erreur: "Clé d'API absente sur le serveur." }, 500, autorisee);
    }

    let corps;
    try {
      corps = await requete.json();
    } catch {
      return json({ erreur: "Corps JSON invalide." }, 400, autorisee);
    }
    const phrase = typeof corps?.phrase === "string" ? corps.phrase.trim() : "";
    if (!phrase) return json({ erreur: "Phrase vide." }, 400, autorisee);
    if (phrase.length > LONGUEUR_MAX_PHRASE) return json({ erreur: "Phrase trop longue." }, 413, autorisee);

    try {
      const reponse = await demanderAuModele(env, phrase, nettoyerHistorique(corps.historique));
      return json({ reponse }, 200, autorisee);
    } catch (e) {
      // le détail reste dans les journaux Cloudflare, jamais renvoyé à la page
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        console.error("Clé d'API refusée :", e.status, e.message);
        return json({ erreur: "Clé d'API refusée." }, 502, autorisee);
      }
      if (e instanceof Anthropic.RateLimitError) {
        console.error("Limite de débit atteinte :", e.message);
        return json({ erreur: "Trop de demandes, réessayez dans un instant." }, 503, autorisee);
      }
      if (e instanceof Anthropic.APIConnectionError) {
        console.error("API injoignable :", e.message);
        return json({ erreur: "Service d'IA injoignable." }, 502, autorisee);
      }
      if (e instanceof Anthropic.APIError) {
        console.error("Erreur de l'API :", e.status, e.message);
        return json({ erreur: "Erreur du service d'IA." }, 502, autorisee);
      }
      console.error("Erreur inattendue :", e);
      return json({ erreur: "Erreur du serveur." }, 500, autorisee);
    }
  },
};
