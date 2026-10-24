# Bot Discord — Annonces & Sondages de Sessions JDR

Bot Discord affichant en permanence un **Méga-Dashboard visuel** (généré en PNG) de toutes les tables de JDR actives, avec gestion des joueurs par `@Rôle` Discord et sondages hebdomadaires automatisés.

## Configuration

1. Créez une application sur le [Portail Développeur Discord](https://discord.com/developers/applications).
2. Dans l'onglet **Bot** :
   - Activez **Server Members Intent** (indispensable pour que le bot récupère automatiquement les joueurs appartenant au `@Rôle` de chaque JDR).
   - Copiez le **Token** du bot.
3. Dupliquez le fichier `.env.example` en `.env` et collez votre token :
   ```env
   DISCORD_TOKEN=votre_token_ici
   GUILD_ID=id_de_votre_serveur_discord
   ```
4. Invitez le bot sur votre serveur avec les scopes `bot` et `applications.commands` (permissions : *Voir les salons*, *Envoyer des messages*, *Joindre des fichiers*, *Gérer les messages*, *Mentionner @everyone, @here et tous les rôles*, *Gérer les événements* pour la création automatique des événements Discord).
5. Lancez le bot :
   ```bash
   npm start
   ```

## Commandes

- `/jdr salon salon:#prochaines-sessions` : Définit le salon où le tableau permanent est affiché.
- `/jdr creer nom:"L'Odyssée des Dragons" role:@Table-Dragons heure:"21h00" theme:Fantasy banniere:(image optionnelle)` : Crée un JDR lié au rôle indiqué, met à jour l'image et ping le rôle pour ouvrir le sondage.
- `/jdr banniere role:@Table-Dragons image:(nouvelle image)` : Change l'image de fond d'une table.

## Fonctionnement

- **Vote réservé au `@Rôle`** : En sélectionnant une table sous l'image, seuls les membres possédant le `@Rôle` de ce JDR peuvent voter parmi les 7 jours de la semaine ou choisir **`Semaine prochaine`**.
- **Validation automatique** : Dès que tous les membres du `@Rôle` sont disponibles sur un même jour, le bot verrouille automatiquement le premier jour commun et ping le `@Rôle`.
- **Report automatique** : Si un joueur sélectionne **`Semaine prochaine`** (sans attendre les autres) ou si tous ont voté sans aucun jour commun, le sondage passe automatiquement à la semaine suivante et ping le `@Rôle`.
- **Limite de 2 semaines** : Si aucune disponibilité n'est trouvée sur 2 semaines consécutives, la bannière affiche *« Joueurs non disponibles jusqu'au XX. »* et reste en attente jusqu'à ce que le MJ relance le sondage ou définisse une date.
- **Relance après session** : Dès qu'une session confirmée est terminée, le sondage de la semaine suivante se relance automatiquement avec un ping du `@Rôle`.
- **Conflits ciblés par participant** : Deux tables peuvent jouer le même jour tant qu'elles n'ont aucun joueur ni MJ en commun. Dès qu'une personne participe aux deux (joueur ou MJ), le jour est réservé et l'arbitrage automatique (choix préventif, permutation) s'applique.
- **Événements Discord automatiques** : Chaque session confirmée crée un événement Discord natif (rappel natif, visible dans la liste des événements). Il est déplacé si la date ou l'heure change, et supprimé si la date est retirée, la session terminée ou la table supprimée. Nécessite la permission *Gérer les événements*.
- **Relance des retardataires** : Dans l'espace MJ, le bouton **🔔 Relancer les retardataires** mentionne uniquement les joueurs qui n'ont pas encore voté. Une seule relance reste visible à la fois (la précédente est remplacée) avec un délai minimum de 6 h entre deux relances.
- **Compteur d'affluence** : Dans le panneau de vote, chaque jour affiche `(x/N)` : nombre de joueurs disponibles ce jour-là sur le total de la table.
- **Votes simultanés sécurisés** : Les votes et actions MJ d'un même serveur sont traités l'un après l'autre (file d'attente), sans perte de vote ni doublon de message.
