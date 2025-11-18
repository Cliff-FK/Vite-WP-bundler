import { defineConfig } from 'vite';
import { PATHS, WATCH_PHP, BUILD_FOLDER, HMR_BODY_RESET } from './paths.config.js';
import { postcssUrlRewrite } from './plugins/postcss-url-rewrite.plugin.js';
import { phpReloadPlugin } from './plugins/php-reload.plugin.js';
import {
  detectAssetsFromWordPress,
  generateRollupInputs,
  detectBuildStructure
} from './plugins/wordpress-assets-detector.plugin.js';
import { portKillerPlugin } from './plugins/port-killer.plugin.js';
import { cleanupMuPluginOnClose } from './plugins/cleanup-mu-plugin.plugin.js';
import { acceptAllHMRPlugin } from './plugins/accept-all-hmr.plugin.js';
import { generateMuPluginPlugin } from './plugins/generate-mu-plugin.js';
import { copyMinifiedLibsPlugin } from './plugins/copy-minified-libs.plugin.js';
import sassGlobImports from 'vite-plugin-sass-glob-import';
import { resolve } from 'path';

export default defineConfig(async ({ command }) => {
  // console.log('[Vite Config] Command:', command);

  let buildFolder = BUILD_FOLDER || PATHS.assetFolders.dist;
  let rollupInputs = {};
  let detectedAssets = null;
  let buildStructure = null;

  // En mode build, détecter les assets depuis WordPress
  if (command === 'build') {
    // console.log('[Vite Config] Mode build détecté, lancement du scan...');
    detectedAssets = await detectAssetsFromWordPress();

    // Utiliser BUILD_FOLDER en priorité, puis détection, puis fallback
    buildFolder = BUILD_FOLDER || detectedAssets.buildFolder || PATHS.assetFolders.dist;
    // Retirer le slash de début si présent (pour que resolve() fonctionne correctement)
    buildFolder = buildFolder.replace(/^\//, '');
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

    // Plugin pour générer le MU-plugin WordPress à chaque démarrage du serveur (mode dev uniquement)
    // Permet de prendre en compte les changements de .env (HMR_BODY_RESET, etc.) en live
    ...(command === 'serve' ? [generateMuPluginPlugin()] : []),

    // Plugin pour accepter automatiquement le HMR sur tous les modules JS du thème (mode dev uniquement)
    // Empêche Vite de faire un full-reload et laisse hmr-body-reset.js gérer le HMR
    // Activé seulement si HMR_BODY_RESET=true dans .env
    ...(command === 'serve' && HMR_BODY_RESET ? [acceptAllHMRPlugin()] : []),

    // Plugin pour libérer automatiquement le port Vite en mode dev
    // Tue uniquement les processus Node.js qui bloquent VITE_PORT
    ...(command === 'serve' ? [portKillerPlugin(PATHS.vitePort)] : []),

    // Plugin pour nettoyer le MU-plugin quand Vite s'arrête (Ctrl+C)
    ...(command === 'serve' ? [cleanupMuPluginOnClose()] : []),

    // Plugin pour charger les libs minifiées sans transformation (uniquement en mode dev)
    ...(command === 'serve' ? [{
      name: 'load-minified-libs-dev',
      enforce: 'pre',
      async resolveId(source, importer) {
        // Détecter les imports de fichiers .min.js (relatifs)
        if (source.endsWith('.min.js') && importer) {
          const { dirname } = await import('path');
          return resolve(dirname(importer), source);
        }
      },
      async load(id) {
        // Charger les fichiers .min.js sans transformation
        if (id.endsWith('.min.js')) {
          const { readFileSync } = await import('fs');
          const code = readFileSync(id, 'utf-8');
          return { code, map: null };
        }
      },
    }] : []),

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
        // Supprimer les sourcemaps des fichiers minifiés
        if (id.endsWith('.min.js')) {
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

      // Plugins Rollup
      plugins: [
        // Copier les fichiers .min.js dans le dossier de build
        copyMinifiedLibsPlugin(),
      ],

      // Entrées dynamiques détectées depuis WordPress
      input: rollupInputs,
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
            // Ex: scss§style.css → style, css§admin.css → admin, assets/scss§style.css → style
            // Ex: css-compiled§theme-2024.css → theme-2024 (préserve les tirets)
            const baseName = assetInfo.name
              .replace('.css', '')
              .split('§').pop();  // Retirer tout ce qui est avant le § (quel que soit le dossier source)

            // Support des structures plates et avec sous-dossiers
            if (buildStructure && buildStructure.isFlat) {
              // Structure plate : pas de sous-dossiers CSS
              return `${baseName}.min.css`;
            }
            // Structure avec sous-dossiers CSS - utiliser buildFolder dynamique
            return `css/${baseName}.min.css`;
          }
          return '[name].min.[ext]';
        },
        // Réécrire les chemins des imports externes (.min.js)
        // Les fichiers sont copiés à plat dans le dossier de sortie
        paths: (id) => {
          const normalizedPath = id.replace(/\\/g, '/');

          // Traiter uniquement les imports .min.js (libs externes)
          if (!normalizedPath.endsWith('.min.js')) {
            return id;
          }

          // Extraire juste le nom de fichier
          const fileName = normalizedPath.split('/').pop();

          // Retourner le chemin relatif depuis le fichier bundlé vers le fichier copié
          // Les fichiers .min.js sont dans le même dossier que les fichiers bundlés
          return `./${fileName}`;
        },
      },
      // Marquer les dépendances externes (non incluses dans le bundle)
      external: (id) => {
        // Détecter les libs par patterns de noms de packages NPM
        const libPackages = ['jquery', 'desandro-matches-selector', 'ev-emitter', 'get-size', 'fizzy-ui-utils', 'outlayer'];
        if (libPackages.includes(id)) return true;

        // Normaliser le chemin
        const normalizedId = id.replace(/\\/g, '/');

        // Détecter node_modules
        if (normalizedId.includes('/node_modules/')) return true;

        // Détecter les fichiers .min.js (libs externes)
        if (normalizedId.endsWith('.min.js')) return true;

        return false;
      },
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
