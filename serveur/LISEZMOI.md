# Serveur de l'assistant

Ce dossier contient le petit serveur qui relie le dashboard au modèle d'IA Claude.
Il est hébergé gratuitement chez **Cloudflare Workers** sous le nom `assistant-dashboard-travail`.

- **Étape 1, conversation libre :** le serveur reçoit la phrase dite à l'avatar, la transmet à l'API Anthropic et renvoie la réponse à lire à voix haute.
- **Étape 2, accès réservé :** le serveur ne répond qu'aux personnes connectées avec un compte Google figurant dans votre liste d'adresses autorisées. Le nombre de questions est limité par heure.
- **Étape 4, agenda Google :** l'onglet Agenda affiche les vrais événements de votre agenda Google sur 7 jours, et l'assistant répond à « qu'est-ce que j'ai demain ? ». L'accès est en **lecture seule**.
- **Étape 3, actions du dashboard :** l'IA comprend les formulations libres (« j'ai fini le devis », « mets un rappel dans dix minutes », « passe le chantier Dupont à 80 % ») et agit sur l'écran : tâches, chantiers, rendez-vous du jour, minuteur, onglets, lumières, volets, chauffage, présence.

> **Règle absolue : aucune valeur privée dans ce dépôt.** Il est public. La clé d'API, l'identifiant client Google et la liste des adresses se mettent uniquement dans le tableau de bord Cloudflare, sous forme de « secrets » chiffrés (type **Secret**, jamais **Texte** ni **Variable**).
>
> Les quatre secrets sont `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID`, `ADRESSES_AUTORISEES` et, depuis l'étape 4, `GOOGLE_CLIENT_SECRET`. Ne les ajoutez jamais à la section `vars` de `wrangler.jsonc` : ils deviendraient publics, et Cloudflare refuserait le déploiement à cause du doublon de nom. Les seules valeurs de `vars` sont des réglages non privés : `ORIGINES_AUTORISEES`, `MODELE`, `LIMITE_PAR_HEURE` et `JOURS_SESSION`.

## Fonctionnement

```
Dashboard (GitHub Pages)                        Cloudflare Worker                           Services
1. « Se connecter avec Google » ──jeton Google──> vérifie le jeton auprès de Google
                                                 adresse dans la liste ? ──non──> refus
                               <──jeton de session (30 jours)──
2. phrase + jeton de session ──POST /assistant──> session valide ? limite horaire ? ──> API Anthropic (Claude)
                               <──────────── réponse en texte ─────────────────────────
```

- La connexion se fait une fois par navigateur, dans l'onglet **Réglages**. Elle dure 30 jours.
- Les sessions et les compteurs sont gardés côté serveur, dans un petit stockage Cloudflare (un « Durable Object »). Il est créé automatiquement au déploiement : rien à faire de votre côté.
- Connecté, chaque phrase part à l'IA avec un résumé de l'écran : tâches, chantiers, rendez-vous du jour, minuteur, onglet affiché, lumières, volets, chauffage, présence et météo. L'IA peut ainsi répondre (« qu'est-ce qu'il me reste à faire ? ») et agir avec l'outil `action_dashboard`.
- Le serveur ne modifie rien lui-même. Il vérifie chaque action demandée par l'IA sur une copie de ce résumé, par exemple que la tâche nommée existe et qu'un seul élément correspond. Il renvoie ensuite à la page la liste des actions acceptées. La page les revérifie et les exécute. Une action refusée est signalée à l'IA, qui se corrige ou demande une précision au lieu d'annoncer un faux succès.
- Sans connexion, serveur coupé ou limite horaire atteinte, les ordres simples d'avant (ajouter une tâche, minuteur, lumières, onglets, heure, météo) fonctionnent toujours, directement dans la page.
- Toute autre phrase part au serveur, avec les derniers échanges pour garder le fil. Le fil se vide après dix minutes sans échange.
- Si le serveur est coupé, le dashboard fonctionne comme avant.
- Sur l'Echo Show, rien ne change. Laissez l'adresse du serveur vide sur cet appareil : la connexion Google n'y est alors même pas chargée.

## Ce que vous devez faire vous-même

Les noms des boutons peuvent varier un peu si Cloudflare, Google ou Anthropic modifient leur site. Si vous avez déjà fait l'étape 1, passez directement à la partie **D**.

