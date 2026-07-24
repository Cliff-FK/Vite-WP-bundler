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
import { detectAssetsFromWordPress, detectBlockCssInputs } from './wordpress-assets-detector.plugin.js';
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

    // Supprimer aussi le .gitignore associé — SEULEMENT s'il porte la signature
    // du bundler (ne jamais supprimer un .gitignore posé par l'utilisateur)
    try {
      if (existsSync(muPluginGitignore)) {
        const gitignoreContent = readFileSync(muPluginGitignore, 'utf8');
        if (gitignoreContent.includes('vite-wp-bundler')) {
          unlinkSync(muPluginGitignore);
        }
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
  let VITE_EDITOR = true;

  if (existsSync(envPath)) {
    const envConfig = dotenv.parse(readFileSync(envPath, 'utf8'));
    themeName = envConfig.THEME_NAME || PATHS.themeName;
    HMR_BODY_RESET = envConfig.HMR_BODY_RESET !== 'false';
    VITE_EDITOR = envConfig.VITE_EDITOR !== 'false';
  }

  // Détecter les assets depuis WordPress
  const detectedAssets = await detectAssetsFromWordPress();
  const buildFolder = detectedAssets.buildFolder;

  const frontSources = detectedAssets.front.sources;
  const adminSources = detectedAssets.admin.sources;
  const editorSources = detectedAssets.editor.sources;

  // CSS-par-bloc (chargement conditionnel) : ces feuilles sont enregistrées DYNAMIQUEMENT (au
  // render du bloc, via style_handles) et n'apparaissent donc pas dans le scan statique de
  // functions.php — sans traitement, le mode dev les servait depuis le build (aucun HMR), alors
  // que servir CHAQUE css en HMR est la promesse du bundler. detectBlockCssInputs() les découvre
  // UNIVERSELLEMENT par les marqueurs natifs WordPress (block.json, register_block_type,
  // registerBlockType JS) — aucune convention de thème supposée. On les ajoute aux sources front :
  // la machinerie existante (dequeue par nom de fichier de build + <link> @fs) les remplace alors
  // par leur source Vite. En dev, toutes les feuilles de bloc sont chargées (le conditionnel est
  // une optim de PROD) → édition live d'un <bloc>.scss visible sans rebuild. Ajoutées APRÈS le
  // style global (déjà dans frontSources) : la cascade « principal avant blocs » est préservée.
  const themeRelPath = (abs) =>
    abs.replace(/\\/g, '/').replace(PATHS.themePath.replace(/\\/g, '/').replace(/\/$/, '') + '/', '');
  let blockSources = [];
  try {
    blockSources = [...new Set(Object.values(detectBlockCssInputs(buildFolder)).map(themeRelPath))]
      .filter((s) => !frontSources.includes(s));
  } catch (err) {
    console.warn('Détection CSS-par-bloc échouée (HMR de bloc dégradé en dev) :', err.message);
  }
  const frontSourcesWithBlocks = [...frontSources, ...blockSources];

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
define('VITE_DEV_HOST', '${['0.0.0.0', '::'].includes(PATHS.viteHost) ? '127.0.0.1' : PATHS.viteHost}'); // Hôte du check socket (VITE_HOST depuis .env ; 0.0.0.0/:: mappés vers 127.0.0.1, fsockopen ne sait pas les joindre)
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
 * Auto-destruction COMPLÈTE : supprime ce fichier, le .gitignore généré par le
 * bundler (signature vérifiée pour ne jamais toucher un .gitignore utilisateur)
 * et le dossier mu-plugins s'il est vide. Objectif : zéro trace hors mode dev.
 */
function vite_self_destruct() {
  $muPluginsDir = dirname(__FILE__);

  @unlink(__FILE__);

  // Supprimer le .gitignore SEULEMENT s'il porte la signature du bundler
  $gitignore = $muPluginsDir . '/.gitignore';
  if (@is_file($gitignore)) {
    $gitignoreContent = @file_get_contents($gitignore);
    if ($gitignoreContent !== false && strpos($gitignoreContent, 'vite-wp-bundler') !== false) {
      @unlink($gitignore);
    }
  }

  // Si le dossier mu-plugins est vide, le supprimer aussi
  $files = @scandir($muPluginsDir);
  if ($files && count($files) <= 2) { // . et .. seulement
    @rmdir($muPluginsDir);
  }
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
  // Hôte Vite baké depuis .env (VITE_HOST) — jamais 'localhost' en dur
  $socket = @fsockopen(VITE_DEV_HOST, VITE_PORT, $errno, $errstr, 2);

  if ($socket === false) {
    // Vite ne répond pas - se supprimer intégralement
    vite_self_destruct();

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

// Filet PRODUCTION : ce plugin est un artefact de DEV. S'il atterrit sur un site
// qui se déclare EXPLICITEMENT en production (WP_ENVIRONMENT_TYPE), ne jamais
// injecter — même si un service écoute par hasard sur le port Vite côté serveur —
// et s'auto-supprimer. Comparaison sur la valeur BRUTE, jamais sur
// wp_get_environment_type() : celle-ci NORMALISE toute valeur inconnue (ex. la
// typo 'dev') en 'production', ce qui auto-détruirait le plugin en local ; et
// elle renvoie aussi 'production' par défaut quand rien n'est défini.
$vite_env_raw = defined('WP_ENVIRONMENT_TYPE') && WP_ENVIRONMENT_TYPE ? WP_ENVIRONMENT_TYPE : getenv('WP_ENVIRONMENT_TYPE');
if ($vite_env_raw === 'production') {
  vite_self_destruct();
  return;
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
\$vite_front_sources = ${JSON.stringify(frontSourcesWithBlocks, null, 2)};
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
        // Ancrage au dossier de build du thème (\$vite_build_folder, ex "dist/"). Sans lui, le fallback
        // par nom de fichier (\$fileName) attrape les CSS core WP homonymes : TOUS les blocs core ont un
        // "wp-includes/blocks/*/style.min.css", donc \$fileName="style.min.css" dequeuait par erreur le CSS
        // responsive de core/navigation (burger + menu desktop affichés simultanément en dev). Les assets
        // de build du thème vivent tous sous \$vite_build_folder/, jamais sous wp-includes/.
        \$in_build_folder = strpos(\$style->src, \$vite_build_folder . '/') !== false;
        if (!empty(\$style->src) && \$in_build_folder && (
          strpos(\$style->src, \$searchPath) !== false ||
          strpos(\$style->src, \$fileName) !== false
        )) {
          // Sauvegarder les inline styles avant de dequeue (pour les réattacher après)
          \$inline_styles = isset(\$style->extra['after']) ? \$style->extra['after'] : [];

          wp_dequeue_style(\$handle);
          wp_deregister_style(\$handle);

          // Ré-enregistrer le handle en PLACEHOLDER VIDE (src=false) : il ne réimprime aucun
          // <link> de build (la source équivalente est injectée par Vite), mais il reste une
          // dépendance RÉSOLVABLE. Sans lui, WordPress omet SILENCIEUSEMENT tout style qui
          // déclare ce handle en dépendance (WP_Dependencies::all_deps() échoue dès qu'une dep
          // est déregistrée) — ex. les feuilles CSS-par-bloc d'un thème enregistrées avec
          // deps=[handle du style global] : elles disparaissent toutes du front en mode dev.
          // Les inline styles éventuels (add_css_fse_vars…) sont réattachés sur ce même handle.
          wp_register_style(\$handle, false);
          if (!empty(\$inline_styles)) {
            wp_enqueue_style(\$handle);
            foreach (\$inline_styles as \$inline_css) {
              wp_add_inline_style(\$handle, \$inline_css);
            }
          }
        }
      }
    }

    // Détecter et dequeue les scripts
    if (strpos(\$buildPath, '.js') !== false && !empty(\$wp_scripts->registered)) {
      foreach (\$wp_scripts->registered as \$handle => \$script) {
        // Même ancrage que pour les styles : le fallback \$fileName ne doit matcher que dans le dossier
        // de build du thème, jamais un script core WP homonyme.
        \$in_build_folder = strpos(\$script->src, \$vite_build_folder . '/') !== false;
        if (!empty(\$script->src) && \$in_build_folder && (
          strpos(\$script->src, \$searchPath) !== false ||
          strpos(\$script->src, \$fileName) !== false
        )) {
          wp_dequeue_script(\$handle);
          wp_deregister_script(\$handle);
          // Placeholder vide : préserve le handle comme dépendance résolvable (même raison que
          // pour les styles ci-dessus) sans réimprimer le <script> de build.
          wp_register_script(\$handle, false);
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

  // Marqueur ANCRÉ au thème : "{dossier-theme}/{build}" (ex "themezero/dist"). \$vite_build_folder seul
  // ("dist") matchait aussi le "dist" de WordPress core : wp-includes/js/dist/script-modules/*. Les
  // script modules de l'Interactivity API (ex. core/navigation view) étaient donc supprimés du HTML en
  // dev alors que WP les avait bien imprimés → clic burger mort. On n'ancre qu'au build DU thème.
  \$theme_build_marker = basename(get_template_directory()) . '/' . ltrim(\$vite_build_folder, '/'); // ex "themezero/dist" (\$vite_build_folder peut valoir "/dist")

  // Supprimer les <link rel="stylesheet"> et <link rel="preload" as="style"> qui contiennent le dossier de build
  \$html = preg_replace(
    '/<link[^>]*' . preg_quote(\$theme_build_marker, '/') . '[^>]*\\.css[^>]*>/i',
    '<!-- Vite Dev Mode: CSS supprimé -->',
    \$html
  );

  // Supprimer les <link rel="preload" as="script"> qui contiennent le dossier de build
  \$html = preg_replace(
    '/<link[^>]*rel=[\\x22\\x27]preload[\\x22\\x27][^>]*as=[\\x22\\x27]script[\\x22\\x27][^>]*' . preg_quote(\$theme_build_marker, '/') . '[^>]*\\.js[^>]*>/i',
    '<!-- Vite Dev Mode: preload JS supprimé pour éviter les warnings -->',
    \$html
  );

  // Supprimer toutes les balises <script> qui contiennent le dossier de build
  \$html = preg_replace(
    '/<script[^>]*' . preg_quote(\$theme_build_marker, '/') . '[^>]*\\.js[^>]*>.*?<\\/script>/is',
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
 * Injecter les assets Vite dans le <head> - FRONT
 */
// Priorité 20 (APRÈS l'import map WP, imprimée sur wp_head en priorité 10). La spec HTML impose qu'une
// import map précède TOUT <script type="module"> : injecter @vite/client (module) en priorité 1 la plaçait
// AVANT l'import map, qui était alors ignorée par le navigateur → @wordpress/interactivity ne se résolvait
// plus → les blocs core interactifs (ex. core/navigation : clic burger) restaient morts en dev uniquement.
add_action('wp_head', 'vite_inject_front_assets', 20);
add_action('wp_head', 'vite_inject_front_debug', 20);

// ============================================================
// VITE EDITOR : injection dev en admin + canvas iframé Gutenberg
// Désactivable via VITE_EDITOR=false dans le .env du bundler
// ============================================================
define('VITE_EDITOR', ${VITE_EDITOR ? 'true' : 'false'});

if (VITE_EDITOR) {

/**
 * Fragment d'URL identifiant les assets de build DU thème ciblé
 * (toujours scopé thème + dossier : un '/dist/' nu matcherait les assets d'autres plugins)
 */
function vite_build_url_fragment() {
  global \$vite_build_folder;
  return '/' . get_template() . '/' . trim(\$vite_build_folder, '/') . '/';
}

/**
 * Retrouve la source Vite correspondant à un asset de build (par nom de base)
 * Ex: .../dist/js/main.min.js → sources/js/main.js
 */
function vite_source_for_build_src(\$src) {
  global \$vite_front_sources, \$vite_admin_sources, \$vite_editor_sources;
  \$base = basename(parse_url(\$src, PHP_URL_PATH));
  \$isJs = (bool) preg_match('/\\.js$/', \$base);
  \$baseNoExt = preg_replace('/\\.min\\.(js|css)$/', '', \$base);
  if (\$baseNoExt === \$base) \$baseNoExt = preg_replace('/\\.(js|css)$/', '', \$base);
  foreach (array_unique(array_merge(\$vite_front_sources, \$vite_admin_sources, \$vite_editor_sources)) as \$s) {
    // Type respecté : un .js de build ne mappe qu'une source .js, un .css qu'une source .scss/.css
    if (((bool) preg_match('/\\.js$/', \$s)) !== \$isJs) continue;
    if (preg_replace('/\\.(js|scss|css)$/', '', basename(\$s)) === \$baseNoExt) return \$s;
  }
  return null;
}

/**
 * Balise du garde HMR éditeur : conserve le HMR CSS mais bloque les js-updates
 * (sans lui, accept-all-hmr ferait réévaluer les modules dans l'éditeur à chaque
 * save JS, sans reset : les abonnements wp.data.subscribe / acf.addAction
 * s'empileraient à chaque édition)
 */
function vite_editor_guard_tag() {
  \$guardPath = '${PATHS.bundlerRoot.replace(/\\/g, '/')}/scripts/hmr-editor-guard.js';
  if (!file_exists(\$guardPath)) return '';
  return '<script type="module" src="' . esc_url(VITE_URL . '/@fs/' . \$guardPath) . '"></script>';
}

/**
 * Construit la balise Vite (<script module> ou <link>) d'une source du thème
 */
function vite_asset_tag(\$sourcePath) {
  \$themePath = str_replace('\\\\', '/', get_template_directory());
  \$viteUrl = VITE_URL . '/@fs/' . \$themePath . '/' . \$sourcePath;
  if (preg_match('/\\.js$/', \$sourcePath)) {
    return '<script type="module" src="' . esc_url(\$viteUrl) . '"></script>';
  }
  if (preg_match('/\\.(scss|css)$/', \$sourcePath)) {
    return '<link rel="stylesheet" href="' . esc_url(\$viteUrl) . '">';
  }
  return '';
}

/**
 * Canvas iframé Gutenberg + previews de blocs : remplacer les assets de build
 * par les sources Vite dans les assets résolus injectés dans l'iframe.
 * Sans effet si l'éditeur n'est pas iframé (metaboxes legacy) : assets de build inchangés.
 */
add_filter('block_editor_settings_all', function(\$settings) {
  if (!vite_is_target_theme() || !vite_check_server_and_cleanup()) return \$settings;
  if (empty(\$settings['__unstableResolvedAssets'])) return \$settings;

  global \$vite_editor_sources;
  \$assets = \$settings['__unstableResolvedAssets'];
  \$styles = isset(\$assets['styles']) ? \$assets['styles'] : '';
  \$scripts = isset(\$assets['scripts']) ? \$assets['scripts'] : '';
  \$buildFragment = preg_quote(vite_build_url_fragment(), '/');

  // Retirer les assets de build du thème (remplacés par les sources)
  \$styles = preg_replace('/<link[^>]*' . \$buildFragment . '[^>]*\\.css[^>]*>/i', '<!-- Vite Editor: CSS build retiré -->', \$styles);
  \$scripts = preg_replace('/<script[^>]*' . \$buildFragment . '[^>]*\\.js[^>]*>\\s*<\\/script>/is', '<!-- Vite Editor: JS build retiré -->', \$scripts);

  // Client Vite + garde HMR éditeur en tête des scripts ; styles sources en FIN (gagnent la cascade)
  \$injectScripts = '<script type="module" src="' . VITE_URL . '/@vite/client"></script>' . vite_editor_guard_tag();
  \$injectStyles = '';
  foreach (\$vite_editor_sources as \$sourcePath) {
    \$tag = vite_asset_tag(\$sourcePath);
    if (strpos(\$tag, '<script') === 0) { \$injectScripts .= \$tag; } else { \$injectStyles .= \$tag; }
  }

  \$assets['scripts'] = \$injectScripts . \$scripts;
  \$assets['styles'] = \$styles . \$injectStyles;
  \$settings['__unstableResolvedAssets'] = \$assets;

  // Traiter aussi le CSS add_editor_style du build : WordPress l'inline dans
  // \$settings['styles'] préfixé .editor-styles-wrapper (spécificité supérieure),
  // il écraserait les éditions live du <link> source injecté ci-dessus.
  // Les entrées n'ont PAS de baseURL fiable (contenu inliné brut) : on matche
  // par CONTENU contre les CSS réels du dossier de build (md5, secours préfixe
  // complet de 500 chars). L'entrée matchée est REMPLACÉE par un @import vers la
  // source Vite (jamais retirée) : en éditeur NON iframé, le canvas = document
  // parent ne consomme QUE \$settings['styles'] — un retrait le laisserait nu.
  // En iframé, doublon bénin avec le <link> injecté ci-dessus (même URL, mêmes règles).
  if (!empty(\$settings['styles']) && is_array(\$settings['styles'])) {
    global \$vite_build_folder;
    \$buildFragmentRaw = vite_build_url_fragment();
    \$buildDir = get_template_directory() . '/' . trim(\$vite_build_folder, '/');
    \$themePathStyles = str_replace('\\\\', '/', get_template_directory());
    \$buildCss = [];
    foreach (array_merge(glob(\$buildDir . '/*.css') ?: [], glob(\$buildDir . '/css/*.css') ?: []) as \$cssFile) {
      \$content = file_get_contents(\$cssFile);
      if (\$content !== false && \$content !== '') {
        \$buildCss[] = ['md5' => md5(\$content), 'prefix' => substr(\$content, 0, 500), 'file' => basename(\$cssFile)];
      }
    }
    foreach (\$settings['styles'] as \$idx => \$entry) {
      \$matchedFile = null;
      if (isset(\$entry['baseURL']) && strpos(\$entry['baseURL'], \$buildFragmentRaw) !== false) {
        \$matchedFile = basename(parse_url(\$entry['baseURL'], PHP_URL_PATH));
      } elseif (!empty(\$entry['css'])) {
        \$entryMd5 = md5(\$entry['css']);
        foreach (\$buildCss as \$candidate) {
          if (\$entryMd5 === \$candidate['md5'] ||
              (strlen(\$candidate['prefix']) === 500 && strncmp(\$entry['css'], \$candidate['prefix'], 500) === 0)) {
            \$matchedFile = \$candidate['file'];
            break;
          }
        }
      }
      if (\$matchedFile === null) continue;

      \$sourcePath = vite_source_for_build_src(\$matchedFile);
      if (\$sourcePath) {
        \$settings['styles'][\$idx]['css'] = '@import url("' . VITE_URL . '/@fs/' . \$themePathStyles . '/' . \$sourcePath . '");';
        unset(\$settings['styles'][\$idx]['baseURL']); // Plus de base locale : l'import est absolu
      }
      // Pas de source détectée : entrée laissée telle quelle (style stale mais canvas jamais nu)
    }
    \$settings['styles'] = array_values(\$settings['styles']);
  }

  return \$settings;
}, 99999);

/**
 * Pages admin (y compris la page parente de l'éditeur) : dequeue les assets de
 * build du thème et mémoriser la source équivalente de chacun pour l'injection.
 * Parité stricte : on n'injecte QUE ce qui a été retiré (pas de style front en admin).
 */
function vite_dequeue_build_assets_admin() {
  if (!vite_is_target_theme() || !vite_check_server_and_cleanup()) return;
  global \$wp_styles, \$wp_scripts;
  \$buildFragment = vite_build_url_fragment();
  \$found = [];
  \$unmapped = [];

  if (!empty(\$wp_styles->registered)) {
    foreach (\$wp_styles->registered as \$handle => \$style) {
      if (!empty(\$style->src) && strpos(\$style->src, \$buildFragment) !== false) {
        \$src = vite_source_for_build_src(\$style->src);
        if (\$src) { \$found[] = \$src; } else { \$unmapped[] = basename(\$style->src); }
        wp_dequeue_style(\$handle);
        wp_deregister_style(\$handle);
      }
    }
  }
  if (!empty(\$wp_scripts->registered)) {
    foreach (\$wp_scripts->registered as \$handle => \$script) {
      if (!empty(\$script->src) && strpos(\$script->src, \$buildFragment) !== false) {
        \$src = vite_source_for_build_src(\$script->src);
        if (\$src) { \$found[] = \$src; } else { \$unmapped[] = basename(\$script->src); }
        wp_dequeue_script(\$handle);
        wp_deregister_script(\$handle);
      }
    }
  }
  \$GLOBALS['vite_admin_replacements'] = array_unique(\$found);
  \$GLOBALS['vite_admin_unmapped'] = array_unique(\$unmapped);
}
add_action('admin_enqueue_scripts', 'vite_dequeue_build_assets_admin', 9999);

function vite_inject_admin_assets() {
  if (!vite_is_target_theme() || !vite_check_server_and_cleanup()) return;
  \$sources = isset(\$GLOBALS['vite_admin_replacements']) ? \$GLOBALS['vite_admin_replacements'] : [];
  \$unmapped = isset(\$GLOBALS['vite_admin_unmapped']) ? \$GLOBALS['vite_admin_unmapped'] : [];

  // Échouer visiblement : un asset dequeué sans source détectée doit se voir
  if (!empty(\$unmapped)) {
    echo '<!-- Vite Dev Mode [admin] ATTENTION : ' . count(\$unmapped) . ' asset(s) de build dequeué(s) SANS source détectée : ' . esc_html(implode(', ', \$unmapped)) . ' -->' . "\\n";
  }
  if (empty(\$sources)) return; // Rien à remplacer : ne pas injecter le client pour rien

  echo '<script type="module" src="' . VITE_URL . '/@vite/client"></script>' . "\\n";
  echo vite_editor_guard_tag() . "\\n";
  foreach (\$sources as \$sourcePath) {
    echo vite_asset_tag(\$sourcePath) . "\\n";
  }
  echo '<!-- Vite Dev Mode actif [admin] (' . count(\$sources) . ' assets remplacés) -->' . "\\n";
}
add_action('admin_head', 'vite_inject_admin_assets', 1);

} // if (VITE_EDITOR)
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

        if (lastEnvHash === null || !muPluginExists || currentEnvHash !== lastEnvHash) {
          // Premier démarrage OU MU-plugin supprimé OU .env modifié
          console.log('Génération du MU-plugin WordPress...');
          await regenerateMuPlugin();

          // Sauvegarder le hash
          const cacheDir = dirname(ENV_HASH_FILE);
          if (!existsSync(cacheDir)) {
            mkdirSync(cacheDir, { recursive: true });
          }
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
