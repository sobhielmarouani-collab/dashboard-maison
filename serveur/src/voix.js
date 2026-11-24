/*
 * Voix de Sigma produite par Google Cloud Text-to-Speech, avec le minutage de chaque mot.
 *
 * Le serveur envoie le texte sous forme SSML, un repère <mark> avant chaque mot : Google renvoie
 * le son (MP3) et l'instant de chaque repère, ce qui permet d'animer la bouche de l'avatar sur
 * l'audio réel. La clé (secret GOOGLE_TTS_CLE) ne quitte jamais le serveur.
 */

const URL_SYNTHESE = "https://texttospeech.googleapis.com/v1beta1/text:synthesize";
const VOIX_PAR_DEFAUT = "fr-FR-Neural2-B"; // voix d'homme ; remplaçable par la variable VOIX_GOOGLE
export const LONGUEUR_MAX_VOIX = 1800;

export class VoixNonConfiguree extends Error {}

const echapper = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function demander(env, ssml, voix, vitesse) {
  const r = await fetch(URL_SYNTHESE, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": env.GOOGLE_TTS_CLE },
    body: JSON.stringify({
      input: { ssml },
      voice: voix,
      audioConfig: { audioEncoding: "MP3", speakingRate: vitesse },
      enableTimePointing: ["SSML_MARK"],
    }),
    signal: AbortSignal.timeout(12000),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, statut: r.status, j };
}

export async function synthetiser(env, { texte, vitesse } = {}) {
  if (!env.GOOGLE_TTS_CLE) throw new VoixNonConfiguree("Le secret GOOGLE_TTS_CLE n'est pas réglé sur le serveur.");
  const propre = String(texte || "").replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, LONGUEUR_MAX_VOIX);
  if (!propre) throw new Error("Texte vide.");
  const mots = propre.split(" ");
  const ssml = "<speak>" + mots.map((m, i) => `<mark name="m${i}"/>${echapper(m)}`).join(" ") + "</speak>";
  const v = Math.max(0.7, Math.min(1.3, Number(vitesse) || 1));

  let rep = await demander(env, ssml, { languageCode: "fr-FR", name: env.VOIX_GOOGLE || VOIX_PAR_DEFAUT }, v);
  // nom de voix inconnu ou retiré : on laisse Google choisir une voix d'homme française
  if (!rep.ok && rep.statut === 400) rep = await demander(env, ssml, { languageCode: "fr-FR", ssmlGender: "MALE" }, v);
  if (!rep.ok) {
    const detail = String(rep.j?.error?.message || "").slice(0, 200);
    if (rep.statut === 403) throw new Error(`Google refuse la synthèse vocale (403) : vérifiez que l'API Text-to-Speech est activée, la facturation aussi, et que la clé y donne accès. ${detail}`);
    throw new Error(`Google Text-to-Speech a répondu ${rep.statut}. ${detail}`);
  }
  const instants = new Map((rep.j.timepoints || []).map((p) => [p.markName, Number(p.timeSeconds)]));
  return {
    audio: rep.j.audioContent || "",
    mots: mots.map((m, i) => ({ m, t: instants.has(`m${i}`) ? Math.round(instants.get(`m${i}`) * 1000) / 1000 : null })),
    minutage: instants.size > 0,
  };
}
