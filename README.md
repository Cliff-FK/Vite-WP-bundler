# Vite WP Bundler

Un bundler Vite.js moderne et optimisé pour WordPress avec Hot Module Replacement (HMR) et détection automatique des assets.

## 🚀 Quick Start

### 1. Installation

```bash
cd vite-wp-bundler
npm install
```

### 2. Configuration minimale

Créez un fichier `.env` à la racine du dossier `vite-wp-bundler/` :

```env
# Nom du thème à bundler (OBLIGATOIRE)
THEME_NAME=votre-theme
```

C'est tout ! Les autres paramètres utilisent des valeurs par défaut intelligentes.

### 3. Lancement du mode développement

```bash
npm run dev
```

Vite démarre et ouvre automatiquement votre site WordPress avec HMR actif.

### 4. Build de production

```bash
npm run build
```

Les assets optimisés sont générés dans le dossier de build détecté automatiquement.

---

## 📖 Présentation

### Le problème

Développer des thèmes WordPress modernes avec des outils comme Vite pose plusieurs défis :

1. **Intégration complexe** : Connecter Vite à WordPress nécessite de la configuration manuelle
2. **Détection des assets** : Difficile de synchroniser les assets enqueued dans `functions.php` avec Vite
3. **HMR incompatible** : Le Hot Module Replacement ne fonctionne pas nativement avec WordPress
4. **Build/Dev différents** : Les assets de dev et prod ont des chemins différents
5. **Admin WordPress** : Les styles admin et Gutenberg nécessitent une gestion spéciale

### La solution : Vite WP Bundler

**Vite WP Bundler** résout ces problématiques avec une approche innovante basée sur la **détection automatique** et l'**injection intelligente**.

#### Comment ça fonctionne ?

```
┌─────────────────────────────────────────────────────────────┐
│  1. DÉTECTION AUTOMATIQUE                                   │
│     Scan de functions.php pour détecter les wp_enqueue_*()  │
│     → Identifie automatiquement tous les assets du thème    │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  2. MODE DEV : INJECTION VITE                               │
│     • Génère un MU-plugin temporaire                        │
│     • Retire les <link>/<script> de build du HTML          │
│     • Injecte les assets sources via Vite HMR              │
│     • Synchronise avec les iframes Gutenberg               │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│  3. MODE BUILD : PRODUCTION                                 │
│     • Compile et minifie tous les assets détectés          │
│     • Génère les fichiers .min.js et .min.css              │
│     • Conserve la structure de dossiers du thème           │
│     • Les wp_enqueue_*() chargent automatiquement le build │
└─────────────────────────────────────────────────────────────┘
```

### Fonctionnalités clés

#### ✨ Zéro Configuration
- **Auto-détection** des chemins WordPress (`htdocs`, `www`, `public_html`)
- **Auto-découverte** des dossiers d'assets (`js`, `scss`, `css`, `dist`)
- **Valeurs par défaut** intelligentes pour tous les paramètres

#### 🔥 Hot Module Replacement
- **HMR natif** pour JS, SCSS et CSS
- **Reload automatique** des fichiers PHP (désactivable)
- **Synchronisation iframe** Gutenberg en temps réel

#### 🎯 Context-Aware
- Détection automatique du contexte : `front`, `admin`, `both`
- Injection conditionnelle des assets selon le contexte
- Support complet de l'éditeur Gutenberg et des iframes

#### 🏗️ Build Intelligent
- **Structure préservée** : `scss/style.scss` → `css/style.min.css`
- **Détection du dossier de build** (optimised, dist, build, etc.)
- **Libs externes** non bundlées (référencées depuis le thème)

#### 🧹 Propre et Automatique
- **MU-plugin temporaire** créé au démarrage, supprimé à l'arrêt
- **Pas de proxy** complexe, utilise les hooks WordPress natifs
- **Nettoyage automatique** en cas d'interruption brutale

---

## 🛠️ Workflow détaillé

### Mode Développement (`npm run dev`)

1. **Génération du MU-plugin**
   - Scanne `functions.php` pour détecter les `wp_enqueue_style()` et `wp_enqueue_script()`
   - Identifie le contexte de chaque asset (`front`, `admin`, `both`)
   - Génère `wp-content/mu-plugins/vite-dev-mode.php`

2. **Injection des assets Vite**
   - Les assets de build sont retirés du HTML via `ob_start()`
   - Les assets sources sont injectés via `<script type="module">`
   - Le client Vite HMR est ajouté automatiquement

3. **Synchronisation Gutenberg**
   - Les styles Vite sont clonés dans l'iframe `editor-canvas`
   - Un `MutationObserver` détecte les changements HMR
   - Les styles sont propagés automatiquement

4. **Rechargement PHP**
   - Les modifications des fichiers PHP déclenchent un reload
   - Debounce intelligent pour éviter les reloads multiples

### Mode Build (`npm run build`)

