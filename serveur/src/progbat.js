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

/* Toutes les factures, de la plus récente à la plus ancienne : l'encours peut venir d'une année précédente. */
async function toutesLesFactures(env) {
  try {
    return (await liste(env, "/company/bills", { sort: { documentDate: -1 } })).lignes;
  } catch (e) {
    if (e.statut === 401 || e.statut === 403) throw e;
    return (await liste(env, "/company/bills", {})).lignes;
  }
}

/* Règlements : chaque transaction bancaire pointée porte la liste des documents qu'elle règle (checking). */
async function reglements(env) {
  const r = await liste(env, "/company/transactions", {});
  const parFacture = new Map(), types = new Map();
  let liens = 0;
  for (const t of r.lignes) {
    if (t.canceled) continue;
    for (const c of Array.isArray(t.checking) ? t.checking : []) {
      const type = String(c.docType || "");
      types.set(type, (types.get(type) || 0) + 1);
      if (c.docId == null || /supplier|fournisseur|order|commande/i.test(type)) continue;
      liens++;
      parFacture.set(Number(c.docId), (parFacture.get(Number(c.docId)) || 0) + Math.abs(nombre(c.amount)));
    }
  }
  return { parFacture, liens, transactions: r.lignes.length, types: [...types.entries()].map(([type, n]) => ({ type, nombre: n })) };
}

const cache = new Map(); // année → { quand, resume }

