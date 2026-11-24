/*
 * Appel au modèle Claude pour la conversation libre.
 */
import Anthropic from "@anthropic-ai/sdk";

const MODELE_PAR_DEFAUT = "claude-opus-5-5";
export const LONGUEUR_MAX_PHRASE = 1000; // caractères
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

/* Garde un historique propre : rôles alternés, textes bornés, commence par l'utilisateur. */
export function nettoyerHistorique(brut) {
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

export async function demanderAuModele(env, phrase, historique) {
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
