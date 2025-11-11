import { defineConfig } from 'vite';
import { PATHS, WATCH_PHP, BUILD_FOLDER } from './paths.config.js';
import { postcssUrlRewrite } from './plugins/postcss-url-rewrite.plugin.js';
import { phpReloadPlugin } from './plugins/php-reload.plugin.js';
import {
  detectAssetsFromWordPress,
  generateRollupInputs
} from './plugins/wordpress-assets-detector.plugin.js';
import { portKillerPlugin } from './plugins/port-killer.plugin.js';
import { cleanupMuPluginOnClose } from './plugins/cleanup-mu-plugin.plugin.js';
import { resolve } from 'path';

export default defineConfig(async ({ command }) => {
  let buildFolder = BUILD_FOLDER || PATHS.assetFolders.dist;
  let rollupInputs = {};
  let detectedAssets = null;

  // En mode build, détecter les assets depuis WordPress
  if (command === 'build') {
    console.log('🔍 Détection des assets depuis WordPress...');
    detectedAssets = await detectAssetsFromWordPress();

    // Utiliser BUILD_FOLDER en priorité, puis détection, puis fallback
    buildFolder = BUILD_FOLDER || detectedAssets.buildFolder || PATHS.assetFolders.dist;
    rollupInputs = generateRollupInputs(detectedAssets);

    console.log(`✓ Build folder: ${buildFolder}`);
    console.log(`✓ Rollup inputs:`, Object.keys(rollupInputs));
  }

  return {
  // Racine du projet = dossier bundler (pour accéder à entry/)
  root: PATHS.bundlerRoot,

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

    // Ouvrir WordPress automatiquement (le MU-plugin injecte Vite)
    open: `${PATHS.wpProtocol}://${PATHS.wpHost}:${PATHS.wpPort}${PATHS.wpBasePath}`,
  },

  // Plugins Vite
  plugins: [
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
        postcssUrlRewrite(), // Réécrire les URLs après compilation SCSS
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
          // Convertir js-main → js/main.min.js
          // Convertir scss-style → css/style.min.css (car le CSS vient du SCSS)
          const name = chunkInfo.name.replace(/-/g, '/');
          return `${name}.min.js`;
        },
        assetFileNames: (assetInfo) => {
          // Pour les CSS, restaurer la structure de dossiers
          if (assetInfo.name && assetInfo.name.endsWith('.css')) {
            // scss-style → css/style.min.css
            let name = assetInfo.name.replace('.css', '');
            name = name.replace(/-/g, '/');
            // Remplacer scss/ par css/ dans le chemin final
            name = name.replace('scss/', 'css/');
            return `${name}.min.css`;
          }
          return '[name].min.[ext]';
        },
        // Réécrire les chemins des imports externes (_libs)
        // Au lieu de './_libs/swiper.min.js', générer '../js/_libs/swiper.min.js'
        // Car le fichier build est dans optimised/js/main.min.js
        // et les libs sources sont dans js/_libs/
        paths: (id) => {
          // Si c'est un import vers _libs, réécrire le chemin
          if (id.includes('_libs')) {
            // Extraire juste le nom du fichier (ex: swiper-bundle.min.js)
            // Utiliser split sur le chemin normalisé avec /
            const normalizedPath = id.replace(/\\/g, '/');
            const fileName = normalizedPath.split('/_libs/').pop();
            // Retourner le chemin relatif depuis le dossier de build vers les sources
            return `../js/_libs/${fileName}`;
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
        // Exclure aussi les imports relatifs vers _libs (libs minifiées)
        /\/_libs\//,
      ],
      // Supprimer les warnings de sourcemaps manquantes
      onwarn(warning, warn) {
        if (warning.code === 'SOURCEMAP_ERROR') return;
        warn(warning);
      },
    },

    // Minification
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true, // Supprimer les console.log en production
      },
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

  // Mode de log (info pour avoir les timestamps sur tous les logs)
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
    warnOnce: console.warn,
    hasWarned: false,
  },
};
});