### A. Créer la clé d'API Anthropic (étape 1)

1. Allez sur **https://platform.claude.com** et créez un compte. Le compte « Claude » grand public et le compte API sont distincts : l'abonnement claude.ai ne donne pas de crédit d'API.
2. Ouvrez **Billing** (Facturation), ajoutez une carte bancaire et achetez du crédit prépayé : 5 $ suffisent pour commencer.
3. Ouvrez **Limits** (Limites) et fixez une **limite de dépense mensuelle**, par exemple 10 $. C'est un filet de sécurité en plus de la limite horaire du serveur.
4. Ouvrez **API Keys**, cliquez sur **Create Key** et nommez-la `dashboard-maison`.
5. **Copiez la clé tout de suite** (elle commence par `sk-ant-`) : elle ne sera plus affichée. Ne la collez ni dans GitHub, ni dans un mail, ni dans une conversation.

### B. Mettre le serveur en ligne chez Cloudflare (étape 1)

1. Créez un compte gratuit sur **https://dash.cloudflare.com/sign-up**. Aucun nom de domaine n'est nécessaire.
2. Ouvrez **Workers et Pages** (Compute › Workers & Pages). Au premier passage, choisissez un sous-domaine `workers.dev`, par exemple `maison-albi`.
3. Cliquez sur **Créer**, puis **Importer un dépôt**. Connectez GitHub en ne donnant accès qu'au dépôt `dashboard-maison`.
4. Réglez le projet :
   - **Nom du projet** : `assistant-dashboard-travail`
   - **Branche de production** : `main`
   - **Répertoire racine** (paramètres avancés) : `serveur`
   - **Commande de build** : laisser vide
   - **Commande de déploiement** : `npx wrangler deploy`
5. Cliquez sur **Créer et déployer**.

Ensuite, chaque modification fusionnée dans `main` redéploie le serveur tout seul.

### C. Donner la clé Anthropic au serveur (étape 1)

1. Dans Cloudflare, ouvrez le Worker `assistant-dashboard-travail`, onglet **Paramètres**, section **Variables et secrets**.
2. Cliquez sur **Ajouter**. Type **Secret**, nom `ANTHROPIC_API_KEY`, valeur : la clé `sk-ant-…`.
3. Cliquez sur **Déployer**.

### D. Créer l'identifiant de connexion Google (étape 2)

Cet identifiant permet au dashboard d'afficher le bouton « Se connecter avec Google », et au serveur de vérifier que le jeton reçu a bien été émis pour votre dashboard. Il n'y a **aucun mot de passe ni « secret client »** à créer pour cela.

