# Vite WP Bundler

Bundler Vite.js moderne pour WordPress avec HMR (Hot Module Replacement) intelligent et injection à la volée.

## Quick Start

```bash
# 1. Installation
npm install

# 2. Configuration
cp .env
# Éditer .env et définir THEME_NAME=votre-theme

# 3. Développement
npm run dev

# 4. Build production
npm run build
```

Le bundler détecte automatiquement vos assets depuis `functions.php`, génère un MU-plugin WordPress pour l'injection HMR, et ouvre votre site WordPress dans le navigateur.

---

## Table des matières

- [Fonctionnalités](#fonctionnalités)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Développement](#développement)
- [Build Production](#build-production)
- [HMR Avancé](#hmr-avancé)
- [Structure des fichiers](#structure-des-fichiers)
- [Plugins Vite](#plugins-vite)
- [Troubleshooting](#troubleshooting)

---

## Fonctionnalités

### Core
- **Auto-détection des assets** : Scanne `functions.php` par défaut pour détecter automatiquement les JS/SCSS enregistrés
- **HMR intelligent sur JS (optionnel)** : Reload du body sans rechargement de page sur changement Javascript
- **Watch PHP (optionnel)** : Rechargement automatique du navigateur lors de modifications PHP
- **Near Zero Config** : Détection automatique de l'environnement WordPress (MAMP, XAMPP, Local, etc.). uniquement dossier du thème à préciser dans le .env.

### HMR Body Reset Custom sur JS (optionnel):
- **Reset DOM** : Réinitialisation du `<body>` sans rechargement de page sur changements JS
- **Préservation du scroll** : Maintient la position de scroll pendant le HMR
- **Cleanup automatique** : Nettoyage des event listeners pour éviter les fuites mémoire
- **Mode désactivable** : `HMR_BODY_RESET=false` pour utiliser le HMR natif de Vite

### Build
- **Minification intelligente** : `.min.js` et `.min.css` avec esbuild (rapide)
- **Structure préservée** : Détection automatique de la structure (plate ou sous-dossiers)
- **Sans hash** : Noms de fichiers stables pour WordPress
- **Libs externes** : Support des librairies minifiées non bundlées

---

## Architecture

```
vite-WP-bundler-main/
├── .env                      # Configuration environnement
├── vite.config.js            # Configuration Vite
├── paths.config.js           # Chemins auto-détectés
├── plugins/                  # Plugins Vite personnalisés
│   ├── generate-mu-plugin.js              # Génération MU-plugin WordPress
│   ├── wordpress-assets-detector.plugin.js # Détection assets depuis functions.php
│   ├── accept-all-hmr.plugin.js           # Injection HMR automatique
│   ├── php-reload.plugin.js               # Rechargement PHP
│   ├── port-killer.plugin.js              # Libération port Vite
│   ├── cleanup-mu-plugin.plugin.js        # Nettoyage au shutdown
│   ├── postcss-url-rewrite.plugin.js      # Réécriture URLs CSS
│   ├── cache-manager.plugin.js            # Cache des assets détectés
│   └── sass-glob-import.plugin.js         # Support @import "*.scss"
└── scripts/
    ├── dev-parallel.js       # Script de démarrage dev
    └── hmr-body-reset.js     # Client HMR pour reset DOM
```

### Workflow

**Mode développement** :
1. `npm run dev` → Lance Vite via `scripts/dev-parallel.js`
2. Plugin `generate-mu-plugin.js` :
   - Détecte les assets depuis `functions.php`
   - Génère `wp-content/mu-plugins/vite-dev-mode.php`
   - Ouvre le navigateur WordPress
3. Le MU-plugin injecte :
   - Client Vite (`@vite/client`)
   - Script HMR Body Reset (si `HMR_BODY_RESET=true`)
   - Assets sources (JS/SCSS) via serveur Vite
4. Vite sert les assets avec HMR actif

**Mode production** :
1. `npm run build` → Build Vite
2. Plugin `wordpress-assets-detector` détecte la structure
3. Rollup génère les `.min.js` et `.min.css`
4. WordPress charge les assets buildés (pas de Vite)

---

## Configuration

### `.env`

```bash
# ===================================================================
# THÈME
# ===================================================================
THEME_NAME=themezero           # Nom du thème WordPress à bundler

# ===================================================================
# OPTIONS
# ===================================================================
WATCH_PHP=true                 # Rechargement auto sur changements PHP
HMR_BODY_RESET=true           # HMR avec reset DOM (false = HMR natif Vite)

# ===================================================================
# SERVEURS (auto-détectés par défaut)
# ===================================================================
VITE_HOST=localhost
VITE_PORT=5173

WP_HOST=localhost
WP_PROTOCOL=http
WP_PORT=80

# ===================================================================
# AVANCÉ (optionnel)
# ===================================================================
# WEB_ROOT_FOLDER=htdocs       # Dossier racine web (défaut: htdocs)
# WP_BASE_PATH=/mon-site       # Chemin de base WordPress
# WP_THEMES_PATH=wp-content/themes
# VITE_PHP_FILES=functions.php # Fichiers PHP à scanner
```

### Auto-détection

Le bundler détecte automatiquement :
- **Racine WordPress** : les Paths se mettent à jour correctement.
- **Dossier web** : `htdocs`, `www`, `public_html`, etc.
- **Serveur local** : MAMP, XAMPP, Local, Laragon, etc.
- **Structure des assets** : par défaut (`dist/`) si rien de trouvé, sinon nom du dossier identifié dans les enqueues (ex: `optimised/js/`, `optimised/css/`)

---

## Développement

### Démarrage

```bash
npm run dev
```

Cela va :
1. Libérer le port 5173 si occupé
2. Générer le MU-plugin WordPress
3. Démarrer le serveur Vite
4. Ouvrir le navigateur sur votre site WordPress

### HMR - Comportement

#### Avec `HMR_BODY_RESET=true` (défaut)
- **JS modifié** → Reset du `<body>` + réinjection scripts (pas de reload page)
- **SCSS/CSS modifié** → HMR CSS natif Vite (instantané)

#### Avec `HMR_BODY_RESET=false`
- **JS modifié** → Rechargement complet de la page (HMR natif Vite, sur un WP basique cela choisira très souvent un full reload)
- **SCSS/CSS modifié** → HMR CSS natif Vite (instantané)

### Commandes

```bash
npm run dev              # Mode développement (génère MU-plugin + lance Vite)
npm run build            # Build production

npm run preview          # Preview du build
npm run clean            # Nettoie node_modules et package-lock
npm run reinstall        # Réinstallation propre des dépendances
```

---

## Build Production

```bash
npm run build
```

### Détection automatique

Le build détecte depuis `functions.php` :
- **Assets à compiler** : `wp_enqueue_style()`, `wp_enqueue_script()`
- **Dossier de build** : Via `get_template_directory_uri() . '/optimised/'` → `optimised/`
- **Structure** : Plate (`dist/`) ou sous-dossiers (`optimised/js/`, `optimised/css/`)

### Output

**Structure avec sous-dossiers** :
```
wp-content/themes/votre-theme/
└── optimised/              # Dossier détecté depuis functions.php
    ├── css/
    │   ├── style.min.css
    │   └── admin.min.css
    └── js/
        ├── main.min.js
        └── _libs/          # Libs externes non bundlées
            └── swiper.min.js
```

**Structure plate** :
```
wp-content/themes/votre-theme/
└── dist/                   # Dossier détecté depuis functions.php
    ├── style.min.css
    ├── admin.min.css
    ├── main.min.js
    └── _libs/
        └── swiper.min.js
```

### Libs externes

Les imports vers `_libs/`, `libs/`, `vendors/`, `vendor/` sont **externalisés** (non bundlés) et les chemins relatifs sont préservés :

```js
// Source
import Swiper from './_libs/swiper.min.js';

// Build (dans optimised/js/main.min.js)
import Swiper from '../../js/_libs/swiper.min.js'; // Chemin relatif préservé
```

---

## HMR Avancé

### HMR Body Reset

Script client (`scripts/hmr-body-reset.js`) injecté automatiquement quand `HMR_BODY_RESET=true`.

#### Fonctionnement

1. **Sauvegarde initiale** :
   - HTML du `<body>`
   - Scripts JS Vite sources
   - Position du scroll

2. **Détection HMR** :
   - Écoute `vite:beforeUpdate`
   - Filtre uniquement les updates `.js` (pas `.scss`, `.css`, ou `hmr-body-reset.js`)

3. **Reset DOM** :
   - Clone le `<body>` (supprime tous les event listeners)
   - Réinjecte les scripts JS avec cache-bust (`?t=timestamp`)
   - Restaure le HTML du body
   - Déclenche `DOMContentLoaded` pour réinitialiser les modules
   - Restaure la position du scroll

#### Event Listeners

Le script tracke automatiquement les listeners `window` et `document` :

```js
// Avant HMR
window.addEventListener('scroll', handler);
document.addEventListener('click', handler);

// Après HMR → Listeners nettoyés automatiquement
// Le code se réexécute et réattache de nouveaux listeners propres
```

#### Désactivation

```bash
# .env
HMR_BODY_RESET=false
```

Le bundler passe automatiquement en HMR natif Vite (full reload sur changements JS).

### Debug HMR

Activer les logs détaillés dans `scripts/hmr-body-reset.js` :

```js
const DEBUG = true; // Ligne 19
```

Force un reset manuel dans la console :

```js
window.__VITE_HMR_RESET__();
```

---

## Structure des fichiers

⚠️ **Les exemples ci-dessous sont INDICATIFS uniquement.**
Le bundler ne force AUCUNE convention - il détecte votre structure depuis `functions.php`.

### Exemple de thème (votre architecture peut être totalement différente)

```
wp-content/themes/votre-theme/
├── functions.php           # ← SEUL FICHIER OBLIGATOIRE
├── js/                     # Pourrait être : scripts/, src/js/, assets/js/, etc.
│   ├── main.js
│   └── _libs/              # Pourrait être : libs/, vendors/, vendor/, etc.
└── scss/                   # Pourrait être : css/, styles/, sass/, etc.
    └── style.scss
```

### Ce que le bundler détecte AUTOMATIQUEMENT

Le bundler analyse vos `wp_enqueue_style()` et `wp_enqueue_script()` pour déduire :

**✓ Dossiers sources** :
- Le bundler détecte automatiquement vos dossiers JS et CSS
- Exemples JS : `js/`, `scripts/`, `src/js/`, `assets/js/`, `javascript/`, ou tout autre nom
- Exemples CSS : `scss/`, `css/`, `styles/`, `sass/`, `stylesheets/`, ou tout autre nom

**✓ Dossiers de build** :
- Le bundler détecte automatiquement votre dossier de build
- Exemples : `dist/`, `build/`, `optimised/`, `assets/`, `public/`, `compiled/`, ou tout autre nom

**✓ Dossiers de libs** :
- Le bundler détecte automatiquement tout dossier de librairies externes
- Exemples : `_libs/`, `libs/`, `vendors/`, `vendor/`, `libraries/`, ou tout autre nom

**✓ Structure plate ou sous-dossiers** :
- Plate : `dist/style.min.css`, `dist/main.min.js`
- Sous-dossiers : `dist/css/style.min.css`, `dist/js/main.min.js`

→ **Aucune convention imposée, tout est reverse-engineered depuis vos appels WordPress.**

### Exemple d'enregistrement WordPress

```php
// Front
wp_enqueue_style('theme-style', get_template_directory_uri() . '/optimised/css/style.min.css');
wp_enqueue_script('theme-main', get_template_directory_uri() . '/optimised/js/main.min.js');

// Admin (pages WordPress uniquement, pas Vite)
add_action('admin_enqueue_scripts', function() {
  wp_enqueue_style('theme-admin', get_template_directory_uri() . '/optimised/css/admin.min.css');
});

// Editor (iframe Gutenberg, avec Vite HMR)
add_action('enqueue_block_editor_assets', function() {
  wp_enqueue_style('theme-editor', get_template_directory_uri() . '/optimised/css/editor.min.css');
});
```

Le bundler déduit de cet exemple :
- **Context** : `front`, `admin`, `editor`
- **Conversion** : `optimised/css/style.min.css` → source `scss/style.scss`
- **Dossier build** : `optimised/`

---

## Plugins Vite

### `generate-mu-plugin.js`

Génère le MU-plugin WordPress à chaque démarrage du serveur Vite.

**Rôle** :
- Recharge `.env` dynamiquement (HMR_BODY_RESET pris en compte en live)
- Détecte les assets depuis `functions.php`
- Génère `wp-content/mu-plugins/vite-dev-mode.php`
- Ouvre le navigateur WordPress

**MU-Plugin généré** :
- Dequeue les assets de build (front + editor)
- Injecte les assets Vite (client HMR + sources JS/SCSS)
- Conditionnel : `hmr-body-reset.js` si `HMR_BODY_RESET=true`

### `wordpress-assets-detector.plugin.js`

Détecte les assets enregistrés dans `functions.php`.

**Détection** :
- `wp_enqueue_style()`, `wp_enqueue_script()`
- Context : `wp_enqueue_scripts` (front), `admin_enqueue_scripts` (admin), `enqueue_block_editor_assets` (editor)
- Build folder : Via `get_template_directory_uri() . '/optimised/'`
- Structure : Flat vs sous-dossiers

**Conversion build → source** :
```
optimised/css/style.min.css → scss/style.scss
optimised/js/main.min.js → js/main.js
```

**Cache** :
Utilise `cache-manager.plugin.js` pour éviter de re-parser `functions.php` à chaque requête Vite.

### `accept-all-hmr.plugin.js`

Injecte automatiquement `import.meta.hot.accept()` dans tous les modules JS du thème.

**Objectif** :
Empêcher Vite de faire un full-reload quand un module ne définit pas `import.meta.hot.accept()`.

**Injection** :
```js
// Injecté automatiquement dans chaque .js du thème
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    // Le script hmr-body-reset.js intercepte le changement
  });
}
```

**Condition** :
Actif uniquement si `HMR_BODY_RESET=true` dans `.env`.

### `php-reload.plugin.js`

Surveille les fichiers PHP et déclenche un rechargement complet du navigateur.

**Debounce intelligent** :
- Groupe les changements PHP en 150ms
- Évite les reloads multiples lors de sauvegardes multiples

**Watch** :
- `**/*.php` dans le thème WordPress
- Désactivable via `WATCH_PHP=false` dans `.env`

### `port-killer.plugin.js`

Libère automatiquement le port Vite (5173) au démarrage si occupé.

**Sécurité** :
- Tue uniquement les processus Node.js (pas MAMP, Apache, etc.)
- Ne tue jamais le processus actuel
- Utilise PowerShell avec `-ErrorAction SilentlyContinue` (Windows)

### `cleanup-mu-plugin.plugin.js`

Nettoie le MU-plugin WordPress lors de l'arrêt du serveur Vite (Ctrl+C).

**Cleanup** :
- Supprime `wp-content/mu-plugins/vite-dev-mode.php`
- Supprime le dossier `mu-plugins/` si vide

**Signaux** :
- `SIGINT` (Ctrl+C)
- `SIGTERM` (kill)
- `exit` (fermeture normale)

### `postcss-url-rewrite.plugin.js`

Réécrit les URLs relatives dans le CSS pour correspondre à la structure WordPress.

**Dev** :
```css
/* Source SCSS */
background: url('../images/hero.jpg');

/* Servi par Vite */
background: url('http://localhost:5173/@fs/C:/MAMP/.../themezero/images/hero.jpg');
```

**Build** :
```css
/* Source SCSS */
background: url('../images/hero.jpg');

/* Build (optimised/css/style.min.css) */
background: url('../../images/hero.jpg'); /* Relatif depuis optimised/css/ vers images/ */
```

### `sass-glob-import.plugin.js`

Support des imports globaux SCSS via `vite-plugin-sass-glob-import`.

```scss
@import "vendors/*.scss";   // Importe tous les .scss du dossier
@import "modules/**/*.scss"; // Récursif
```

---

## Troubleshooting

### Le serveur Vite ne démarre pas (port 5173 occupé)

**Solution** : Le plugin `port-killer.plugin.js` devrait libérer le port automatiquement. Si ça ne fonctionne pas :

```bash
# Windows
netstat -ano | findstr :5173
taskkill /F /PID <PID>

# Mac/Linux
lsof -ti:5173 | xargs kill -9
```

### HMR ne fonctionne pas

**Vérifications** :
1. `.env` : `HMR_BODY_RESET=true`
2. Console navigateur : Vérifier les logs `[Vite HMR]`
3. MU-plugin généré : `wp-content/mu-plugins/vite-dev-mode.php` existe
4. Cache WordPress : Vider les caches (plugins de cache)

**Debug** :
```js
// Dans scripts/hmr-body-reset.js
const DEBUG = true; // Activer les logs détaillés

// Console navigateur
window.__VITE_HMR_RESET__(); // Force un reset manuel
```

### Les changements .env ne sont pas pris en compte

**Solution** : Redémarrer le serveur Vite (`Ctrl+C` puis `npm run dev`).

Le plugin `generate-mu-plugin.js` recharge `.env` au démarrage du serveur.

### Build ne détecte pas mes assets

**Vérifications** :
1. `functions.php` : Les assets sont bien enregistrés avec `wp_enqueue_style()` / `wp_enqueue_script()`
2. Chemins absolus : Utiliser `get_template_directory_uri()` (pas de chemins hardcodés)
3. Cache : Supprimer `vite-WP-bundler-main/cache/` et rebuild

**Debug** :
```bash
# Afficher les assets détectés
npm run build
# Regarder les logs : "Assets détectés: ..."
```

### PowerShell exit code 5

**Cause** : Permissions insuffisantes pour tuer un processus.

**Solution** : Le plugin `port-killer.plugin.js` utilise maintenant `-ErrorAction SilentlyContinue` pour ignorer silencieusement les erreurs.

Si le problème persiste, libérer manuellement le port avant de lancer Vite.

### Les assets de build apparaissent en double en dev

**Cause** : Le MU-plugin ne dequeue pas correctement les assets.

**Solution** :
1. Vérifier que `vite-dev-mode.php` existe dans `wp-content/mu-plugins/`
2. Vérifier les hooks `wp_enqueue_scripts` (priorité 9999 pour dequeue)
3. Vider le cache WordPress
4. Redémarrer Vite

---

## Licence

MIT

---

## Support

Pour toute question ou problème, ouvrir une issue sur le repository.
