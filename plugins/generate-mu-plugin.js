/**
 * Plugin Vite pour générer le MU-plugin WordPress à chaque démarrage du serveur
 *
 * Ce plugin:
 * 1. S'exécute au démarrage du serveur Vite (buildStart hook)
 * 2. Scanne functions.php pour détecter les assets
 * 3. Génère le MU-plugin PHP avec la configuration actuelle de .env
 * 4. Permet de prendre en compte les changements de .env en live
 */

import { PATHS } from '../paths.config.js';
import { detectAssetsFromWordPress } from './wordpress-assets-detector.plugin.js';
import { getMultisiteSites, getSiteName } from './multisite-detector.plugin.js';
import { mkdirSync, writeFileSync, existsSync, unlinkSync, rmdirSync, readdirSync, readFileSync, watch } from 'fs';
import { resolve, dirname } from 'path';
import dotenv from 'dotenv';


// Chemins du MU-plugin
const muPluginsPath = PATHS.muPluginsPath;
const muPluginFile = resolve(muPluginsPath, 'vite-dev-mode.php');
const muPluginGitignore = resolve(muPluginsPath, '.gitignore');

/**
 * Supprime le MU-plugin Vite (pour mode build)
 * Si le dossier mu-plugins est vide après suppression, le supprimer aussi
 */
export function deleteMuPlugin() {
  if (existsSync(muPluginFile)) {
    try {
      unlinkSync(muPluginFile);
    } catch (err) {
      // Le fichier peut être verrouillé par PHP/WordPress
      // On ignore l'erreur silencieusement
    }

    // Supprimer aussi le .gitignore associé
    try {
      if (existsSync(muPluginGitignore)) {
        unlinkSync(muPluginGitignore);
      }
    } catch (err) {
      // Ignorer les erreurs
    }

    // Vérifier si le dossier mu-plugins est vide
    try {
      if (existsSync(muPluginsPath)) {
        const files = readdirSync(muPluginsPath);

        // Si vide, supprimer le dossier
        if (files.length === 0) {
          rmdirSync(muPluginsPath);
        }
      }
    } catch (err) {
      // Ignorer les erreurs
    }
  }
}

/**
 * Recharge les variables d'environnement depuis .env
 * Nécessaire car process.env est figé au démarrage du processus Node.js
 */
function reloadEnvVars() {
  const envPath = resolve(PATHS.bundlerRoot, '.env');
  if (!existsSync(envPath)) {
    return { HMR_BODY_RESET: true }; // Valeur par défaut
  }

  const envConfig = dotenv.parse(readFileSync(envPath, 'utf8'));
  const HMR_BODY_RESET = envConfig.HMR_BODY_RESET !== 'false';

  return { HMR_BODY_RESET };
}

/**
 * Ajoute le dossier de build du thème au .gitignore racine WordPress si pas déjà présent
 */
function ensureBuildFolderInGitignore(buildFolder) {
  const wpGitignorePath = resolve(PATHS.wpRoot, '.gitignore');

  // Construire le chemin complet depuis la racine WP: wp-content/themes/themezero/dist/
  const buildFolderPath = `${PATHS.themePathRelative}/${buildFolder.replace(/^\//, '')}`;
  const gitignoreLine = `${buildFolderPath}/`;

  try {
    // Lire le contenu existant ou créer un fichier vide
    let content = '';
    if (existsSync(wpGitignorePath)) {
      content = readFileSync(wpGitignorePath, 'utf8');
    }

    // Vérifier si le dossier de build est déjà ignoré
    if (content.includes(buildFolderPath)) {
      return; // Déjà présent
    }

    // Ajouter le dossier de build au .gitignore
    const newContent = content
      ? `${content}\n# Dossier de build généré par Vite\n${gitignoreLine}\n`
      : `# Dossier de build généré par Vite\n${gitignoreLine}\n`;

    writeFileSync(wpGitignorePath, newContent, 'utf8');
  } catch (err) {
    // Ignorer les erreurs silencieusement
  }
}