1. Allez sur **https://console.cloud.google.com** avec votre compte Google. Acceptez les conditions si c'est votre première visite.
2. En haut de la page, ouvrez le **sélecteur de projet**, puis cliquez sur **Nouveau projet**. Nommez-le `dashboard-maison` et cliquez sur **Créer**. Vérifiez qu'il est bien sélectionné en haut de la page.
3. Dans le menu ☰, ouvrez **API et services › Écran de consentement OAuth**. La page s'appelle aussi **Google Auth Platform**. Cliquez sur **Commencer** :
   - **Nom de l'application** : `Dashboard maison` ; **Adresse e-mail d'assistance** : la vôtre ; **Suivant**.
   - **Cible** (Audience) : **Interne** si vous vous connectez avec un compte Google Workspace (votre cas : seuls les comptes de votre domaine peuvent se connecter, sans liste d'utilisateurs test ni validation par Google) ; **Externe** pour un compte Gmail personnel. Puis **Suivant**.
   - **Coordonnées** : votre adresse ; **Suivant**.
   - Cochez l'acceptation du règlement, puis **Créer**.
4. *Seulement en audience Externe :* dans le menu de gauche, ouvrez **Cible** (Audience). Laissez l'état de publication sur **Test**. Dans **Utilisateurs test**, cliquez sur **Ajouter des utilisateurs** et saisissez chaque adresse Gmail qui aura le droit d'utiliser l'assistant. En mode Test, seules ces adresses peuvent se connecter. C'est une barrière de plus, en amont de la liste du serveur.
5. Ouvrez **Clients**, puis cliquez sur **Créer un client** :
   - **Type d'application** : **Application Web**
   - **Nom** : `Dashboard`
   - **Origines JavaScript autorisées**, **Ajouter un URI** : `https://sobhielmarouani-collab.github.io`. Saisissez-la exactement ainsi, sans chemin ni barre oblique finale.
   - **URI de redirection autorisés** : laisser vide.
   - Cliquez sur **Créer**.
6. Une fenêtre affiche l'**ID client**, de la forme `123456789-abc….apps.googleusercontent.com`. Copiez-le. S'il est aussi proposé un « Code secret du client », ne vous en servez pas : il n'est pas utile ici et ne doit aller nulle part.

Vous n'avez **aucune API à activer** pour cette étape : la connexion seule n'en demande pas. Les API Agenda et Gmail viendront aux étapes 4 et 5.

### E. Donner la liste d'accès au serveur (étape 2)

Dans Cloudflare, Worker `assistant-dashboard-travail`, **Paramètres › Variables et secrets**, ajoutez deux valeurs de type **Secret** :

| Nom | Valeur |
|---|---|
| `GOOGLE_CLIENT_ID` | l'ID client copié au point D.6 |
| `ADRESSES_AUTORISEES` | les adresses autorisées, séparées par des virgules, par exemple `vous@gmail.com, conjoint@gmail.com` |

Cliquez sur **Déployer**. On utilise le type « Secret » pour que vos adresses ne soient pas publiées dans le dépôt, et pour qu'un redéploiement depuis GitHub ne les efface pas.

Tant que ces deux valeurs manquent, personne ne peut se connecter et le serveur ne répond à aucune question.

### F. Mettre à jour le serveur et se connecter (étape 2)

1. Fusionnez la branche de l'étape 2 dans `main`. Cloudflare redéploie tout seul. Dans **Déploiements**, attendez que le dernier soit marqué réussi.
2. Ouvrez le dashboard sur le PC, onglet **Réglages**, carte **Assistant**.
3. Dans **Adresse du serveur**, mettez l'adresse du Worker, par exemple `https://assistant-dashboard-travail.maison-albi.workers.dev`. Le `/assistant` final n'est plus nécessaire ; une ancienne adresse qui le contient fonctionne aussi. Touchez **Enregistrer l'adresse**.
4. Le bouton **Se connecter avec Google** apparaît. Touchez-le et choisissez votre compte. Google peut prévenir que l'application n'est pas validée : c'est normal en mode Test pour votre propre application ; continuez.
5. « Connecté : votre adresse » s'affiche. Touchez **Tester** : « Serveur joignable » doit apparaître avec une courte réponse de l'IA.

Recommencez les points 2 à 5 sur chaque navigateur ou appareil qui doit utiliser l'assistant (sauf l'Echo Show).

### G. Vérifier que l'accès est bien réservé

- **Avec une adresse non autorisée :** ouvrez le dashboard dans une fenêtre de navigation privée, réglez l'adresse du serveur et connectez-vous avec un compte Google qui n'est pas dans la liste. Le message « Ce compte Google n'est pas autorisé » doit s'afficher, et l'avatar ne doit répondre à aucune question libre.
- **Sans connexion :** une question libre doit donner « connectez-vous avec Google dans l'onglet Réglages ». Les ordres simples comme « ajoute la tâche… » doivent toujours marcher.

### H. Étape 3 : rien à configurer

L'étape 3 ne demande **aucun nouveau secret ni réglage**. Fusionnez la branche dans `main`. Cloudflare redéploie le serveur, et GitHub Pages publie la page.

Après le déploiement, vérifiez dans Cloudflare (**Paramètres › Variables et secrets**) que `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID` et `ADRESSES_AUTORISEES` sont toujours là, de type **Secret**. Un déploiement depuis GitHub ne les touche pas.

Ensuite, connecté sur le PC, essayez :

| Phrase | Résultat attendu |
|---|---|
| « Qu'est-ce qu'il me reste à faire ? » | lecture des tâches non cochées |
| « J'ai fini le devis » | la tâche contenant « devis » est cochée |
| « Rappelle-moi d'appeler le plombier » | nouvelle tâche « Appeler le plombier » |
| « Mets un minuteur de trente secondes » | minuteur lancé à 00:30 |
| « Le chantier B est à 80 % » | barre du chantier B à 80 % |
| « Ajoute un rendez-vous à 9 h 30 avec le client Martin » | rendez-vous ajouté, à sa place dans la liste |
| « Coche vérifier » s'il existe deux tâches « Vérifier… » | l'IA demande laquelle, sans rien cocher |
| « Éteins tout sauf la cuisine » | lumières de démonstration éteintes, sauf la cuisine |
| « Montre-moi la météo » | onglet Météo |

