# Eaglercraft : Connected Client

Un client Minecraft jouable **dans le navigateur** : le serveur Node.js lance un bot
[Mineflayer](https://github.com/PrismarineJS/mineflayer) sur le serveur Minecraft cible et
streame **blocs, entités et événements** au client web (Three.js) qui affiche le monde en 3D.

```
Navigateur (Three.js)  ⇄  WebSocket (ws)  ⇄  Serveur Node.js  ⇄  Bot Mineflayer  ⇄  Serveur Minecraft
```

## Démarrage rapide

```bash
npm install
npm start
# Ouvrir http://localhost:3000
```

Depuis le menu : entre un pseudo, ajoute un serveur (nom, adresse, port), clique **Rejoindre**.
La page passe au rendu 3D dès que le bot est connecté.

> ⚠️ **Le serveur Minecraft cible doit être en mode offline/cracked** (`online-mode=false`
> dans `server.properties`). Le bot n'a pas d'authentification Mojang : un serveur en
> online-mode le kick avec `multiplayer.disconnect.unverified_username`.

## Contrôles

| Touche (AZERTY / QWERTY) | Action |
|---|---|
| `Z`/`W` `S` `Q`/`A` `D` | Déplacements (détection physique des deux layouts) |
| `Espace` | Sauter |
| `Shift` | S'accroupir (sneak) — la caméra descend à 1.27 (lissée) |
| `Ctrl` | Sprinter — la caméra s'élargit (FOV 70° → 77°) |
| Souris (clic sur le canvas) | Capturer la souris — pivoter la caméra (prédiction locale, 0 latence) |
| `Échap` | Relâcher la souris (stoppe le mouvement) |
| `T` ou `/` | Ouvrir le chat (`Entrée` envoie, `Échap` annule) |

## Configuration (variables d'environnement)

Pensée pour un petit serveur (1 core / 2.5 Go RAM) — valeurs par défaut prudentes :

| Variable | Défaut | Description |
|---|---|---|
| `PORT` | `3000` | Port HTTP/WS |
| `MAX_CONCURRENT_BOTS` | `2` | Bots Mineflayer simultanés |
| `MAX_QUEUE_SIZE` | `8` | Clients en file d'attente max |
| `QUEUE_TIMEOUT_MS` | `600000` | Attente max en file avant abandon |
| `RENDER_DISTANCE` | `4` | Chunks streamés autour du bot |
| `CHUNK_SCAN_RATE` | `30` | Chunks/s envoyés à un client (CPU) |
| `DRAIN_BUDGET_MS` | `8` | Budget CPU (ms) par tick de streaming |
| `CHUNK_SEND_RATE` | — | *(réservé)* |
| `MAX_BUFFERED_BYTES` | `4194304` | Backpressure : pause si le socket client sature |
| `RESOURCE_PACK_PATH` | auto (`./resourcepack`) | Pack de ressources vanilla **extrait** (optionnel) |

### File d'attente

Au-delà de `MAX_CONCURRENT_BOTS` connexions simultanées, les nouveaux clients sont mis en
file (position affichée à l'écran) et promus dès qu'un slot se libère. Les demandes au-delà
de `MAX_QUEUE_SIZE` sont rejetées immédiatement.

## Pack de ressources (textures vanilla)

Le serveur génère un **atlas de textures** au démarrage :

1. **Téléchargement automatique** : si aucun pack n'est présent, le serveur télécharge le pack
   de ressources vanilla (URL configurable via `RESOURCE_PACK_URL`) et extrait blockstates,
   models, textures de blocs et sprites HUD au premier boot.
2. Si un pack est présent (`RESOURCE_PACK_PATH` ou dossier `./resourcepack`), il est utilisé
   directement (l'ancien dossier `./ressourcepack` — faute de frappe — est aussi accepté).
3. Sans pack et sans réseau, un atlas **procédural** (couleurs + bruit par bloc) est généré —
   le client fonctionne sans aucun asset.

**Résolution des textures vanilla (V1.0.2)** : les textures sont résolues via le vrai pipeline
Minecraft — `blockstates/*.json` → `models/block/*.json` → textures (avec héritage des
modèles parents, références `#texture`, et le nouveau format 1.21.2+ `{"sprite": ...}`).
Résultat : ~93 % des blocs ont leur vraie texture au lieu de ~50 % avant.

**HUD texturé (V1.0.2)** : les cœurs et la barre de faim utilisent les sprites vanilla du pack
(`/hud.png` + `/hud.json`), avec support des demi-cœurs. Fallback emoji si le pack est absent.

Pour utiliser les textures vanilla manuellement : extrais le jar (`unzip client.jar assets/` — les
textures Mojang ne sont pas redistribuables, fais-le localement) et place le dossier
`assets/...` dans `./resourcepack/`.

## Optimisations réseau

- **Seuls les blocs visibles sont envoyés** : un bloc n'est transmis que s'il touche de
  l'air/transparent, avec un **masque 6 bits** des faces exposées (~7 octets/bloc avant
  compression). Les blocs enterrés ne quittent jamais le serveur.
- **Bordures de chunks** : quand un chunk voisin charge, les 4 voisins déjà envoyés sont
  rescannés pour corriger les faces devenues cachées.
- **Deflate** (zlib niveau 1) sur chaque chunk : ~75 % de taille en moins, compression quasi-instantanée.
- **Mises à jour de blocs** : patch incrémental batché (bloc + 6 voisins en 1 message) sans re-scan complet.
- **Backpressure** : le streaming se met en pause si le socket du navigateur sature.
- **Entités** : mouvements batchés (1 message / 100 ms) puis interpolés côté client.

## Optimisations V1.0.1 (performances)

Serveur :
- **Lecture directe des sections** : chaque section 16×16×16 est aplatie en `Uint32Array`
  (extraction de bits inline) au lieu d'un appel `getBlockStateId()` par bloc — scan
  ~2× plus rapide, zéro allocation d'objets position.
- **Sections vides ignorées** (`solidBlockCount === 0`) : 60–80 % d'une colonne réelle
  n'est jamais lue.
- **Tables précalculées** stateId → blockId / skip / visible (typées) : une lecture
  tableau par voisin au lieu de lookups Map + Set.
- **Drain budget CPU** : autant de chunks que possible dans 8 ms/tick (au lieu d'1
  chunk/50 ms), file dédupliquée.
- **Mises à jour de blocs batchées** (7 positions → 1 message JSON), sans allocation
  de `Block`/`Vec3` (usage : `world.getBlockStateId` + pos réutilisée).

Client :
- **Antialias OFF + pixelRatio ≤ 1.5** : gros gain GPU (~40 % de pixels en moins sur
  écran hidpi), textures voxel pixelisées qui le masquent bien.
- **Géométrie par chunk** : constantes de faces hors boucle, UV rects et infos bloc
  cachés (Map) — build quasi sans allocation temporaire.
- **Rebuilds budgetés** : les chunks modifiés sont reconstruits dans un budget de
  6 ms/frame — plus de freezes sur les éditions de monde.
- **Index O(1)** des blocs par chunk pour les patches (l'ancien `findIndex`
  parcourait ~30k entrées par bloc modifié).
- **HUD throttlé** (cœurs, debug) : le DOM n'est touché que sur changement réel.
- **Réseau client économe** : contrôle/look envoyés seulement quand ils changent ;
  entités interpolées localement à 60 fps.
- **Fuite GPU corrigée** : geometry/material/texture des entités supprimées sont
  désormais `dispose()`.

## Architecture

```
server/
  index.js         Express (static + /atlas.png + /blocks.json) + WebSocket /ws
  config.js        Configuration (env vars)
  botManager.js    File d'attente + cycle de vie des bots Mineflayer
  worldStreamer.js Culling des faces visibles + sérialisation binaire + deflate
  resourcePack.js  Atlas de textures (pack vanilla ou procédural)
public/
  js/net.js        Client WebSocket (JSON + binaire + DecompressionStream)
  js/chunkCodec.js Décodeur du format binaire des chunks
  js/menu.js       Liste des serveurs (localStorage) + formulaire
  js/game.js       Contrôles clavier/souris, HUD, chat
  js/renderer.js   Rendu Three.js : chunks, entités, caméra
  js/main.js       Orchestration des écrans et du câblage
test/
  streamer.test.js Test unitaire du culling/streaming (sans serveur MC)
  queue.test.js    Test unitaire de la file d'attente
  e2e.js           Test E2E WebSocket → bot Mineflayer → streaming
```

## Tests

```bash
node test/streamer.test.js   # culling + sérialisation binaire (aucun serveur nécessaire)
node test/queue.test.js      # file d'attente et promotion
node test/bench.streamer.js  # benchmark du scan de chunks (ms/chunk)
node test/e2e.js [host] [port]  # bout-en-bout contre un serveur Minecraft
```

## Limitations connues

- Connexion **offline-mode** uniquement (pas d'auth Mojang).
- Entités rendues en boîtes colorées + nametags (pas de skins/models animés) — v1.
- Pas d'inventaire interactif, pas de minage/pose de blocs — v1.
- Un bot par onglet navigateur.
- Versions supportées : celles de Mineflayer (1.8 → 1.21.x, 1.21.10 inclus).
