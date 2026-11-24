/*
 * Coffre : Durable Object qui garde, côté serveur,
 *   - les sessions ouvertes (empreinte du jeton, adresse, date d'expiration) ;
 *   - les demandes récentes de chaque adresse, pour la limite par heure.
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
    `);
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