Puis déconnectez-vous dans Réglages et dites « ajoute la tâche test » : la tâche doit être ajoutée par l'ordre simple, sans l'IA.

### I. Étape 4 : relier l'agenda Google

Le serveur lit votre agenda **principal** en **lecture seule** : il ne peut ni créer, ni modifier, ni supprimer d'événement. Pour cela, il a besoin d'un second identifiant du client Google, le **code secret du client**. Il ne sert qu'au serveur et se range, comme les autres, en secret Cloudflare.

**1. Activer l'API Google Calendar** (projet `dashboard-travail`)

1. Allez sur **https://console.cloud.google.com**, avec votre compte Workspace. En haut de la page, vérifiez que le projet sélectionné est bien `dashboard-travail`.
2. Dans le menu ☰, ouvrez **API et services › Bibliothèque**.
3. Cherchez **Google Calendar API**, ouvrez-la et cliquez sur **Activer**.

**2. Déclarer l'accès en lecture à l'agenda**

1. Dans le menu ☰, ouvrez **API et services › Écran de consentement OAuth** (Google Auth Platform), puis **Accès aux données** (Data access) dans le menu de gauche.
2. Cliquez sur **Ajouter ou supprimer des champs d'application**.
3. Dans le filtre, tapez `calendar.readonly`. Cochez la ligne `…/auth/calendar.readonly` (« Afficher et télécharger tous les agendas auxquels vous avez accès »), puis cliquez sur **Mettre à jour**.
4. Cliquez sur **Enregistrer** en bas de la page.

Avec l'audience **Interne**, Google ne demande aucune validation de l'application et l'autorisation ne s'arrête pas au bout de 7 jours. Cette limite ne concerne que les applications externes en mode Test.

**3. Créer le code secret du client**

1. Dans **Google Auth Platform › Clients**, ouvrez le client **Dashboard** (type Application Web) créé à l'étape 2.
2. Vérifiez que **Origines JavaScript autorisées** contient bien `https://sobhielmarouani-collab.github.io`. Il n'y a **aucun URI de redirection** à ajouter : la fenêtre Google s'ouvre en surimpression.
3. Dans la partie **Codes secrets du client**, cliquez sur **Ajouter un code secret**. Google l'affiche **une seule fois** : copiez-le tout de suite (il commence en général par `GOCSPX-`).
   - Si vous avez gardé le code secret affiché à la création du client, vous pouvez l'utiliser à la place.
   - Ne le collez nulle part ailleurs que dans Cloudflare : ni dans GitHub, ni dans un mail, ni dans une conversation.

**4. Donner le code secret au serveur (Cloudflare)**

1. Ouvrez le Worker `assistant-dashboard-travail`, onglet **Paramètres**, section **Variables et secrets**, puis cliquez sur **Ajouter**.
2. **Type : Secret** (surtout pas « Texte »). **Nom :** `GOOGLE_CLIENT_SECRET`. **Valeur :** le code secret copié.
3. Cliquez sur **Déployer**.
4. Vérifiez la liste : elle doit contenir **quatre secrets**, `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID`, `ADRESSES_AUTORISEES` et `GOOGLE_CLIENT_SECRET`, tous de type Secret (valeur masquée).

Sans ce secret, le dashboard fonctionne comme avant et le bouton de l'agenda n'apparaît pas.

**5. Mettre à jour et relier**

1. Fusionnez la branche de l'étape 4 dans `main`. Cloudflare redéploie le serveur et GitHub Pages publie la page.
2. Sur le PC, ouvrez **Réglages**. Dans la carte **Assistant**, sous « Connecté », la ligne **Agenda Google : non relié** apparaît. Touchez **Relier mon agenda Google**.
3. Une fenêtre Google s'ouvre, avec votre compte déjà proposé. Gardez **le même compte** que celui de la connexion au dashboard. Le serveur refuse tout autre compte, pour qu'on ne puisse pas afficher l'agenda de quelqu'un d'autre.
4. Si Google affiche des cases à cocher, **cochez l'accès à l'agenda**, puis cliquez sur **Continuer** ou **Autoriser**.
5. La ligne passe à **Agenda Google : relié**. L'onglet **Agenda** affiche les 7 prochains jours. L'accueil montre les prochains rendez-vous du jour, et le résumé du jour annonce le prochain.