/**
 * Génère le contenu du MU-plugin PHP
 */
async function generateMuPluginContent() {
  // Recharger les variables d'environnement depuis .env
  const envPath = resolve(PATHS.bundlerRoot, '.env');
  let themeName = PATHS.themeName; // Valeur par défaut
  let HMR_BODY_RESET = true;

  if (existsSync(envPath)) {
    const envConfig = dotenv.parse(readFileSync(envPath, 'utf8'));
    themeName = envConfig.THEME_NAME || PATHS.themeName;
    HMR_BODY_RESET = envConfig.HMR_BODY_RESET !== 'false';
  }

  // Détecter les assets depuis WordPress
  const detectedAssets = await detectAssetsFromWordPress();
  const buildFolder = detectedAssets.buildFolder;

  const frontSources = detectedAssets.front.sources;
  const adminSources = detectedAssets.admin.sources;
  const editorSources = detectedAssets.editor.sources;

  return `<?php
/**
 * Plugin Name: Vite Dev Mode
 * Description: Injecte les assets Vite en mode développement (généré automatiquement)
 * Version: 1.0.0
 * Author: Vite WP Bundler
 *
 * Ce fichier est GÉNÉRÉ AUTOMATIQUEMENT par vite-wp-bundler.
 * Ne pas modifier manuellement - vos changements seront écrasés.
 *
 * Pour regénérer: npm run dev dans vite-wp-bundler/
 */

// Configuration Vite (depuis paths.config.js et .env)
define('VITE_DEV_MODE', true);
define('VITE_URL', '${PATHS.viteUrl}');
define('VITE_PORT', ${PATHS.vitePort});
define('VITE_TARGET_THEME', '${themeName}'); // Thème ciblé (THEME_NAME depuis .env)

/**
 * Vérifie si le thème actuel correspond au thème ciblé par Vite
 * Utilisé pour éviter d'injecter Vite sur d'autres thèmes en multisite
 * Utilise get_template() qui retourne le slug du thème parent actif
 */
function vite_is_target_theme() {
  \$current_theme = get_template();
  return \$current_theme === VITE_TARGET_THEME;
}

/**
 * Auto-destruction si Vite n'est pas accessible
 * Vérifie que le serveur Vite répond avant d'injecter les assets
 * Si Vite est down, supprime ce MU-plugin automatiquement
 *
 * Système de cache pour éviter de vérifier à chaque milliseconde
 */
function vite_check_server_and_cleanup() {
  // Cache de vérification (5 secondes)
  static $lastCheck = 0;
  static $lastResult = null;

  $now = time();

  // Si on a vérifié il y a moins de 5 secondes, retourner le résultat en cache
  if ($lastCheck > 0 && ($now - $lastCheck) < 5) {
    return $lastResult;
  }

  // Vérifier si Vite répond via une socket TCP directe (plus rapide que file_get_contents)
  $socket = @fsockopen('localhost', VITE_PORT, $errno, $errstr, 2);

  if ($socket === false) {
    // Vite ne répond pas - se supprimer
    $muPluginFile = __FILE__;
    $muPluginsDir = dirname($muPluginFile);

    // Supprimer ce fichier
    @unlink($muPluginFile);

    // Si le dossier mu-plugins est vide, le supprimer aussi
    $files = @scandir($muPluginsDir);
    if ($files && count($files) <= 2) { // . et .. seulement
      @rmdir($muPluginsDir);
    }

    // Mettre en cache le résultat
    $lastCheck = $now;
    $lastResult = false;

    return false;
  }

  // Vite répond - fermer la socket
  @fclose($socket);

  // Mettre en cache le résultat
  $lastCheck = $now;
  $lastResult = true;

  return true;
}

// Vérifier que le thème actuel est bien le thème ciblé
// Si ce n'est pas le cas, ne rien faire (multisite avec différents thèmes)
if (!vite_is_target_theme()) {
  return; // Thème différent, ne pas injecter Vite
}

// Vérifier Vite au chargement du plugin
if (!vite_check_server_and_cleanup()) {
  return; // Vite est down, plugin supprimé, arrêter ici
}

// Assets détectés dynamiquement depuis functions.php
// Catégorisés par contexte: front, admin (pages WP), editor (iframe Gutenberg)
// NOTE: Les assets admin ne sont PAS injectés par Vite - WordPress utilise ses assets de build
\$vite_front_sources = ${JSON.stringify(frontSources, null, 2)};
\$vite_admin_sources = ${JSON.stringify(adminSources, null, 2)}; // Conservé pour référence uniquement
\$vite_editor_sources = ${JSON.stringify(editorSources, null, 2)};
\$vite_build_folder = '${buildFolder}';

/**
 * Dequeue les assets de build pour les remplacer par Vite (FRONT + EDITOR uniquement)
 * Les assets ADMIN ne sont PAS dequeued - WordPress les charge normalement
 */
function vite_dequeue_build_assets_front() {
  // Vérifier que c'est bien le thème ciblé
  if (!vite_is_target_theme()) {
    return;
  }

  global \$vite_build_folder, \$vite_front_sources;

  foreach (\$vite_front_sources as \$sourcePath) {
    // Convertir source → build path
    \$buildPath = str_replace('.js', '.min.js', \$sourcePath);
    \$buildPath = str_replace('.scss', '.min.css', \$buildPath);
    \$buildPath = str_replace('scss/', 'css/', \$buildPath);

    \$searchPath = \$vite_build_folder . '/' . \$buildPath;
    \$fileName = basename(\$buildPath);

    // Parcourir tous les styles/scripts enregistrés pour trouver ceux qui correspondent
    global \$wp_styles, \$wp_scripts;

    // Détecter et dequeue les styles
    if (strpos(\$buildPath, '.css') !== false && !empty(\$wp_styles->registered)) {
      foreach (\$wp_styles->registered as \$handle => \$style) {
        if (!empty(\$style->src) && (
          strpos(\$style->src, \$searchPath) !== false ||
          strpos(\$style->src, \$fileName) !== false
        )) {
          // Sauvegarder les inline styles avant de dequeue (pour les réattacher après)
          \$inline_styles = isset(\$style->extra['after']) ? \$style->extra['after'] : [];

          wp_dequeue_style(\$handle);
          wp_deregister_style(\$handle);

          // Si des inline styles existaient, les réenregistrer sur un handle temporaire
          // pour qu'ils restent dans le HTML (ex: add_css_fse_vars.php)
          if (!empty(\$inline_styles)) {
            \$temp_handle = \$handle . '-inline-only';
            // Enregistrer un style vide (pas de src, juste pour porter les inline styles)
            wp_register_style(\$temp_handle, false);
            wp_enqueue_style(\$temp_handle);
            // Réattacher tous les inline styles
            foreach (\$inline_styles as \$inline_css) {
              wp_add_inline_style(\$temp_handle, \$inline_css);
            }
          }
        }
      }
    }

    // Détecter et dequeue les scripts
    if (strpos(\$buildPath, '.js') !== false && !empty(\$wp_scripts->registered)) {
      foreach (\$wp_scripts->registered as \$handle => \$script) {
        if (!empty(\$script->src) && (
          strpos(\$script->src, \$searchPath) !== false ||
          strpos(\$script->src, \$fileName) !== false
        )) {
          wp_dequeue_script(\$handle);
          wp_deregister_script(\$handle);
        }
      }
    }
  }
}

/**
 * Hook pour dequeue les assets de build - FRONT uniquement
 * L'admin utilise les assets WordPress normaux (pas de Vite en admin)
 */
add_action('wp_enqueue_scripts', 'vite_dequeue_build_assets_front', 9999);

/**
 * Filtrer wp_preload_resources pour retirer tous les preload du dossier de build
 * S'exécute en dernier (priorité 99999) pour filtrer après tous les ajouts du theme
 */
add_filter('wp_preload_resources', function(\$resources) {
  // Vérifier que c'est bien le thème ciblé
  if (!vite_is_target_theme()) {
    return \$resources;
  }

  global \$vite_build_folder;

  return array_filter(\$resources, function(\$resource) use (\$vite_build_folder) {
    // Garder uniquement les ressources qui ne contiennent PAS le dossier de build
    return !isset(\$resource['href']) || strpos(\$resource['href'], \$vite_build_folder) === false;
  });
}, 99999);

/**
 * Fonction de nettoyage des assets de build via output buffering (FRONT uniquement)
 * Supprime uniquement les JS et CSS du dossier de build, pas les fonts
 */
function vite_remove_build_assets_callback(\$html) {
  // Vérifier que c'est bien le thème ciblé
  if (!vite_is_target_theme()) {
    return \$html;
  }

  global \$vite_build_folder;

  // Supprimer les <link rel="stylesheet"> et <link rel="preload" as="style"> qui contiennent le dossier de build
  \$html = preg_replace(
    '/<link[^>]*' . preg_quote(\$vite_build_folder, '/') . '[^>]*\\.css[^>]*>/i',
    '<!-- Vite Dev Mode: CSS supprimé -->',
    \$html
  );

  // Supprimer les <link rel="preload" as="script"> qui contiennent le dossier de build
  \$html = preg_replace(
    '/<link[^>]*rel=[\\x22\\x27]preload[\\x22\\x27][^>]*as=[\\x22\\x27]script[\\x22\\x27][^>]*' . preg_quote(\$vite_build_folder, '/') . '[^>]*\\.js[^>]*>/i',
    '<!-- Vite Dev Mode: preload JS supprimé pour éviter les warnings -->',
    \$html
  );

  // Supprimer toutes les balises <script> qui contiennent le dossier de build
  \$html = preg_replace(
    '/<script[^>]*' . preg_quote(\$vite_build_folder, '/') . '[^>]*\\.js[^>]*>.*?<\\/script>/is',
    '<!-- Vite Dev Mode: script JS supprimé -->',
    \$html
  );

  return \$html;
}

/**
 * Retirer les assets de build du HTML - FRONT uniquement (pas admin)
 * Utilise template_redirect pour capturer TOUT le HTML
 */
add_action('template_redirect', function() {
  if (!is_admin()) {
    ob_start('vite_remove_build_assets_callback');
  }
});

add_action('shutdown', function() {
  if (ob_get_level() > 0) {
    ob_end_flush();
  }
}, 999);

/**
 * NOTE: L'admin WordPress utilise les assets de build normaux (pas de Vite)
 * Seuls le FRONT et l'EDITOR (iframe Gutenberg) utilisent Vite HMR
 */

/**
 * Fonction d'injection des assets Vite pour FRONT
 */
function vite_inject_front_assets() {
  // Vérifier que c'est bien le thème ciblé
  if (!vite_is_target_theme()) {
    return;
  }

  global \$vite_front_sources;

  // Vérifier à nouveau que Vite est actif avant d'injecter
  // (au cas où il aurait crashé depuis le chargement du plugin)
  if (!vite_check_server_and_cleanup()) {
    // Vite est down, le plugin s'est supprimé, ne rien injecter
    return;
  }

  // 1. Client Vite pour HMR
  echo '<script type="module" src="' . VITE_URL . '/@vite/client"></script>' . "\\n";

  // 2. HMR Body Reset Helper (injecté depuis le bundler - conditionnel)
  ${HMR_BODY_RESET ? `\$hmrHelperPath = '${PATHS.bundlerRoot.replace(/\\/g, '/')}/scripts/hmr-body-reset.js';
  if (file_exists(\$hmrHelperPath)) {
    \$hmrHelperUrl = VITE_URL . '/@fs/' . \$hmrHelperPath;
    echo '<script type="module" src="' . esc_url(\$hmrHelperUrl) . '"></script>' . "\\n";
  }` : '// HMR Body Reset désactivé (HMR_BODY_RESET=false dans .env)'}

  // 3. Assets sources (JS et SCSS)
  foreach (\$vite_front_sources as \$sourcePath) {
    \$themePath = get_template_directory();
    \$absolutePath = \$themePath . '/' . \$sourcePath;

    // Convertir backslashes en forward slashes pour Windows
    \$absolutePath = str_replace('\\\\', '/', \$absolutePath);

    \$viteUrl = VITE_URL . '/@fs/' . \$absolutePath;

    if (preg_match('/\\\\.js$/', \$sourcePath)) {
      // Script JS module
      echo '<script type="module" src="' . esc_url(\$viteUrl) . '"></script>' . "\\n";
    } elseif (preg_match('/\\\\.(scss|css)$/', \$sourcePath)) {
      // Stylesheet SCSS/CSS via <link> pour que les URLs relatives fonctionnent
      echo '<link rel="stylesheet" href="' . esc_url(\$viteUrl) . '">' . "\\n";
    }
  }
}

/**
 * Fonction de debug FRONT
 */
function vite_inject_front_debug() {
  // Vérifier que c'est bien le thème ciblé
  if (!vite_is_target_theme()) {
    return;
  }

  global \$vite_front_sources;
  echo "<!-- Vite Dev Mode actif [front] (" . count(\$vite_front_sources) . " assets injectés) -->\\n";
}

/**
 * Injecter les assets Vite dans le <head> - FRONT uniquement
 * L'admin WordPress (y compris l'éditeur Gutenberg) utilise les assets de build normaux
 */
add_action('wp_head', 'vite_inject_front_assets', 1);
add_action('wp_head', 'vite_inject_front_debug', 1);
`;
}


