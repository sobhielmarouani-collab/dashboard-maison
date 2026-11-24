# Assistant vocal du dashboard — plan et cahier des charges

Document de travail pour Claude Code. Il décrit ce qu'il faut construire pour que l'avatar du dashboard devienne un assistant à qui l'on parle librement.

## 1. Objectif

Sur le PC, l'utilisateur clique sur l'avatar, parle en français, et l'assistant :

1. lit son agenda Google ;
2. rédige et envoie un mail depuis Gmail, après validation ;
3. donne les actualités, générales et du BTP ;
4. lance de la musique ;
5. ouvre WhatsApp sur un contact pour un appel ou un message ;
6. répond à toute autre question en conversation libre ;
7. pilote le dashboard (tâches, chantiers, minuteur, onglets), comme aujourd'hui.

L'assistant répond à voix haute et affiche sa réponse sous l'avatar.

## 2. Point de départ

- Dépôt : `sobhielmarouani-collab/dashboard-maison`, publié par GitHub Pages.
- `index.html` : page unique, sans dépendance, données dans `localStorage`.
- L'avatar (`#ia`) gère déjà l'écoute (`SpeechRecognition`), la parole (`speechSynthesis`), les états visuels `ecoute` et `parle`, et une fonction `comprendre(phrase)` qui reconnaît des ordres fixes.
- Ce qui change : `comprendre()` appelle un serveur au lieu d'analyser la phrase sur place. Les ordres fixes actuels restent en repli si le serveur ne répond pas.

## 3. Contraintes à respecter

- **Aucun secret dans ce dépôt.** Il est public. Clé d'IA, identifiants Google et jetons restent sur le serveur, dans ses variables d'environnement.
- **Accès réservé.** L'adresse du dashboard est publique. Le serveur n'accepte que les requêtes d'un utilisateur connecté et figurant dans une liste d'adresses autorisées.
- **Validation avant toute action visible de l'extérieur.** Un mail n'est jamais envoyé sans que l'utilisateur ait vu le destinataire, l'objet et le texte, puis confirmé.
- **Echo Show.** Le navigateur Silk refuse le micro aux sites web. Sur cet appareil, l'assistant se limite au toucher et au résumé du jour. Ne pas chercher à contourner.
- **WhatsApp.** Aucun programme ne peut lancer un appel WhatsApp à la place de l'utilisateur. L'assistant ouvre la conversation du contact ; l'utilisateur appuie lui-même sur le bouton d'appel.

## 4. Architecture

```
Dashboard (GitHub Pages)  ──HTTPS──>  Serveur privé  ──>  API d'IA (modèle Claude)
  micro, voix, affichage               garde les secrets ──>  Google Agenda et Gmail
                                       exécute les outils ──>  Flux d'actualités (RSS)
```

- **Dashboard** : capte la voix, envoie le texte reconnu au serveur, lit la réponse, exécute les actions locales que le serveur lui renvoie (ouvrir un lien, lancer une radio, ajouter une tâche).
- **Serveur** : une petite fonction hébergée (Cloudflare Workers, Vercel ou équivalent). Il reçoit la phrase, appelle le modèle d'IA avec une liste d'outils, exécute les outils demandés, renvoie la réponse.
- **Modèle d'IA** : un modèle Claude via l'API Anthropic, en mode « utilisation d'outils ». Vérifier les modèles et tarifs en vigueur sur docs.claude.com avant de coder.

## 5. Outils que le modèle peut appeler

| Outil | Exécuté par | Rôle |
|---|---|---|
| `lire_agenda(debut, fin)` | serveur | Événements Google Agenda sur la période |
| `creer_evenement(titre, debut, fin)` | serveur | Ajoute un événement, après confirmation |
| `preparer_mail(destinataire, objet, texte)` | serveur | Crée un brouillon et le renvoie pour validation |
| `envoyer_mail(id_brouillon)` | serveur | Envoie le brouillon validé |
| `lire_actualites(rubrique)` | serveur | Titres récents d'un flux RSS |
| `lancer_musique(station)` | dashboard | Joue une radio en ligne dans la page |
| `arreter_musique()` | dashboard | Coupe la lecture |
| `ouvrir_whatsapp(contact)` | dashboard | Ouvre `https://wa.me/<numéro>` du contact |
| `action_dashboard(type, donnees)` | dashboard | Tâche, chantier, minuteur, changement d'onglet |

Les contacts WhatsApp et leurs numéros sont saisis dans l'onglet Réglages et restent dans le navigateur ; ils ne vont ni dans le dépôt ni sur le serveur.

## 6. Étapes de réalisation

Chaque étape est livrable et testable seule.

1. **Serveur et conversation libre.** Fonction hébergée, point d'entrée `POST /assistant`, appel au modèle, réponse en texte. Côté page : `comprendre()` appelle le serveur ; repli sur les ordres fixes en cas d'échec.
2. **Connexion et accès réservé.** Connexion Google sur le dashboard, session côté serveur, liste d'adresses autorisées, limite de requêtes par heure.
3. **Actions du dashboard.** Outil `action_dashboard` : les ordres actuels passent par l'IA et acceptent des formulations libres.
4. **Agenda Google.** Autorisation en lecture, outil `lire_agenda`. L'onglet Agenda affiche les vrais événements.
5. **Mail.** Autorisation d'envoi, brouillon, écran de validation dans la page, envoi.
6. **Actualités.** Liste de flux RSS configurables, outil `lire_actualites`, lecture à voix haute des titres.
7. **Musique.** Lecteur audio dans la page, quelques radios en ligne, commandes lecture, arrêt, volume. Spotify ou Deezer seulement si demandé ensuite.
8. **WhatsApp.** Carnet de contacts dans Réglages, outil `ouvrir_whatsapp`.

## 7. Critères d'acceptation

- « Qu'est-ce que j'ai demain ? » lit les événements du vrai agenda Google.
- « Écris à X pour décaler la réunion à jeudi » affiche un brouillon ; rien ne part sans confirmation.
- « Donne-moi les infos » lit au moins cinq titres datés du jour.
- « Mets de la musique », puis « arrête la musique », fonctionnent sans toucher l'écran.
- « Appelle X sur WhatsApp » ouvre la bonne conversation.
- Une personne non autorisée qui ouvre le dashboard n'obtient aucune réponse du serveur.
- Serveur coupé : le dashboard fonctionne comme aujourd'hui.
- Sur l'Echo Show : aucun message d'erreur, le toucher et le résumé du jour restent disponibles.

## 8. Ce que l'utilisateur doit fournir

- Une clé d'API Anthropic, facturée à l'usage.
- Un compte chez l'hébergeur du serveur.
- Un projet Google Cloud avec les API Agenda et Gmail activées et un écran de consentement, pour autoriser l'accès à son propre compte.
- La liste des radios et des flux d'actualités souhaités.

## 9. Hors périmètre

- Écoute permanente sans cliquer (mot d'éveil).
- Appel WhatsApp lancé automatiquement.
- Commande vocale sur l'Echo Show.
- Pilotage réel des lumières, volets et chauffage : sujet séparé, qui dépend du système domotique installé.
