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
| `Souris (clic sur le canvas)` | Capturer la souris — pivoter la caméra (prédiction locale, 0 latence) |
| `Clic gauche` | Miner le bloc visé (contour noir = ciblage, fissures = progression) |
| `Clic droit` | Poser le bloc tenu contre la face visée / utiliser l'item |
| `Molette` / `1`-`9` | Sélectionner un slot de la hotbar (chrome + sélection vanilla) |
| `E` | **Inventaire** — panneau vanilla 3x (grille 27 + hotbar) + **onglet Craft** (V1.2.0), déplace les items par 2 clics |
| `R` | **Recharger les chunks** — vide le cache client (meshes + données) et le set serveur, puis re-scanne tout depuis zéro (fix des blocs fantômes) |
| `F5` | **Changer de vue** — 1re ⇄ 3e personne (V1.2.0 : le perso steve animé devient visible) |
| `Échap` | Relâcher la souris (stoppe le mouvement) |
| `T` ou `/` | Ouvrir le chat (`Entrée` envoie, `Échap` annule) |

**Minage continu (V1.2.0)** : maintenir le clic gauche enchaîne les blocs comme vanilla ;
relâcher **annule** le minage en cours (fissures retirées, `bot.stopDigging`). Un clic gauche
sur un **mob** le frappe (`bot.attack`) — portée 2.5 blocs.

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
| `ALLOW_PRIVATE_SERVERS` | `0` | ⚠️ Autoriser les serveurs Minecraft sur des adresses privées (développement local uniquement) |

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

## Sécurité (V1.1.3)

Le serveur relayaît aveuglément les requêtes `connect` vers n'importe quel host:port
(un **pivot SSRF** vers votre LAN / le metadata cloud). Durcissements appliqués :

- **SSRF bloqué** : les serveurs Minecraft cibles doivent résoudre vers une adresse
  **publique** — localhost, RFC1918 (10/172.16/192.168), link-local, CGNAT,
  multicast, IPv6 ULA et `169.254.169.254` (metadata AWS/GCP) sont refusés.
  Hostnames : toutes les adresses A/AAAA sont vérifiées. (`ALLOW_PRIVATE_SERVERS=1`
  pour le dev local uniquement.)
- **Payload WS borné** (`maxPayload` 64 KB) : la valeur par défaut de `ws` (512 Mo)
  permettait à un seul client d'OOMer le serveur.
- **Rate limiting par socket** (token bucket : rafale 60, recharge 30/s) : le flood
  de messages `dig`/`place`/`look` n'épuise plus le CPU ; le client légitime
  (~25 msg/s max) ne le déclenche jamais.
- **CSWSH** : les handshakes WebSocket cross-origin sont rejetés (Origin ≠ Host).
- **Headers de sécurité** sur chaque réponse : CSP stricte (`default-src 'self'`,
  `object-src 'none'`), `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`.
- **Validation d'entrée** : `host` limité à `[a-zA-Z0-9._-]` (pas de scheme/userinfo),
  `req.query.v` de `/blocks.json` validé (regex version + cache borné), messages WS
  non-objets ignorés.
- **Contenus non fiables bornés** (le serveur Minecraft cible peut être hostile) :
  noms d'items (`[a-z0-9_]{1,64}`, filtrés côté serveur **et** client), chat
  (64/512 chars), noms d'entités (64) — défense en profondeur.
- **XSS corrigé** dans le menu : rendu par `textContent`/`dataset` (l'ancien
  template interpolait `port` et `data-id` sans échappement et crashait sur les
  noms vides).

## Architecture

```
server/
  index.js         Express (static + /atlas.png + /blocks.json + /items.png + /gui) + WebSocket /ws
  config.js        Configuration (env vars)
  security.js      SSRF guard, rate limiter, security headers (V1.1.3)
  botManager.js    File d'attente + cycle de vie des bots Mineflayer
  worldStreamer.js Culling des faces visibles + sérialisation binaire + deflate + tint biome
  resourcePack.js  Atlas de textures (pack vanilla ou procédural) + atlas d'items + HUD + GUI
  entityModels.js  Modèles 3D style vanilla des mobs (parts + UV 64x64 + textures)
public/
  js/net.js        Client WebSocket (JSON + binaire + DecompressionStream)
  js/chunkCodec.js Décodeur du format binaire des chunks (v1 & v2 tint)
  js/voxelRaycast.js Raycast DDA voxel (ciblage des blocs — testé unitairement)
  js/menu.js       Liste des serveurs (localStorage) + formulaire
  js/game.js       Contrôles clavier/souris, HUD, chat, hotbar vanilla, inventaire
  js/renderer.js   Rendu Three.js : chunks tintés, entités modélisées, caméra, main, minage
  js/main.js       Orchestration des écrans et du câblage
test/
  streamer.test.js Test unitaire du culling/streaming + codec client + tint biome
  raycast.test.js  Test unitaire du raycast DDA (ciblage, faces, transparence)
  queue.test.js    Test unitaire de la file d'attente
  security.test.js Test unitaire du durcissement (SSRF, rate limiter, validation)
  e2e.js           Test E2E WebSocket → bot Mineflayer → streaming
```

## Tests

```bash
node test/streamer.test.js   # culling + sérialisation binaire + codec client (aucun serveur nécessaire)
node test/raycast.test.js    # raycast DDA : faces, blocs transparents, portée
node test/queue.test.js      # file d'attente et promotion
node test/security.test.js   # SSRF, rate limiter, validation des entrées
node test/bench.streamer.js  # benchmark du scan de chunks (ms/chunk)
node test/e2e.js [host] [port]  # bout-en-bout contre un serveur Minecraft
```

## Limitations connues

- Connexion **offline-mode** uniquement (pas d'auth Mojang).
- Mobs rendus avec des **modèles 3D style vanilla** (zombie, creeper, skeleton,
  spider, enderman, pig, cow, sheep, chicken, villager… 19 mobs + **joueur steve**
  en vue 3e personne) — les autres entités restent des boîtes colorées. Animation
  de marche des membres (bras/jambes en opposition de phase).
- Inventaire : déplacement d'items par paires de clics (pas de drag & drop continu),
  pas d'armure — v1.3. Le minage affiche les fissures vanilla et **peut être
  annulé** en relâchant le clic.
- Craft (V1.2.0) : recettes automatiques via `bot.recipesFor` (l'inventaire
  suffit ; les recettes 3x3 demandent une table à ≤4 blocs, auto-détectée).
- Icônes des blocs : rendu **isométrique 3D** serveur (`/icon3d/nom.png`, tint
  biome plains pour l'herbe/feuilles) — fallback atlas d'items.
- Un bot par onglet navigateur.
- Versions supportées : celles de Mineflayer (1.8 → 1.21.x, 1.21.10 inclus).
