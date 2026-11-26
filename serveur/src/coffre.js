/*
 * Coffre : Durable Object qui garde, côté serveur,
 *   - les sessions ouvertes (empreinte du jeton, adresse, date d'expiration) ;
 *   - les demandes récentes de chaque adresse, pour la limite par heure ;
 *   - le jeton de rafraîchissement de l'agenda Google de chaque adresse, chiffré, et le périmètre accordé (étape 4) ;
 *   - les propositions de rendez-vous en attente de confirmation (étape 4), à usage unique, 10 minutes ;
 *   - des réglages communs à tous les appareils : rubriques et sources d'actualités (étape 6) ;
 *   - les comptes créés par la direction (profil, droits, actif ou non) et l'historique des actions importantes.
 * Une seule instance (« principal ») suffit pour un usage familial.
 * Le jeton de session lui-même n'est jamais stocké : seulement son empreinte SHA-256.
 */
import { DurableObject } from "cloudflare:workers";

const UNE_HEURE = 60 * 60 * 1000;

export class Coffre extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        empreinte TEXT PRIMARY KEY,
        email     TEXT NOT NULL,
        expire    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS demandes (
        email TEXT NOT NULL,
        quand INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS demandes_email ON demandes (email, quand);
      CREATE TABLE IF NOT EXISTS agenda_google (
        email   TEXT PRIMARY KEY,
        chiffre TEXT NOT NULL,
        relie   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reglages (
        cle    TEXT PRIMARY KEY,
        valeur TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS propositions (
        id      TEXT PRIMARY KEY,
        email   TEXT NOT NULL,
        donnees TEXT NOT NULL,
        expire  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comptes (
        email   TEXT PRIMARY KEY,
        nom     TEXT NOT NULL DEFAULT '',
        profil  TEXT NOT NULL,
        actif   INTEGER NOT NULL DEFAULT 1,
        droits  TEXT NOT NULL DEFAULT '{}',
        cree    INTEGER NOT NULL,
        modifie INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS journal (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        quand  INTEGER NOT NULL,
        auteur TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT ''
      );
    `);
    // colonne ajoutée après coup : les liaisons faites avant n'ont pas de périmètre (lecture seule)
    const colonnes = this.sql.exec("PRAGMA table_info(agenda_google)").toArray().map((c) => c.name);
    if (!colonnes.includes("portee")) this.sql.exec("ALTER TABLE agenda_google ADD COLUMN portee TEXT");
  }

  creerSession(empreinte, email, expire) {
    const maintenant = Date.now();
    this.sql.exec("DELETE FROM sessions WHERE expire <= ?", maintenant);
    this.sql.exec("INSERT INTO sessions (empreinte, email, expire) VALUES (?, ?, ?)", empreinte, email, expire);
  }

  /* Renvoie l'adresse liée à la session, ou null si elle n'existe pas ou a expiré. */
  lireSession(empreinte) {
    const ligne = this.sql.exec("SELECT email, expire FROM sessions WHERE empreinte = ?", empreinte).toArray()[0];
    if (!ligne) return null;
    if (ligne.expire <= Date.now()) {
      this.sql.exec("DELETE FROM sessions WHERE empreinte = ?", empreinte);
      return null;
    }
    return ligne.email;
  }

  /* ---------- comptes et profils (les droits sont calculés dans comptes.js) ---------- */

  lireCompte(email) {
    return this.sql.exec("SELECT email, nom, profil, actif, droits, modifie FROM comptes WHERE email = ?", email).toArray()[0] || null;
  }

  listerComptes() {
    return this.sql.exec("SELECT email, nom, profil, actif, droits, modifie FROM comptes ORDER BY profil, email").toArray();
  }

  /* Crée ou met à jour un compte. Un compte désactivé perd aussitôt ses sessions ouvertes. */
  ecrireCompte(email, nom, profil, actif, droits) {
    const maintenant = Date.now();
    this.sql.exec(
      "INSERT INTO comptes (email, nom, profil, actif, droits, cree, modifie) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET nom = excluded.nom, profil = excluded.profil, actif = excluded.actif, droits = excluded.droits, modifie = excluded.modifie",
      email, nom, profil, actif ? 1 : 0, droits, maintenant, maintenant,
    );
    if (!actif) this.sql.exec("DELETE FROM sessions WHERE email = ?", email);
  }

  /* ---------- historique des actions importantes ---------- */

  noter(auteur, action, detail = "") {
    this.sql.exec("INSERT INTO journal (quand, auteur, action, detail) VALUES (?, ?, ?, ?)", Date.now(), auteur, action, String(detail).slice(0, 500));
    this.sql.exec("DELETE FROM journal WHERE id <= (SELECT MAX(id) FROM journal) - 2000"); // on garde les 2000 dernières lignes
  }

  lireJournal(limite = 100) {
    return this.sql.exec("SELECT quand, auteur, action, detail FROM journal ORDER BY id DESC LIMIT ?", Math.min(500, Math.max(1, limite | 0))).toArray();
  }

  /* ---------- réglages communs (étape 6 : rubriques et sources d'actualités) ---------- */

  lireReglage(cle) {
    const ligne = this.sql.exec("SELECT valeur FROM reglages WHERE cle = ?", cle).toArray()[0];
    return ligne ? ligne.valeur : null;
  }

  /* valeur null : retour à la valeur d'origine */
  ecrireReglage(cle, valeur) {
    if (valeur === null) this.sql.exec("DELETE FROM reglages WHERE cle = ?", cle);
    else this.sql.exec("INSERT INTO reglages (cle, valeur) VALUES (?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur", cle, valeur);
  }

  /* ---------- agenda Google (jeton déjà chiffré par l'appelant) ---------- */

  enregistrerAgenda(email, chiffre, portee) {
    this.sql.exec(
      "INSERT INTO agenda_google (email, chiffre, relie, portee) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET chiffre = excluded.chiffre, relie = excluded.relie, portee = excluded.portee",
      email,
      chiffre,
      Date.now(),
      portee || "",
    );
  }

  /* Périmètre accordé par Google lors de la liaison (chaîne vide pour une liaison antérieure). */
  porteeAgenda(email) {
    const ligne = this.sql.exec("SELECT portee FROM agenda_google WHERE email = ?", email).toArray()[0];
    return ligne ? ligne.portee || "" : null;
  }

  /* ---------- propositions de rendez-vous en attente de confirmation ---------- */

  creerProposition(id, email, donnees, expire) {
    this.sql.exec("DELETE FROM propositions WHERE expire <= ? OR email = ?", Date.now(), email); // une seule à la fois par adresse
    this.sql.exec("INSERT INTO propositions (id, email, donnees, expire) VALUES (?, ?, ?, ?)", id, email, donnees, expire);
  }

  /* Renvoie la proposition et l'efface aussitôt (usage unique), ou null si absente, expirée ou d'une autre adresse. */
  prendreProposition(id, email) {
    const ligne = this.sql.exec("SELECT donnees, expire FROM propositions WHERE id = ? AND email = ?", id, email).toArray()[0];
    this.sql.exec("DELETE FROM propositions WHERE id = ? AND email = ?", id, email);
    if (!ligne || ligne.expire <= Date.now()) return null;
    return ligne.donnees;
  }

  lireAgenda(email) {
    const ligne = this.sql.exec("SELECT chiffre FROM agenda_google WHERE email = ?", email).toArray()[0];
    return ligne ? ligne.chiffre : null;
  }

  supprimerAgenda(email) {
    this.sql.exec("DELETE FROM agenda_google WHERE email = ?", email);
  }

  supprimerSession(empreinte) {
    this.sql.exec("DELETE FROM sessions WHERE empreinte = ?", empreinte);
  }

  /*
   * Enregistre une demande si la limite n'est pas atteinte sur les soixante dernières minutes.
   * Renvoie { accepte, restant, reessayerDans } (reessayerDans en secondes).
   */
  compterDemande(email, limite) {
    const maintenant = Date.now();
    const debut = maintenant - UNE_HEURE;
    this.sql.exec("DELETE FROM demandes WHERE quand <= ?", debut);
    const recentes = this.sql
      .exec("SELECT quand FROM demandes WHERE email = ? ORDER BY quand ASC", email)
      .toArray();
    if (recentes.length >= limite) {
      const plusAncienne = recentes[recentes.length - limite].quand;
      return { accepte: false, restant: 0, reessayerDans: Math.ceil((plusAncienne + UNE_HEURE - maintenant) / 1000) };
    }
    this.sql.exec("INSERT INTO demandes (email, quand) VALUES (?, ?)", email, maintenant);
    return { accepte: true, restant: limite - recentes.length - 1, reessayerDans: 0 };
  }
}