export async function resumeProgbat(env, { annee, forcer = false } = {}) {
  if (!env.PROGBAT_JETON) throw new ProgbatNonConfigure("Le secret PROGBAT_JETON n'est pas réglé sur le serveur.");
  const an = Number(annee) >= 2000 && Number(annee) <= 2100 ? Number(annee) : new Date().getFullYear();
  const enCache = cache.get(an);
  if (!forcer && enCache && Date.now() - enCache.quand < DUREE_CACHE) return enCache.resume;

  const [toutes, regl, devis, chantiers] = await Promise.all([
    toutesLesFactures(env),
    reglements(env).catch((e) => ({ parFacture: new Map(), liens: 0, transactions: 0, types: [], erreur: String(e.message || e) })),
    liste(env, "/company/quotes", { sort: { documentDate: -1 } }).catch((e) => ({ lignes: null, erreur: String(e.message || e) })),
    liste(env, "/company/yards", {}).catch((e) => ({ lignes: [], total: 0, erreur: String(e.message || e) })),
  ]);

  const aujourdhui = new Date().toISOString().slice(0, 10);
  const mois = Array(12).fill(0), acomptes = Array(12).fill(0), parClient = new Map(), groupes = new Map();
  let ca = 0, retenues = 0, enc = 0, encNb = 0, ret = 0, retNb = 0;
  const debut = `${an}-01-01`, fin = `${an}-12-31`;
  const factures = toutes.filter((f) => String(f.documentDate || "").slice(0, 10) >= debut && String(f.documentDate || "").slice(0, 10) <= fin);

  // reste à encaisser, sur les factures validées de l'exercice (du 1er janvier au 31 décembre).
  // État de règlement tenu par ProGBat (champ status, vérifié sur les données réelles) :
  //   0 = non réglée, 1 = soldée (par un règlement ou par un avoir), 2 = réglée en partie.
  // Une facture soldée ne doit plus rien, même sans règlement pointé : c'est le cas des factures annulées par un avoir.
  // Pour les autres : net à payer du document, moins les règlements pointés en banque.
  const restes = new Map();
  for (const f of factures) {
    if (!f.validated || f.test || f.type === "model") continue;
    if (f.status === 1) { restes.set(f.id, 0); continue; }
    const signe = /credit/.test(f.type || "") ? -1 : 1;
    const du = signe * Math.abs(nombre(f.toBePaid) || nombre(f.atiTotal));
    const reste = arrondi(du - signe * (regl.parFacture.get(Number(f.id)) || 0));
    restes.set(f.id, reste);
    if (Math.abs(reste) < 0.01) continue;
    enc += reste;
    if (reste > 0) encNb++;
    // un avoir non encore imputé vient en déduction des deux totaux
    if (f.dueDate && String(f.dueDate).slice(0, 10) < aujourdhui) { ret += reste; if (reste > 0) retNb++; }
  }

  for (const f of factures) {
    const avoir = /credit/.test(f.type || "");
    const signe = avoir ? -1 : 1;
    const ht = signe * Math.abs(nombre(f.netTotal));
    const m = Number(String(f.documentDate || "").slice(5, 7)) - 1;
    const retenue = f.validated && !f.test && f.type !== "model";

    // tableau de contrôle, sans aucun nom : sert à vérifier comment ProGBat code l'état des factures
    const cle = [f.type, f.validated ? 1 : 0, f.status, f.einvoiceStatus ?? ""].join("|");
    const g = groupes.get(cle) || { type: f.type, validee: !!f.validated, statut: f.status, statut_efacture: f.einvoiceStatus ?? null, nombre: 0, total_ht: 0, reste_a_payer: 0, echues: 0, soldees: 0, regle: 0, reste_calcule: 0, reste_echu: 0 };
    g.nombre++; g.total_ht += ht; g.reste_a_payer += signe * Math.abs(nombre(f.toBePaid));
    if (f.dueDate && String(f.dueDate).slice(0, 10) < aujourdhui) g.echues++;
    if (restes.has(f.id) && Math.abs(restes.get(f.id)) < 0.01) g.soldees++;
    g.regle += regl.parFacture.get(Number(f.id)) || 0;
    if (restes.has(f.id)) { g.reste_calcule += restes.get(f.id); if (f.dueDate && String(f.dueDate).slice(0, 10) < aujourdhui) g.reste_echu += restes.get(f.id); }
    groupes.set(cle, g);

    if (!retenue || m < 0 || m > 11) continue;
    retenues++;
    // les factures d'acompte comptent dans le chiffre d'affaires (choix de l'entreprise) et restent aussi suivies à part
    if (/^advance/.test(f.type || "")) acomptes[m] += ht;
    mois[m] += ht; ca += ht;
    const client = String(f.clientBusinessName || f.clientName || "").trim().slice(0, 60);
    if (client) parClient.set(client, (parClient.get(client) || 0) + ht);
  }

  // devis — statut documenté par ProGBat : 0 = à l'étude ou brouillon, 1 = accepté, 2 = refusé, 6 = en attente
  // tout est compté sur l'exercice : du 1er janvier au 31 décembre de l'année demandée
  const dansExercice = (j) => String(j || "").slice(0, 10) >= debut && String(j || "").slice(0, 10) <= fin;
  const d = { acceptes: 0, acceptes_nombre: 0, en_attente: 0, en_attente_total: 0, a_envoyer: 0, etablis: 0, etablis_total: 0, lus: 0, erreur: devis.erreur || null };
  for (const q of devis.lignes || []) {
    d.lus++;
    if (q.status === 1) { if (dansExercice(q.statusDate || q.documentDate)) { d.acceptes += nombre(q.dealNetTotal); d.acceptes_nombre++; } }
    if (!dansExercice(q.documentDate)) continue;
    // devis établis dans l'exercice : tous états confondus, hors brouillons (numéro provisoire commençant par $)
    if (!String(q.code || "").startsWith("$")) { d.etablis++; d.etablis_total += nombre(q.dealNetTotal); }
    if (q.status === 1) continue;
    if (q.status === 6) { d.en_attente++; d.en_attente_total += nombre(q.dealNetTotal); }
    else if (q.status === 0) d.a_envoyer++;
  }
  d.acceptes = arrondi(d.acceptes); d.etablis_total = arrondi(d.etablis_total); d.en_attente_total = arrondi(d.en_attente_total);

  const resume = {
    annee: an,
    lu_le: new Date().toISOString(),
    factures_lues: factures.length,
    factures_total: toutes.length,
    factures_retenues: retenues,
    ca: arrondi(ca),
    encours: arrondi(enc),
    encours_nombre: encNb,
    retard: arrondi(Math.max(0, ret)),
    retard_nombre: retNb,
    devis: devis.lignes ? d : { erreur: d.erreur },
    reglements: { transactions: regl.transactions, pointages: regl.liens, types: regl.types, erreur: regl.erreur || null },
    mois: mois.map(arrondi),
    acomptes: acomptes.map(arrondi),
    clients: [...parClient.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, v]) => ({ n, v: arrondi(v) })),
    chantiers: chantiers.lignes.slice(0, 200).map((y) => ({ nom: String(y.label || "").slice(0, 60), debut: y.startDate || null, fin: y.endDate || null })).filter((y) => y.nom),
    chantiers_erreur: chantiers.erreur || null,
    controle: [...groupes.values()].map((g) => ({ ...g, total_ht: arrondi(g.total_ht), reste_a_payer: arrondi(g.reste_a_payer), regle: arrondi(g.regle), reste_calcule: arrondi(g.reste_calcule), reste_echu: arrondi(g.reste_echu) })).sort((a, b) => b.nombre - a.nombre),
  };
  cache.set(an, { quand: Date.now(), resume });
  return resume;
}
