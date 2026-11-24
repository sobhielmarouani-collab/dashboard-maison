# Serveur de l'assistant — étape 1 : conversation libre

Ce dossier contient le petit serveur qui relie le dashboard au modèle d'IA Claude.
Il est hébergé gratuitement chez **Cloudflare Workers**. Il reçoit la phrase dite à l'avatar, la transmet à l'API Anthropic et renvoie la réponse à lire à voix haute.

> **Règle absolue : la clé d'API ne doit jamais être écrite dans ce dépôt.** Il est public. Elle se met uniquement dans le tableau de bord Cloudflare, sous forme de « secret » chiffré.

## Fonctionnement

```
Avatar (GitHub Pages) ──POST /assistant──> Cloudflare Worker ──> API Anthropic (Claude)
        { phrase, historique }               garde la clé           réponse en texte
```

- Les ordres simples d'aujourd'hui (ajouter une tâche, minuteur, lumières, onglets, heure, météo) restent traités directement dans la page. Ils agissent sur le dashboard, ce que le serveur ne sait pas encore faire. Tout passera par l'IA à l'étape 3.
- Toute autre phrase part au serveur, avec les derniers échanges pour garder le fil de la conversation. Le fil se vide après dix minutes sans échange.
- Si le serveur est coupé ou ne répond pas, le dashboard fonctionne comme avant.
- Sur l'Echo Show, rien ne change : le toucher donne le résumé du jour.

## Ce que vous devez faire vous-même

Comptez environ vingt minutes. Les noms des boutons peuvent varier un peu si Cloudflare ou Anthropic modifient leur site.

### A. Créer la clé d'API Anthropic