1. **Détection des entrées**
   - Scanne les mêmes fichiers que le mode dev
   - Génère les inputs Rollup dynamiquement

2. **Compilation optimisée**
   - SCSS → CSS compilé et minifié
   - JS → ESM bundle minifié avec Terser
   - Assets copiés (images, fonts) si nécessaire

3. **Sortie structurée**
   ```
   wp-content/themes/votre-theme/
   ├── js/
   │   └── main.js              (source)
   ├── scss/
   │   └── style.scss           (source)
   └── optimised/               (build)
       ├── js/
       │   └── main.min.js      (compilé)
       └── css/
           └── style.min.css    (compilé)
   ```

---

## ⚙️ Configuration avancée

Toutes les variables sont **optionnelles** avec des valeurs par défaut intelligentes :

```env
# Chemin vers le dossier des thèmes (défaut: wp-content/themes)
# WP_THEMES_PATH=wp-content/themes

# Nom du thème à bundler (OBLIGATOIRE)
THEME_NAME=votre-theme

# Rechargement auto des fichiers PHP (défaut: true)
# WATCH_PHP=false

# Fichiers PHP à scanner (défaut: functions.php)
# VITE_PHP_FILES=functions.php,inc/enqueue.php

# Configuration serveur Vite
VITE_HOST=localhost
VITE_PORT=5173

# Configuration WordPress
WP_HOST=localhost
WP_PROTOCOL=http
WP_PORT=80

# Dossier racine web pour auto-détection (défaut: htdocs)
# WEB_ROOT_FOLDER=htdocs

# Chemin de base WordPress si non auto-détectable
# WP_BASE_PATH=/mon-site/wordpress
```

---

## 📦 Scripts disponibles

| Commande | Description |
|----------|-------------|
| `npm run dev` | Lance Vite en mode développement avec HMR |
| `npm run build` | Compile les assets pour la production |
| `npm run preview` | Prévisualise le build de production |
| `npm run clean` | Supprime node_modules et package-lock.json |
| `npm run reinstall` | Nettoie et réinstalle les dépendances |

---

## 🎯 Cas d'usage

### Assets front uniquement
```php
// functions.php
wp_enqueue_style('theme-style', get_template_directory_uri() . '/scss/style.scss', [], null, 'front');
wp_enqueue_script('theme-js', get_template_directory_uri() . '/js/main.js', [], null, true, 'front');
```

### Assets admin uniquement (Gutenberg)
```php
// functions.php
wp_enqueue_style('admin-style', get_template_directory_uri() . '/scss/admin.scss', [], null, 'admin');
```

### Assets partagés (front + admin)
```php
// functions.php
wp_enqueue_style('global', get_template_directory_uri() . '/scss/global.scss', [], null, 'both');
```

---

## 🔧 Architecture technique

### Structure du projet

```
vite-wp-bundler/
├── .env                    # Configuration utilisateur
├── package.json            # Dépendances et scripts
├── vite.config.js          # Configuration Vite
├── paths.config.js         # Auto-détection des chemins
├── plugins/                # Plugins Vite custom
│   ├── generate-mu-plugin.js           # Génération du MU-plugin
│   ├── wordpress-assets-detector.plugin.js  # Détection des assets
│   ├── php-reload.plugin.js            # Reload PHP
│   ├── port-killer.plugin.js           # Nettoyage du port
│   ├── cleanup-mu-plugin.plugin.js     # Nettoyage à l'arrêt
│   └── postcss-url-rewrite.plugin.js   # Réécriture des URLs CSS
└── README.md               # Documentation
```

### Plugins Vite

- **wordpress-assets-detector** : Scanne `functions.php` et détecte les enqueues
- **php-reload** : Watch les fichiers PHP et trigger un reload
- **port-killer** : Libère le port Vite au démarrage
- **cleanup-mu-plugin** : Supprime le MU-plugin à l'arrêt (Ctrl+C)
- **postcss-url-rewrite** : Corrige les URLs relatives dans le CSS compilé

---

## 🚨 Notes importantes

### MU-Plugin temporaire
Le fichier `wp-content/mu-plugins/vite-dev-mode.php` est **généré automatiquement** en mode dev et **supprimé** à l'arrêt. Ne pas le modifier manuellement.

### Compatibilité
- **WordPress** : 5.0+
- **Node.js** : 18+
- **Gutenberg** : Support complet des iframes
- **Environnement** : Windows, macOS, Linux

### Limitations connues
- Les styles dans l'iframe Gutenberg ne sont pas wrappés avec `.editor-styles-wrapper` en dev (différence mineure avec la prod)
- Les libs minifiées externes ne sont pas bundlées (références relatives conservées)

---

## 📄 Licence

MIT

---

## 🤝 Contribution

Les contributions sont les bienvenues ! N'hésitez pas à ouvrir une issue ou une pull request.

---

**Vite WP Bundler** - Développement moderne pour WordPress 🚀
