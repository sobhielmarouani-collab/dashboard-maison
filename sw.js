/*
 * Service worker du tableau de bord SIGNATURE : rend l'application installable et la fait
 * démarrer même sans réseau.
 *
 * Ce qui est mis en cache : uniquement les fichiers de l'interface servis par ce site
 * (page, logo, avatar, icônes, manifeste). Ce qui ne l'est jamais : tout échange avec le
 * serveur (Sigma, mails, agenda, ProGBat, voix) ou avec un autre site — ces requêtes ne
 * passent même pas par ce fichier. Aucune donnée d'entreprise n'est donc conservée ici.
 *
 * Mise à jour : la page est toujours demandée au réseau d'abord, le cache ne sert que de
 * secours hors connexion. Une nouvelle version est donc prise au prochain chargement.
 */
const CACHE = "signature-interface-v2";
const INTERFACE = ["./", "index.html", "manifest.webmanifest", "logo-signature.png", "sigma-5.jpg", "icones/icone-192.png", "icones/icone-512.png", "icones/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(INTERFACE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((noms) => Promise.all(noms.filter((n) => n !== CACHE).map((n) => caches.delete(n)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET") return;
  const url = new URL(r.url);
  if (url.origin !== self.location.origin) return; // serveur, Google, radios, météo : jamais interceptés
  // la page et le manifeste (nom, icônes de l'application) doivent toujours être à jour
  const page = r.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith(".html") || url.pathname.endsWith(".webmanifest");
  if (page) {
    // la page : réseau d'abord (toujours la dernière version), cache en secours hors connexion
    e.respondWith(
      // (on repart de l'adresse : une requête de navigation ne peut pas être relancée avec d'autres options)
      fetch(url.href, { cache: "no-store", credentials: "same-origin", redirect: "follow" })
        .then((rep) => {
          if (rep.ok) {
            const copie = rep.clone();
            e.waitUntil(caches.open(CACHE).then((c) => c.put(r, copie)));
          }
          return rep;
        })
        .catch(() => caches.match(r, { ignoreSearch: true }).then((m) => m || caches.match("index.html"))),
    );
    return;
  }
  // images et icônes : cache d'abord, rafraîchi en arrière-plan
  e.respondWith(
    caches.match(r).then((m) => {
      const frais = fetch(r).then((rep) => {
        if (rep.ok) {
          const copie = rep.clone();
          e.waitUntil(caches.open(CACHE).then((c) => c.put(r, copie)));
        }
        return rep;
      });
      return m || frais;
    }),
  );
});