1. Allez sur **https://platform.claude.com** et créez un compte (adresse mail, puis lien de confirmation). Le compte « Claude » grand public et le compte API sont distincts : l'abonnement claude.ai ne donne pas de crédit d'API.
2. Ouvrez **Billing** (Facturation) et ajoutez une carte bancaire. Achetez du crédit prépayé : 5 $ suffisent largement pour commencer.
3. Ouvrez **Limits** (Limites) et fixez une **limite de dépense mensuelle** basse, par exemple 10 $. C'est indispensable à cette étape, voir « Sécurité » plus bas.
4. Ouvrez **API Keys** (Clés d'API), cliquez sur **Create Key**, nommez-la `dashboard-maison`, puis validez.
5. **Copiez la clé tout de suite** (elle commence par `sk-ant-`). Elle ne sera plus jamais affichée. Gardez-la dans un gestionnaire de mots de passe. Ne la collez ni dans GitHub, ni dans un mail, ni dans une conversation.

### B. Créer le compte Cloudflare et mettre le serveur en ligne

1. Allez sur **https://dash.cloudflare.com/sign-up** et créez un compte gratuit. Aucun nom de domaine n'est nécessaire.
2. Dans le menu de gauche, ouvrez **Workers et Pages** (Compute › Workers & Pages). Au premier passage, Cloudflare vous demande de choisir un sous-domaine `workers.dev` : prenez un nom simple, par exemple `maison-albi`.
3. Cliquez sur **Créer** (Create), puis **Importer un dépôt** (Import a repository).
4. Cliquez sur **Connecter GitHub**, autorisez l'application Cloudflare, et donnez-lui accès au seul dépôt `dashboard-maison`.
5. Choisissez le dépôt `dashboard-maison`, puis réglez :
   - **Nom du projet** : `assistant-dashboard-maison`
   - **Branche de production** : `main`
   - **Répertoire racine / Chemin** (Root directory, dans les paramètres avancés) : `serveur`
   - **Commande de build** : laisser vide
   - **Commande de déploiement** : `npx wrangler deploy`
6. Cliquez sur **Créer et déployer**. Attendez la fin du déploiement (une à deux minutes).

Remarque : ce code se trouve pour l'instant sur la branche `claude/brave-lovelace-r5ymqo`. Fusionnez-la dans `main` avant l'étape 6, ou choisissez cette branche au point 5.

### C. Donner la clé au serveur

1. Dans Cloudflare, ouvrez le Worker `assistant-dashboard-maison`, onglet **Paramètres** (Settings), section **Variables et secrets**.
2. Cliquez sur **Ajouter** :
   - **Type** : `Secret` (et non « Texte » : le secret est chiffré et ne se relit pas)
   - **Nom** : `ANTHROPIC_API_KEY`
   - **Valeur** : collez la clé `sk-ant-…`
3. Cliquez sur **Déployer** (Deploy) pour enregistrer.

Les deux autres réglages, `ORIGINES_AUTORISEES` et `MODELE`, ne sont pas secrets : ils sont dans `wrangler.jsonc` et se remettent à jour à chaque déploiement.

### D. Relier le dashboard au serveur

1. Dans Cloudflare, sur la page du Worker, copiez son adresse, de la forme `https://assistant-dashboard-maison.maison-albi.workers.dev`.
2. Ouvrez le dashboard sur le PC, onglet **Réglages**, carte **Assistant**.
3. Collez l'adresse **en ajoutant `/assistant` à la fin**, puis touchez **Enregistrer et tester**.
4. Le message « Serveur joignable » doit s'afficher avec une courte réponse de l'IA.

L'adresse est gardée dans ce navigateur seulement, comme vos autres données. Elle n'est pas un secret.

### E. Essayer

Touchez l'avatar et posez une question libre, par exemple « Combien de temps faut-il pour que le béton sèche ? », puis « Et s'il pleut ? ». La deuxième réponse doit tenir compte de la première.

## Sécurité à cette étape

- Le serveur n'accepte que les appels venant de `https://sobhielmarouani-collab.github.io`. Un autre site web ne peut donc pas s'en servir depuis un navigateur.
- Ce contrôle ne bloque pas un programme qui imiterait cette origine. La vraie protection (connexion Google et liste d'adresses autorisées) arrive à l'**étape 2**. D'ici là, **la limite de dépense du point A.3 est votre garde-fou**. Si vous préférez, laissez l'adresse du serveur vide dans les Réglages et ne la renseignez qu'après l'étape 2.
- Si vous pensez que la clé a fuité : platform.claude.com › API Keys › supprimez-la, créez-en une nouvelle et remplacez le secret dans Cloudflare.

## Coût

- **Cloudflare Workers, offre gratuite** : largement suffisante pour un usage familial (de l'ordre de 100 000 requêtes par jour). L'attente de la réponse de l'IA ne compte pas dans le temps de calcul facturé.
- **API Anthropic**, facturée à l'usage. Le serveur utilise **Claude Opus 5.5** (`claude-opus-5-5`, 4 $ par million de jetons en entrée, 20 $ en sortie, tarifs vérifiés le 24 novembre 2026 sur platform.claude.com). Une question courte avec un peu d'historique coûte de l'ordre d'un centime.
- Pour dépenser moins, changez `MODELE` dans `wrangler.jsonc` : `claude-sonnet-5-5` (2 $ et 10 $) ou `claude-haiku-5-5` (à partir de 0,10 $ et 0,50 $), au prix de réponses moins fines. Le changement s'applique au déploiement suivant.

## Pour un développeur

```bash
cd serveur
npm install
cp .dev.vars.example .dev.vars   # puis mettre une vraie clé dans .dev.vars (ignoré par git)
npx wrangler dev                 # serveur local sur http://localhost:8787/assistant
```

Requête d'essai :

```bash
curl -X POST http://localhost:8787/assistant -H 'Origin: http://localhost:8000' -H 'Content-Type: application/json' -d '{"phrase":"Bonjour"}'
```

Réponses du point d'entrée `POST /assistant` :

| Code | Corps | Cas |
|---|---|---|
| 200 | `{ "reponse": "…" }` | réponse du modèle |
| 400 / 413 | `{ "erreur": "…" }` | phrase vide, JSON invalide, phrase trop longue |
| 403 | `{ "erreur": "Origine non autorisée." }` | appel depuis un site non autorisé |
| 502 / 503 / 500 | `{ "erreur": "…" }` | clé refusée, IA injoignable, limite de débit ; détail dans les journaux Cloudflare |