Le lien est enregistré **sur le serveur, pour votre adresse**. Sur un autre PC où vous êtes connecté, l'agenda s'affiche sans avoir à le relier de nouveau.

**6. Essayer**

| Phrase | Résultat attendu |
|---|---|
| « Qu'est-ce que j'ai demain ? » | lecture des événements du lendemain, dans l'ordre |
| « Suis-je libre jeudi après-midi ? » | réponse d'après les événements de jeudi |
| « Quels sont mes rendez-vous de la semaine ? » | résumé de la semaine |
| « Ajoute une réunion demain à 10 heures » | l'assistant explique qu'il ne peut pas encore écrire dans l'agenda Google |

**En cas de souci**

- **« Accès bloqué » ou « Cette application est bloquée » dans la fenêtre Google :** l'administrateur Google Workspace (peut-être vous) doit autoriser l'application. Dans **admin.google.com › Sécurité › Accès et contrôle des données › Commandes des API › Gérer l'accès des applications tierces**, recherchez l'ID client du dashboard et réglez-le sur **Approuvée**.
- **« Google refuse l'accès à l'agenda » dans l'onglet Agenda :** l'API Google Calendar n'est pas activée (point 1).
- **La fenêtre ne s'ouvre pas :** autorisez les fenêtres surgissantes pour `sobhielmarouani-collab.github.io` dans le navigateur.
- **Pour couper l'accès :** Réglages › **Délier**. Le serveur oublie le lien et le révoque chez Google. Vous pouvez aussi le retirer depuis **myaccount.google.com › Sécurité › Connexions à des applications et services tiers**.
- **Si vous changez le code secret du client :** mettez à jour `GOOGLE_CLIENT_SECRET` dans Cloudflare, puis reliez l'agenda de nouveau. L'ancien lien, chiffré avec l'ancien secret, n'est plus lisible et il est effacé tout seul.

## Gérer l'accès au quotidien

- **Ajouter une personne :** ajoutez son adresse dans `ADRESSES_AUTORISEES` (Cloudflare). En audience Externe seulement, ajoutez-la aussi aux utilisateurs test (Google, point D.4).
- **Retirer une personne :** retirez son adresse de `ADRESSES_AUTORISEES` et cliquez sur **Déployer**. Ses sessions sont refusées dès sa question suivante, même sur un appareil encore connecté.
- **Appareil perdu :** retirez temporairement l'adresse concernée, puis remettez-la et reconnectez vos autres appareils.
- **Changer la limite :** `LIMITE_PAR_HEURE` (60 questions par heure et par adresse) et `JOURS_SESSION` (30 jours) se modifient dans `wrangler.jsonc`.

## Sécurité

- Le serveur vérifie la signature du jeton Google avec les clés publiques de Google, ainsi que son émetteur, sa date d'expiration et son destinataire (votre ID client). Il exige aussi une adresse confirmée par Google, présente dans votre liste.
- Le serveur délivre alors un jeton de session aléatoire. Il n'en garde qu'une empreinte : même une fuite du stockage ne permettrait pas de se faire passer pour vous.
- Les appels ne sont acceptés que depuis `https://sobhielmarouani-collab.github.io`.
- Chaque adresse a droit à 60 questions sur toute période de soixante minutes. Au-delà, l'assistant annonce le délai d'attente.
- L'IA ne peut agir que sur les éléments listés plus haut, et seulement sur cet écran. Chaque action est vérifiée par le serveur puis par la page. Elle ne peut ni effacer toutes les données, ni toucher aux Réglages, ni envoyer quoi que ce soit à l'extérieur.
- Le résumé de l'écran envoyé avec chaque question n'est pas conservé par le serveur. Il ne sert qu'à la question en cours.
- **Agenda Google :** l'accès est en lecture seule, sur l'agenda principal. Le serveur garde seulement le jeton de rafraîchissement de Google. Il est chiffré (AES-GCM) avec une clé tirée de `GOOGLE_CLIENT_SECRET` et lié à votre adresse : copié sur une autre adresse, il est illisible. Les événements ne sont gardés ni sur le serveur ni dans le navigateur ; ils sont relus toutes les 5 minutes. L'assistant traite leur contenu (titres, lieux) comme une donnée et jamais comme une instruction, car une invitation reçue peut venir de n'importe qui.
- Gardez la limite de dépense mensuelle chez Anthropic (point A.3) comme filet de sécurité supplémentaire.
- **Si vous pensez que la clé Anthropic a fuité :** platform.claude.com › API Keys, supprimez-la, créez-en une nouvelle et remplacez le secret dans Cloudflare.