/**
 * Génère/régénère le MU-plugin WordPress
 */
async function regenerateMuPlugin() {
  // Recharger les variables d'environnement
  const { HMR_BODY_RESET } = reloadEnvVars();

  // Nettoyer l'ancien MU-plugin s'il existe
  if (existsSync(muPluginFile)) {
    try {
      unlinkSync(muPluginFile);
    } catch (err) {
      // Le fichier peut être verrouillé par PHP/WordPress sous Windows
      // On continue quand même, writeFileSync va écraser le contenu
    }
  }

  // Détecter les assets pour obtenir le buildFolder
  const detectedAssets = await detectAssetsFromWordPress();
  const buildFolder = detectedAssets.buildFolder;

  // Générer le nouveau contenu
  const muPluginContent = await generateMuPluginContent();

  // Créer le dossier mu-plugins si nécessaire
  if (!existsSync(muPluginsPath)) {
    mkdirSync(muPluginsPath, { recursive: true });
  }

  // Écrire le MU-plugin
  writeFileSync(muPluginFile, muPluginContent, 'utf8');

  // Générer le .gitignore à côté du mu-plugin
  const gitignoreContent = `# Fichiers générés automatiquement par vite-wp-bundler
# Ne pas commiter - ils seront recréés automatiquement en mode dev
vite-dev-mode.php
`;
  writeFileSync(muPluginGitignore, gitignoreContent, 'utf8');

  // Ajouter le dossier de build au .gitignore racine WordPress
  ensureBuildFolderInGitignore(buildFolder);
}

