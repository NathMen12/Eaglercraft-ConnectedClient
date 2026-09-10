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
| `Shift` | S'accroupir (sneak) |
| `Ctrl` | Sprinter |
| Souris (clic sur le canvas) | Capturer la souris — pivoter la caméra |
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
| `CHUNK_SCAN_RATE` | `8` | Chunks/s envoyés à un client (CPU) |
| `CHUNK_SEND_RATE` | — | *(réservé)* |
| `MAX_BUFFERED_BYTES` | `4194304` | Backpressure : pause si le socket client sature |
| `RESOURCE_PACK_PATH` | auto (`./resourcepack`) | Pack de ressources vanilla **extrait** (optionnel) |

### File d'attente

Au-delà de `MAX_CONCURRENT_BOTS` connexions simultanées, les nouveaux clients sont mis en
file (position affichée à l'écran) et promus dès qu'un slot se libère. Les demandes au-delà
de `MAX_QUEUE_SIZE` sont rejetées immédiatement.

## Pack de ressources (textures vanilla)

Le serveur génère un **atlas de textures** au démarrage :

1. Si un pack est présent (`RESOURCE_PACK_PATH` ou dossier `./resourcepack`), extrait les
   textures `assets/minecraft/textures/block/*.png` et les assemble dans un atlas PNG
   servi sur `/atlas.png`.
2. Sans pack, un atlas **procédural** (couleurs + bruit par bloc) est généré — le client
   fonctionne sans aucun asset.

Pour utiliser les textures vanilla : extrais le jar (`unzip client.jar assets/` — les
textures Mojang ne sont pas redistribuables, fais-le localement) et place le dossier
`assets/...` dans `./resourcepack/`.

## Optimisations réseau

- **Seuls les blocs visibles sont envoyés** : un bloc n'est transmis que s'il touche de
  l'air/transparent, avec un **masque 6 bits** des faces exposées (~7 octets/bloc avant
  compression). Les blocs enterrés ne quittent jamais le serveur.
- **Bordures de chunks** : quand un chunk voisin charge, les 4 voisins déjà envoyés sont
  rescannés pour corriger les faces devenues cachées.
- **Deflate** (zlib) sur chaque chunk : ~75 % de taille en moins.
- **Mises à jour de blocs** : patch incrémental (bloc + 6 voisins) sans re-scan complet.
- **Backpressure** : le streaming se met en pause si le socket du navigateur sature.

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
node test/e2e.js [host] [port]  # bout-en-bout contre un serveur Minecraft
```

## Limitations connues

- Connexion **offline-mode** uniquement (pas d'auth Mojang).
- Entités rendues en boîtes colorées + nametags (pas de skins/models animés) — v1.
- Pas d'inventaire interactif, pas de minage/pose de blocs — v1.
- Un bot par onglet navigateur.
- Versions supportées : celles de Mineflayer (1.8 → 1.21.x, 1.21.10 inclus).