## Coût

- **Cloudflare Workers, offre gratuite** : largement suffisante pour un usage familial. Le stockage des sessions (Durable Object SQLite) est inclus dans l'offre gratuite.
- **Google** : la connexion « Se connecter avec Google » et la lecture de l'agenda (API Google Calendar) sont gratuites pour cet usage.
- **API Anthropic**, facturée à l'usage. Le serveur utilise **Claude Opus 5.5** (`claude-opus-5-5`), à 4 $ par million de jetons en entrée et 20 $ en sortie. Une question courte coûte de l'ordre d'un centime. Pour dépenser moins, changez `MODELE` dans `wrangler.jsonc` : `claude-sonnet-5-5` ou `claude-haiku-5-5`.

## Pour un développeur

```bash
cd serveur
npm install
cp .dev.vars.example .dev.vars   # puis mettre de vraies valeurs dans .dev.vars (ignoré par git)
npx wrangler dev                 # serveur local sur http://localhost:8787
```

Fichiers :

| Fichier | Rôle |
|---|---|
| `src/index.js` | routes, contrôle de l'origine, des sessions et de la limite horaire |
| `src/google.js` | vérification du jeton d'identité Google (bibliothèque `jose`) |
| `src/coffre.js` | Durable Object : sessions et compteurs (SQLite) |
| `src/modele.js` | appel à Claude via le SDK officiel `@anthropic-ai/sdk`, boucle de l'outil `action_dashboard` (4 appels au plus par question) |
| `src/agenda.js` | agenda Google : échange du code d'autorisation, chiffrement du jeton de rafraîchissement, lecture des événements à l'heure de Paris |
| `src/dashboard.js` | définition de l'outil, nettoyage de l'état envoyé par la page, vérification de chaque action |

Points d'entrée. Tous exigent l'en-tête `Origin` d'une origine autorisée ; tous sauf `/config` et `/connexion` exigent `Authorization: Bearer <session>`.

| Méthode et chemin | Corps | Réponse |
|---|---|---|
| `GET /config` | aucun | `{ client_id, agenda }` (`agenda` vaut `null` sans `GOOGLE_CLIENT_SECRET`) |
| `POST /connexion` | `{ jeton_google }` | `{ session, email, expire }`, ou 401 (jeton refusé), 403 (adresse non autorisée), 503 (non configuré) |
| `GET /agenda/etat` | aucun | `{ relie }`, ou 503 si `GOOGLE_CLIENT_SECRET` manque |
| `POST /agenda/relier` | `{ code }` | `{ relie: true }`, ou 502 (compte différent, accès agenda non coché, code refusé) |
| `POST /agenda/delier` | aucun | `{ relie: false }` (révocation chez Google) |
| `GET /agenda/evenements?debut=AAAA-MM-JJ&fin=AAAA-MM-JJ` | aucun | `{ evenements: [{ jour, debut, fin, journee, titre, lieu }] }` (31 jours au plus), ou 409 si non relié |
| `GET /session` | aucun | `{ email }` ou 401 |
| `POST /deconnexion` | aucun | `{ ok: true }` |
| `POST /assistant` | `{ phrase, historique, etat }` | `{ reponse, actions, restant }`, ou 401 (pas de session), 429 (limite horaire, en-tête `Retry-After`), 502/503 (IA indisponible) |

Pour les essais locaux seulement, `GOOGLE_CLES_TEST` peut pointer vers un serveur de clés sur `http://localhost:…`. Toute autre valeur est ignorée et les clés de Google sont utilisées.