/**
 * Plugin Vite pour gérer le MU-plugin (génération en dev, suppression en build)
 */
export function generateMuPluginPlugin() {
  const ENV_HASH_FILE = resolve(PATHS.bundlerRoot, '.cache', '.env-hash');
  let isDevMode = false;
  let urlDisplayed = false;

  return {
    name: 'generate-mu-plugin',

    // S'exécute dès que la config Vite est résolue, AVANT le démarrage du serveur
    async configResolved(config) {
      isDevMode = config.command === 'serve';

      if (isDevMode) {
        // Calculer le hash du .env actuel
        const envPath = resolve(PATHS.bundlerRoot, '.env');
        let currentEnvHash = null;
        if (existsSync(envPath)) {
          const envContent = readFileSync(envPath, 'utf-8');
          const crypto = await import('crypto');
          currentEnvHash = crypto.createHash('md5').update(envContent).digest('hex');
        }

        // Lire le hash précédent depuis le fichier
        let lastEnvHash = null;
        if (existsSync(ENV_HASH_FILE)) {
          try {
            lastEnvHash = readFileSync(ENV_HASH_FILE, 'utf-8').trim();
          } catch (err) {
            // Fichier corrompu, on ignore
          }
        }

        // Régénérer le MU-plugin si:
        // 1. Premier démarrage (pas de hash)
        // 2. .env a changé
        // 3. Le MU-plugin n'existe pas (même si le hash existe)
        const muPluginExists = existsSync(muPluginFile);

        if (lastEnvHash === null || !muPluginExists) {
          // Premier démarrage OU MU-plugin supprimé
          console.log('Génération du MU-plugin WordPress...');
          await regenerateMuPlugin();

          // Sauvegarder le hash
          const cacheDir = dirname(ENV_HASH_FILE);
          if (!existsSync(cacheDir)) {
            mkdirSync(cacheDir, { recursive: true });
          }
          writeFileSync(ENV_HASH_FILE, currentEnvHash || '', 'utf-8');
        } else if (currentEnvHash !== lastEnvHash) {
          // .env a changé - mettre à jour le hash
          // La régénération sera gérée par le watcher dans configureServer()
          writeFileSync(ENV_HASH_FILE, currentEnvHash || '', 'utf-8');
        }
      } else {
        // MODE BUILD: Supprimer le MU-plugin s'il existe
        deleteMuPlugin();
      }
    },

    // Afficher l'URL WordPress après le démarrage du serveur
    configureServer(server) {
      if (!urlDisplayed) {
        server.httpServer?.once('listening', async () => {
          urlDisplayed = true;
          const wpUrl = `${PATHS.wpProtocol}://${PATHS.wpHost}:${PATHS.wpPort}${PATHS.wpBasePath}`;

          // Tenter de détecter le multisite (ne bloque pas en cas d'erreur)
          try {
            const sites = await getMultisiteSites();
            if (sites && sites.length > 0) {
              // Multisite détecté : afficher la liste des sites
              sites.forEach(site => {
                console.log(`  • ${site.name} (\x1b[32m${site.url}\x1b[0m)`);
              });
            } else {
              // Pas de multisite : récupérer le nom du site et afficher avec le même format
              const siteName = await getSiteName();
              if (siteName) {
                console.log(`  • ${siteName} (\x1b[32m${wpUrl}\x1b[0m)`);
              } else {
                // Fallback si le nom n'est pas trouvé
                console.log(`  Homepage: \x1b[32m${wpUrl}\x1b[0m`);
              }
            }
          } catch (err) {
            // En cas d'erreur : fallback sur Homepage
            console.log(`  Homepage: \x1b[32m${wpUrl}\x1b[0m`);
          }

          // Surveiller les changements du .env pour régénérer le MU-plugin et recharger les pages
          const envPath = resolve(PATHS.bundlerRoot, '.env');
          let lastEnvContent = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
          let debounceTimer = null;

          const watcher = watch(envPath, async (eventType) => {
            // Debounce: attendre 100ms avant de traiter le changement
            if (debounceTimer) clearTimeout(debounceTimer);

            debounceTimer = setTimeout(async () => {
              const currentEnvContent = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
              if (currentEnvContent === lastEnvContent) return;

              lastEnvContent = currentEnvContent;

              console.log('\n.env modifié - Régénération du MU-plugin WordPress...');
              await regenerateMuPlugin();
              console.log('MU-plugin régénéré avec les nouvelles variables .env\n');

              // Recharger toutes les pages (même syntaxe que le plugin PHP reload)
              server.ws.send({
                type: 'full-reload',
                path: '*',
              });
              console.log('📡 Rechargement des pages WordPress...\n');
            }, 100);
          });

          // Nettoyer le watcher à la fermeture
          server.httpServer?.on('close', () => {
            if (watcher) watcher.close();
          });
        });
      }
    }
  };
}
