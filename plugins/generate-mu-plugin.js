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
import { mkdirSync, writeFileSync, existsSync, unlinkSync, rmdirSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { platform } from 'os';
import dotenv from 'dotenv';

const execAsync = promisify(exec);

// Flag pour ouvrir le navigateur une seule fois
let browserOpened = false;

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

      // Supprimer aussi le .gitignore associé
      if (existsSync(muPluginGitignore)) {
        unlinkSync(muPluginGitignore);
      }

      // Vérifier si le dossier mu-plugins est vide
      if (existsSync(muPluginsPath)) {
        const files = readdirSync(muPluginsPath);

        // Si vide, supprimer le dossier
        if (files.length === 0) {
          rmdirSync(muPluginsPath);
        }
      }
    } catch (err) {
      // Silencieux
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
 * Génère le contenu du MU-plugin PHP
 */
async function generateMuPluginContent() {
  // Recharger les variables d'environnement depuis .env
  const { HMR_BODY_RESET } = reloadEnvVars();

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

// Configuration Vite (depuis paths.config.js)
define('VITE_DEV_MODE', true);
define('VITE_URL', '${PATHS.viteUrl}');
define('VITE_PORT', ${PATHS.vitePort});

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
 * Fonction de nettoyage des assets de build via output buffering (FRONT uniquement)
 * Fallback au cas où wp_dequeue_* ne capture pas certains assets
 */
function vite_remove_build_assets_callback(\$html) {
  global \$vite_build_folder, \$vite_front_sources;

  foreach (\$vite_front_sources as \$sourcePath) {
    // Convertir source → build path
    \$buildPath = str_replace('.js', '.min.js', \$sourcePath);
    \$buildPath = str_replace('.scss', '.min.css', \$buildPath);
    \$buildPath = str_replace('scss/', 'css/', \$buildPath);

    // Construire le chemin de recherche (relatif depuis le thème)
    // Ex: optimised/css/admin.min.css
    \$searchPath = \$vite_build_folder . '/' . \$buildPath;

    // Aussi chercher juste le nom du fichier final (pour les URLs complètes)
    // Ex: admin.min.css
    \$fileName = basename(\$buildPath);

    // CSS - Retirer les <link> qui contiennent le chemin de build
    if (strpos(\$buildPath, '.css') !== false) {
      // Trouver toutes les balises <link> qui contiennent notre chemin
      \$html = preg_replace_callback(
        '/<link[^>]*>/i',
        function(\$matches) use (\$searchPath, \$fileName) {
          // Si le tag contient notre chemin de build OU le nom du fichier, on le supprime
          // Cela gère à la fois les chemins relatifs et les URLs complètes
          if (strpos(\$matches[0], \$searchPath) !== false ||
              (strpos(\$matches[0], \$fileName) !== false && strpos(\$matches[0], 'href') !== false)) {
            return '';
          }
          return \$matches[0];
        },
        \$html
      );
    }

    // JS - Retirer les <script> qui contiennent le chemin de build
    if (strpos(\$buildPath, '.js') !== false) {
      // Trouver toutes les balises <script> qui contiennent notre chemin
      \$html = preg_replace_callback(
        '/<script[^>]*><\\\\/script>/i',
        function(\$matches) use (\$searchPath, \$fileName) {
          // Si le tag contient notre chemin de build OU le nom du fichier, on le supprime
          if (strpos(\$matches[0], \$searchPath) !== false ||
              (strpos(\$matches[0], \$fileName) !== false && strpos(\$matches[0], 'src') !== false)) {
            return '';
          }
          return \$matches[0];
        },
        \$html
      );
    }
  }

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
 * Ouvre l'URL WordPress dans le navigateur (une seule fois)
 */
async function openBrowser() {
  if (browserOpened) return;
  browserOpened = true;

  const wpUrl = `${PATHS.wpProtocol}://${PATHS.wpHost}:${PATHS.wpPort}${PATHS.wpBasePath}`;
  console.log(`\n  Ouvre: ${wpUrl}\n`);

  const os = platform();
  const openCommand = os === 'win32' ? `start "" "${wpUrl}"` : os === 'darwin' ? `open "${wpUrl}"` : `xdg-open "${wpUrl}"`;

  try {
    await execAsync(openCommand);
  } catch (err) {
    // Silencieux en cas d'erreur
  }
}

/**
 * Plugin Vite pour gérer le MU-plugin (génération en dev, suppression en build)
 */
export function generateMuPluginPlugin() {
  return {
    name: 'generate-mu-plugin',

    async buildStart() {
      const isDev = this.meta?.watchMode;

      // MODE DEV: Générer le MU-plugin
      if (isDev) {
        console.log('Génération du MU-plugin WordPress...');

        // Recharger les variables d'environnement
        const { HMR_BODY_RESET } = reloadEnvVars();

        // Nettoyer l'ancien MU-plugin s'il existe
        if (existsSync(muPluginFile)) {
          unlinkSync(muPluginFile);
        }

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

        console.log(`   MU-plugin généré: ${PATHS.muPluginsPathRelative}/vite-dev-mode.php`);
        console.log(`   .gitignore généré: ${PATHS.muPluginsPathRelative}/.gitignore`);
        console.log(`   HMR_BODY_RESET = ${HMR_BODY_RESET}\n`);

        // Ouvrir le navigateur (une seule fois)
        await openBrowser();
      }
      // MODE BUILD: Supprimer le MU-plugin s'il existe
      else {
        deleteMuPlugin();
      }
    }
  };
}
