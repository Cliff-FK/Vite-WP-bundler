import { defineConfig } from 'vite';
import { PATHS, WATCH_PHP, BUILD_FOLDER } from './paths.config.js';
import { postcssUrlRewrite } from './plugins/postcss-url-rewrite.plugin.js';
import { phpReloadPlugin } from './plugins/php-reload.plugin.js';
import {
  detectAssetsFromWordPress,
  generateRollupInputs,
  detectBuildStructure
} from './plugins/wordpress-assets-detector.plugin.js';
import { portKillerPlugin } from './plugins/port-killer.plugin.js';
import { cleanupMuPluginOnClose } from './plugins/cleanup-mu-plugin.plugin.js';
import sassGlobImports from 'vite-plugin-sass-glob-import';
import { resolve } from 'path';

export default defineConfig(async ({ command }) => {
  let buildFolder = BUILD_FOLDER || PATHS.assetFolders.dist;
  let rollupInputs = {};
  let detectedAssets = null;
  let buildStructure = null;

  // En mode build, détecter les assets depuis WordPress
  if (command === 'build') {
    console.log('Détection des assets depuis WordPress...');
    detectedAssets = await detectAssetsFromWordPress();

    // Utiliser BUILD_FOLDER en priorité, puis détection, puis fallback
    buildFolder = BUILD_FOLDER || detectedAssets.buildFolder || PATHS.assetFolders.dist;
    rollupInputs = generateRollupInputs(detectedAssets);

    // Détecter la structure du dossier de build (flat vs sous-dossiers)
    buildStructure = detectBuildStructure();
  }

  return {
  // Racine du projet = dossier bundler (pour accéder à entry/)
  root: PATHS.bundlerRoot,

  // Cache Vite pour optimisations
  cacheDir: resolve(PATHS.bundlerRoot, 'node_modules/.vite'),

  // Base URL pour les assets
  base: '/',

  // Désactiver publicDir car on va servir les assets du thème directement
  publicDir: false,

  // Configuration du serveur de développement
  server: {
    host: PATHS.viteHost,
    port: PATHS.vitePort,
    strictPort: true,

    // CORS activé
    cors: true,

    // Autoriser l'accès aux fichiers du thème et de WordPress
    fs: {
      allow: [
        PATHS.bundlerRoot,      // Bundler Vite (entry/, scripts/, config/)
        PATHS.themePath,        // Thème WordPress complet
        PATHS.wpRoot,           // Racine WordPress (pour node_modules si besoin)
      ],
    },

    // Configuration HMR (Hot Module Replacement)
    hmr: {
      protocol: 'ws',
      host: PATHS.viteHost,
      port: PATHS.vitePort,
      overlay: true,
    },
  },

  // Plugins Vite
  plugins: [
    // Plugin pour supporter les globs SCSS (@import "vendors/*.scss")
    sassGlobImports(),

    // Plugin pour libérer automatiquement le port Vite en mode dev
    // Tue uniquement les processus Node.js qui bloquent VITE_PORT
    ...(command === 'serve' ? [portKillerPlugin(PATHS.vitePort)] : []),

    // Plugin pour nettoyer le MU-plugin quand Vite s'arrête (Ctrl+C)
    ...(command === 'serve' ? [cleanupMuPluginOnClose()] : []),

    // Plugin pour charger les libs minifiées sans transformation
    {
      name: 'load-minified-libs',
      enforce: 'pre',
      async resolveId(source, importer) {
        // Si c'est un import de lib minifiée depuis main.js
        if (source.startsWith('./_libs/') && source.endsWith('.min.js') && importer) {
          const { dirname } = await import('path');
          // Résoudre le chemin absolu (resolve est déjà importé en haut du fichier)
          return resolve(dirname(importer), source);
        }
      },
      async load(id) {
        if (id.includes('_libs') && id.endsWith('.min.js')) {
          const { readFileSync } = await import('fs');
          const code = readFileSync(id, 'utf-8');
          // Retourner le code brut sans transformation
          return { code, map: null };
        }
      },
    },

    // Plugin personnalisé de reload PHP avec debounce intelligent
    // Évite les reloads multiples en groupant les changements
    // CSS/SCSS/JS sont gérés nativement par Vite avec HMR
    ...(WATCH_PHP ? [phpReloadPlugin()] : []),

    // Plugin personnalisé pour ignorer les sourcemaps des fichiers minifiés
    {
      name: 'ignore-minified-sourcemaps',
      resolveId(source) {
        // Bloquer toutes les requêtes de fichiers .map
        if (source.endsWith('.map') || source.includes('.min.js.map') || source.includes('lottie-player.js.map') || source.includes('swiper-bundle.min.js.map')) {
          return { id: source, external: true };
        }
      },
      load(id) {
        // Intercepter le chargement des .map et retourner un sourcemap vide
        if (id.endsWith('.map') || id.includes('.min.js.map')) {
          return {
            code: 'export default {}',
            map: null,
          };
        }
      },
      transform(code, id) {
        if (id.endsWith('.min.js') || id.includes('_libs')) {
          // Supprimer toute référence aux sourcemaps dans le code
          const cleanCode = code.replace(/\/\/# sourceMappingURL=.*/g, '').replace(/\/\*# sourceMappingURL=.*\*\//g, '');
          return {
            code: cleanCode,
            map: null,
          };
        }
      },
      handleHotUpdate({ file }) {
        // Ignorer les erreurs de sourcemap dans le HMR
        if (file.endsWith('.map')) {
          return [];
        }
      },
    },
  ],

  // Configuration CSS
  css: {
    preprocessorOptions: {
      scss: {
        // Variables SCSS globales (si tu as un fichier _variables.scss)
        // additionalData: `@import "${PATHS.themeScss}/_variables.scss";`,

        // Silencer les warnings de dépréciation Sass
        api: 'modern-compiler', // Utiliser la nouvelle API Sass
        silenceDeprecations: ['import', 'legacy-js-api'], // Ignorer les warnings @import et legacy API
      },
    },
    devSourcemap: true, // Sourcemaps en dev

    // PostCSS plugins pour traiter le CSS compilé
    postcss: {
      plugins: [
        postcssUrlRewrite(command), // Passer le mode (serve/build) au plugin
      ],
    },
  },

  // Résolution des assets (images, fonts)
  // Vite doit savoir où chercher les assets référencés dans le SCSS
  assetsInclude: ['**/*.svg', '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.webp', '**/*.woff', '**/*.woff2', '**/*.ttf', '**/*.eot'],

  // Résolution des modules
  resolve: {
    alias: {
      '@': PATHS.themePath,
      '@js': resolve(PATHS.themePath, 'js'),
      '@css': resolve(PATHS.themePath, 'css'),
      '@scss': resolve(PATHS.themePath, 'scss'),
      '@images': resolve(PATHS.themePath, 'images'),
      '@fonts': resolve(PATHS.themePath, 'fonts'),
      '@bundler': PATHS.bundlerRoot,
    },
    extensions: ['.js', '.json', '.scss', '.css'],
  },

  // Configuration du build (pour production)
  build: {
    outDir: resolve(PATHS.themePath, buildFolder), // Utilise le dossier détecté depuis functions.php
    assetsDir: '', // Pas de sous-dossier assets/
    emptyOutDir: true,

    // Pas de manifest (pas de hash, pas de correspondance nécessaire)
    manifest: false,

    // Configuration Rollup
    rollupOptions: {
      // Ne pas essayer de résoudre les URLs dans le CSS
      // PostCSS s'en occupe après via postcssUrlRewrite
      makeAbsoluteExternalsRelative: false,

      // Entrées dynamiques détectées depuis WordPress (build) ou fallback
      input: command === 'build' && Object.keys(rollupInputs).length > 0
        ? rollupInputs
        : {
            // Fallback : pointer vers les sources réelles du thème
            'js-main': resolve(PATHS.themePath, 'js/main.js'),
            'css-style': resolve(PATHS.themePath, 'scss/style.scss'),
          },
      output: {
        // Format ESM pour les modules modernes
        format: 'es',

        // Nommage sans hash, avec .min et préservation de la structure
        chunkFileNames: '[name].min.js',
        entryFileNames: (chunkInfo) => {
          // Support des structures plates et avec sous-dossiers
          // Le séparateur § est utilisé pour distinguer les segments de path des tirets dans les noms
          if (buildStructure && buildStructure.isFlat) {
            // Structure plate : pas de sous-dossiers
            // Ex: js§main → main.min.js
            // Ex: js-src§app-main → app-main.min.js (préserve les tirets)
            const nameWithoutFolder = chunkInfo.name.split('§').pop();
            return `${nameWithoutFolder}.min.js`;
          }
          // Structure avec sous-dossiers : restaurer la structure depuis le nom de l'entrée
          // Ex: js§main → js/main.min.js
          // Ex: js-src§app-main → js-src/app-main.min.js (préserve les tirets)
          const name = chunkInfo.name.replace(/§/g, '/');
          return `${name}.min.js`;
        },
        assetFileNames: (assetInfo) => {
          // Pour les CSS, utiliser le dossier détecté dynamiquement
          if (assetInfo.name && assetInfo.name.endsWith('.css')) {
            // Extraire le nom sans le préfixe du dossier
            // Le séparateur § est utilisé pour préserver les tirets dans les noms
            // Ex: css§style.css → style, css§admin.css → admin
            // Ex: css-compiled§theme-2024.css → theme-2024 (préserve les tirets)
            const baseName = assetInfo.name
              .replace('.css', '')
              .replace(new RegExp(`^${PATHS.assetFolders.css}§`), '');

            // Support des structures plates et avec sous-dossiers
            if (buildStructure && buildStructure.isFlat) {
              // Structure plate : pas de sous-dossiers CSS
              return `${baseName}.min.css`;
            }
            // Structure avec sous-dossiers CSS
            return `${PATHS.assetFolders.css}/${baseName}.min.css`;
          }
          return '[name].min.[ext]';
        },
        // Réécrire les chemins des imports externes (libs)
        // Support dynamique des différents patterns de dossiers de libs
        paths: (id) => {
          const normalizedPath = id.replace(/\\/g, '/');

          // Détecter dynamiquement le pattern de lib
          // Patterns supportés : _libs, libs, lib, vendors, vendor
          const libFolderMatch = normalizedPath.match(/\/(vendors?|_?libs?)\//);

          if (libFolderMatch) {
            const libFolder = libFolderMatch[1];
            const fileName = normalizedPath.split(`/${libFolder}/`).pop();

            // Calculer la profondeur relative depuis le build folder
            // Ex: optimised/js/ → remonter de 2 niveaux (buildFolder + js/)
            // Ex: dist/ (flat) → remonter de 1 niveau
            let upLevels = '../../'; // Par défaut : 2 niveaux (buildFolder/js/)

            if (buildStructure && buildStructure.isFlat) {
              // Structure plate : remonter de 1 seul niveau
              upLevels = '../';
            }

            // Retourner le chemin relatif depuis le build vers le dossier de lib source
            return `${upLevels}${PATHS.assetFolders.js}/${libFolder}/${fileName}`;
          }

          return id;
        },
      },
      // Marquer les dépendances externes (non incluses dans le bundle)
      external: [
        'jquery',
        'desandro-matches-selector',
        'ev-emitter',
        'get-size',
        'fizzy-ui-utils',
        'outlayer',
        // Détecter dynamiquement les imports vers des dossiers de libs
        // Patterns communs : _libs, libs, lib, vendors, vendor, node_modules
        // Utiliser une regex pour compatibilité avec le CSS build de Vite
        /\/(vendors?|_?libs?|node_modules)\//
      ],
      // Supprimer les warnings de sourcemaps manquantes
      onwarn(warning, warn) {
        if (warning.code === 'SOURCEMAP_ERROR') return;
        warn(warning);
      },
    },

    // Minification avec esbuild (beaucoup plus rapide que Terser)
    minify: 'esbuild',
    esbuildOptions: {
      drop: ['console', 'debugger'], // Supprimer console.log et debugger
      legalComments: 'none', // Pas de commentaires de licence
    },

    // Sourcemaps en production (désactivé par défaut)
    sourcemap: false,

    // Taille des chunks
    chunkSizeWarningLimit: 1000,
  },

  // Optimisation des dépendances
  optimizeDeps: {
    // Ignorer les warnings de sourcemap manquantes pour les libs minifiées
    esbuildOptions: {
      logOverride: {
        'missing-source-map': 'silent',
      },
      logLevel: 'silent',
    },
    include: [
      // Ajoute ici les dépendances à pré-bundler
      // Exemple : 'unpoly', 'swiper', etc.
    ],
    exclude: [
      // Dépendances à exclure du pre-bundling
      // Exclure les libs minifiées qui ont leurs propres dépendances
      'jquery',
      'desandro-matches-selector',
      'ev-emitter',
      'get-size',
      'fizzy-ui-utils',
      'outlayer',
    ],
  },

  // Mode de log (info pour afficher les fichiers générés)
  logLevel: 'info',

  // Clear screen au démarrage
  clearScreen: false,

  // Logger personnalisé pour filtrer les messages
  customLogger: {
    info: (msg) => {
      // Masquer le message "Local: http://localhost:PORT/" (déjà affiché par generate-mu-plugin)
      if (msg.includes('Local:') || (msg.includes('localhost') && msg.includes(String(PATHS.vitePort)))) {
        return; // Ne rien afficher
      }

      // Masquer les messages de progression et de build
      if (msg.includes('transforming') ||
          msg.includes('rendering chunks') ||
          msg.includes('computing gzip size') ||
          msg.includes('modules transformed')) {
        return;
      }

      // Nettoyer les chemins /@fs/... et chemins absolus Windows pour les afficher depuis la racine du projet
      const wpRootNormalized = PATHS.wpRoot.replace(/\\/g, '/');
      const rootFolderName = wpRootNormalized.split('/').pop();

      // Nettoyer les chemins /@fs/...
      if (msg.includes('/@fs/')) {
        const regex = new RegExp(`/@fs/.*?/${rootFolderName}/`, 'g');
        msg = msg.replace(regex, `${rootFolderName}/`);
      }

      // Nettoyer aussi les chemins absolus Windows (C:/MAMP/htdocs/...)
      if (msg.includes(wpRootNormalized)) {
        msg = msg.replace(new RegExp(wpRootNormalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/', 'g'), `${rootFolderName}/`);
      }

      // Normaliser les backslashes
      msg = msg.replace(/\\/g, '/');

      // Ajouter timestamp et [vite] si le message contient "hmr update" ou "page reload" (logs HMR/reload)
      // On détecte avec ou sans codes ANSI
      if (msg.includes('hmr update') || (msg.includes('page reload') && !msg.includes('[vite]'))) {
        const now = new Date();
        const time = now.toLocaleTimeString('fr-FR', { hour12: false });
        const dim = '\x1b[2m';
        const cyan = '\x1b[36m';
        const bold = '\x1b[1m';
        const reset = '\x1b[0m';
        msg = `${dim}${time}${reset} ${bold}${cyan}[vite]${reset} ${msg}`;
      }

      console.info(msg);
    },
    warn: (msg) => {
      // Ignorer les warnings de sourcemap manquantes pour les libs minifiées
      if (msg.includes('Failed to load source map') &&
          (msg.includes('lottie') || msg.includes('swiper'))) {
        return;
      }
      // Ignorer les warnings d'URLs relatives non résolues (PostCSS les transforme après)
      if (msg.includes("didn't resolve at build time")) {
        return;
      }
      console.warn(msg);
    },
    error: (msg) => {
      // Ignorer les erreurs de sourcemap manquantes pour les libs minifiées
      if (msg.includes('Failed to load source map') &&
          (msg.includes('lottie') || msg.includes('swiper'))) {
        return;
      }
      console.error(msg);
    },
    warnOnce: (msg) => {
      // Ignorer les warnings d'URLs relatives non résolues
      if (msg.includes("didn't resolve at build time")) {
        return;
      }
      console.warn(msg);
    },
    hasWarned: false,
  },
};
});
