/*
 * ProGBat : lecture seule des factures et des chantiers du compte de l'entreprise.
 *
 * Le jeton (secret PROGBAT_JETON, « Jeton d'accès privé » d'une application privée du
 * Portail développeur ProGBat, limitée aux droits de lecture) ne quitte jamais le serveur.
 * Ce module n'envoie que des requêtes GET.
 *
 * Documentation : https://progbat.readme.io — les listes se paginent avec limit/offset,
 * le total est donné par l'en-tête « Range: début - fin / total ».
 */

const BASE = "https://api.progbat.com/v2";
const PAR_PAGE = 100;
const PAGES_MAX = 30; // garde-fou : 3 000 lignes par liste au plus
const DUREE_CACHE = 5 * 60 * 1000;

export class ProgbatNonConfigure extends Error {}

async function page(env, chemin, params) {
  const url = new URL(BASE + chemin);
  for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  const r = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${env.PROGBAT_JETON}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    const e = new Error(
      r.status === 401 ? "ProGBat refuse le jeton (401) : vérifiez le secret PROGBAT_JETON."
      : r.status === 403 ? `ProGBat refuse l'accès à ${chemin} (403) : il manque un droit de lecture à l'application.`
      : `ProGBat a répondu ${r.status} pour ${chemin}${detail ? " : " + detail : ""}`,
    );
    e.statut = r.status;
    throw e;
  }
  const donnees = await r.json();
  const m = /(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)/.exec(r.headers.get("Range") || r.headers.get("Content-Range") || "");
  return { lignes: Array.isArray(donnees) ? donnees : [], total: m ? Number(m[3]) : null };
}

async function liste(env, chemin, params) {
  const tout = [];
  let total = null;
  for (let i = 0; i < PAGES_MAX; i++) {
    const p = await page(env, chemin, { ...params, limit: PAR_PAGE, offset: i * PAR_PAGE });
    tout.push(...p.lignes);
    if (p.total != null) total = p.total;
    if (p.lignes.length < PAR_PAGE || (total != null && tout.length >= total)) break;
  }
  return { lignes: tout, total: total ?? tout.length };
}

const nombre = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const arrondi = (v) => Math.round(v * 100) / 100;

/* Factures de l'année : on demande le filtre à ProGBat, et s'il le refuse on trie de notre côté. */
async function facturesDeLAnnee(env, annee) {
  const debut = `${annee}-01-01`, fin = `${annee}-12-31`;
  let r;
  try {
    r = await liste(env, "/company/bills", { filter: { documentDate: { $between: [debut, fin] } }, sort: { documentDate: -1 } });
  } catch (e) {
    if (e.statut === 401 || e.statut === 403) throw e;
    r = await liste(env, "/company/bills", {});
  }
  return r.lignes.filter((f) => String(f.documentDate || "").slice(0, 10) >= debut && String(f.documentDate || "").slice(0, 10) <= fin);
}

const cache = new Map(); // année → { quand, resume }

export async function resumeProgbat(env, { annee, forcer = false } = {}) {
  if (!env.PROGBAT_JETON) throw new ProgbatNonConfigure("Le secret PROGBAT_JETON n'est pas réglé sur le serveur.");
  const an = Number(annee) >= 2000 && Number(annee) <= 2100 ? Number(annee) : new Date().getFullYear();
  const enCache = cache.get(an);
  if (!forcer && enCache && Date.now() - enCache.quand < DUREE_CACHE) return enCache.resume;

  const [factures, chantiers] = await Promise.all([
    facturesDeLAnnee(env, an),
    liste(env, "/company/yards", {}).catch((e) => ({ lignes: [], total: 0, erreur: String(e.message || e) })),
  ]);

  const aujourdhui = new Date().toISOString().slice(0, 10);
  const mois = Array(12).fill(0), acomptes = Array(12).fill(0), parClient = new Map(), groupes = new Map();
  let ca = 0, retenues = 0;

  for (const f of factures) {
    const avoir = /credit/.test(f.type || "");
    const signe = avoir ? -1 : 1;
    const ht = signe * Math.abs(nombre(f.netTotal));
    const m = Number(String(f.documentDate || "").slice(5, 7)) - 1;
    const retenue = f.validated && !f.test && f.type !== "model";

    // tableau de contrôle, sans aucun nom : sert à vérifier comment ProGBat code l'état des factures
    const cle = [f.type, f.validated ? 1 : 0, f.status, f.einvoiceStatus ?? ""].join("|");
    const g = groupes.get(cle) || { type: f.type, validee: !!f.validated, statut: f.status, statut_efacture: f.einvoiceStatus ?? null, nombre: 0, total_ht: 0, reste_a_payer: 0, echues: 0 };
    g.nombre++; g.total_ht += ht; g.reste_a_payer += signe * Math.abs(nombre(f.toBePaid));
    if (f.dueDate && String(f.dueDate).slice(0, 10) < aujourdhui) g.echues++;
    groupes.set(cle, g);

    if (!retenue || m < 0 || m > 11) continue;
    retenues++;
    if (/^advance/.test(f.type || "")) { acomptes[m] += ht; continue; }
    mois[m] += ht; ca += ht;
    const client = String(f.clientBusinessName || f.clientName || "").trim().slice(0, 60);
    if (client) parClient.set(client, (parClient.get(client) || 0) + ht);
  }

  const resume = {
    annee: an,
    lu_le: new Date().toISOString(),
    factures_lues: factures.length,
    factures_retenues: retenues,
    ca: arrondi(ca),
    mois: mois.map(arrondi),
    acomptes: acomptes.map(arrondi),
    clients: [...parClient.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, v]) => ({ n, v: arrondi(v) })),
    chantiers: chantiers.lignes.slice(0, 200).map((y) => ({ nom: String(y.label || "").slice(0, 60), debut: y.startDate || null, fin: y.endDate || null })).filter((y) => y.nom),
    chantiers_erreur: chantiers.erreur || null,
    controle: [...groupes.values()].map((g) => ({ ...g, total_ht: arrondi(g.total_ht), reste_a_payer: arrondi(g.reste_a_payer) })).sort((a, b) => b.nombre - a.nombre),
  };
  cache.set(an, { quand: Date.now(), resume });
  return resume;
}
