# Baskule — kit de marque

Version validée le 25 octobre 2026 : mot-symbole v4, palette 7. Les SVG sont des tracés autonomes, sans police à installer. La géométrie et l’espacement du dessin approuvé sont conservés.

| Couleur | Hex | Usage |
| --- | --- | --- |
| Graphite | `#17181A` | Mot-symbole sur fond clair, fond de l’icône |
| Rouge | `#D90429` | Deux diagonales du K, actions principales |
| Craie | `#F5F1EA` | Fond de présentation, barre du K sur fond sombre, navigation claire |

## Fichiers

- `wordmark.svg` : logo transparent pour fond clair.
- `wordmark-inverse.svg` : logo transparent pour fond sombre.
- `wordmark-on-craie.svg` : présentation avec fond craie inclus, téléchargeable telle quelle.
- `symbol.svg`, `symbol-inverse.svg` : K isolé, sans fond.
- `icon.svg` : icône carrée, K craie et rouge sur graphite. Les masques du système dessinent les coins.
- `../app/assets/baskule/` : exports PNG (16, 32, 180, 192, 512 et 1024 px), ICO multi-résolution, logos PNG et couches Android.
- `kit.html` : planche de référence autonome, ouvrable dans un navigateur.

Le logo s’utilise tel quel : ne pas le recomposer avec du texte, modifier le K, ajouter une ombre ou étirer le dessin. Conserver au moins une demi-hauteur de lettre autour du logo dans les compositions libres. Dans les petites interfaces, utiliser le K seul. Sur un fond sombre, utiliser la version inverse.

La typographie des interfaces existantes est conservée (DM Sans sur mobile et les polices déjà configurées sur le web). Aucun nouveau chargement de police. Les icônes fonctionnelles restent celles du produit ; seul le pictogramme de marque devient le K. Les couleurs d’erreur, de succès et d’avertissement gardent leur rôle.

## Régénérer les exports

Depuis la racine du dépôt :

```sh
source scripts/env.sh
node app/scripts/export-baskule-assets.ts
node app/scripts/export-baskule-assets.ts --check
```

Le générateur utilise Sharp et l’encodeur ICO déjà présents dans `app/scripts`. Il met à jour les assets du web, du client Electron et du mobile, ainsi que l’icône annoncée aux clients MCP. Les hooks de packaging web recopient ces mêmes icônes, y compris pour les canaux de développement et de préversion.

## Surfaces de la marque

| Surface | Points remplacés |
| --- | --- |
| Web public | Connexion, invitation, réinitialisation du mot de passe, connexion d’un appareil, titre d’onglet, écran de chargement et erreur de démarrage |
| Web connecté | Logo de la barre latérale et du tiroir mobile, auteur des réponses, champ « Message Baskule », libellés de téléchargement et aide à la connexion des appareils |
| Outils | K dans les lignes d’activité et de création de discussion ; nom et icône du serveur MCP |
| Installation web | Favicon SVG et ICO, favicons PNG, icône Apple, manifeste et icônes installables 192/512 px |
| Electron livré (`desktop/`) | Nom de l’application, menus natifs, fenêtre, page de connexion hors ligne, icône de lancement, nom de l’exécutable et des fichiers distribués |
| Mobile livré (`app/apps/mobile/`) | Noms des variantes, logo de connexion et d’en-tête, page À propos, activité des outils, icônes iOS/Android, splash, notification et autorisations natives traduites |
| Plateforme | Nom d’authentification, nom de découverte par défaut, nouvelle organisation par défaut, page d’approbation native, liste de téléchargements, identité de l’assistant |
| Langues | Clés et traductions du nom mises à jour en français, anglais, espagnol, allemand, néerlandais et italien |
| Liens d’application | `baskule://`, `baskule-dev://`, `baskule-preview://` ; génération web et parseurs natifs mis à jour ensemble |

## Identifiants techniques

Le dépôt public cible est `baskule/baskule`. Les types `Baskule*`, variables `BASKULE_*`, routes `/api/baskule`, découverte `/.well-known/baskule`, marqueur de protocole `product: "baskule"`, clés de stockage, cookies et identifiants natifs `dev.baskule.*` utilisent la même identité. Les noms des dépendances et composants natifs T3 ainsi que le nom OpenShell sont conservés.

Les archives de développement restent dans la sauvegarde privée. Les crédits, licences et notices de T3 Code, OpenShell et des autres dépendances sont conservés. Les assets amont qui ne sont pas utilisés pour distribuer Baskule restent identifiés comme tels.

## Livraison

Cette préparation est locale et ne déploie rien. Le répertoire du projet et les conversations des outils de développement restent en place. La livraison ultérieure exige de reconstruire les clients et de suivre les instructions d'installation alpha. Les nouvelles identités de protocole et d'application exigent une reconnexion ou une réinstallation des anciens clients ; aucune compatibilité avec les anciens identifiants n'est fournie. Un éventuel effacement des données alpha appartient au plan de déploiement, pas à la migration du dépôt.
