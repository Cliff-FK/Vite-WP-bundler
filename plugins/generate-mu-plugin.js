#!/usr/bin/env node

/**
 * Script de génération du MU-plugin Vite Dev Mode pour WordPress
 *
 * Ce script:
 * 1. Scanne functions.php via detectAssetsFromWordPress()
 * 2. Génère un MU-plugin PHP qui injecte Vite et retire les build assets
 * 3. Copie le MU-plugin dans wp-content/mu-plugins/
 *
 * Avantages:
 * - Utilise le même scanner que le build (DRY)
 * - Pas de proxy complexe
 * - Hooks WordPress natifs
 * - Simple et maintenable
 */

import { PATHS } from '../paths.config.js';
import { detectAssetsFromWordPress } from './wordpress-assets-detector.plugin.js';
import { mkdirSync, writeFileSync, existsSync, unlinkSync, rmdirSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import chalk from 'chalk';

// Chemins du MU-plugin
const muPluginsPath = resolve(PATHS.wpRoot, 'wp-content/mu-plugins');
const muPluginFile = resolve(muPluginsPath, 'vite-dev-mode.php');

// 1. NETTOYER LE MU-PLUGIN ORPHELIN (si session précédente tuée brutalement)
if (existsSync(muPluginFile)) {
  unlinkSync(muPluginFile);
}
if (existsSync(muPluginsPath)) {
  const files = readdirSync(muPluginsPath);
  if (files.length === 0) {
    rmdirSync(muPluginsPath);
  }
}

// Détecter les assets depuis WordPress (utilise le même scanner que le build)
console.log('🔍 Détection des assets depuis WordPress...');
const detectedAssets = await detectAssetsFromWordPress();
const buildFolder = detectedAssets.buildFolder;

// Extraire les sources par catégorie (front/admin/both)
const frontSources = detectedAssets.front.sources;
const adminSources = detectedAssets.admin.sources;
const bothSources = detectedAssets.both.sources;

// Affichage minimal - juste l'URL WordPress
console.log(
  chalk.green('➜') + '  ' +
  chalk.bold('Ouvre:') + ' ' +
  chalk.green(`${PATHS.wpProtocol}://${PATHS.wpHost}:${PATHS.wpPort}${PATHS.wpBasePath}`)
);

// 2. Générer le contenu du MU-plugin
const muPluginContent = `<?php
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

// Assets détectés dynamiquement depuis functions.php
// Catégorisés par contexte: front, admin, both
\$vite_front_sources = ${JSON.stringify(frontSources, null, 2)};
\$vite_admin_sources = ${JSON.stringify(adminSources, null, 2)};
\$vite_both_sources = ${JSON.stringify(bothSources, null, 2)};
\$vite_build_folder = '${buildFolder}';

/**
 * Déterminer quels assets doivent être chargés selon le contexte
 */
function vite_get_assets_for_context() {
  global \$vite_front_sources, \$vite_admin_sources, \$vite_both_sources;

  \$assets = \$vite_both_sources; // Toujours charger "both"

  if (is_admin()) {
    // Admin: both + admin
    \$assets = array_merge(\$assets, \$vite_admin_sources);
  } else {
    // Front: both + front
    \$assets = array_merge(\$assets, \$vite_front_sources);
  }

  return array_unique(\$assets);
}

/**
 * Fonction de nettoyage des assets de build (partagée front + admin)
 */
function vite_remove_build_assets_callback(\$html) {
  global \$vite_build_folder;
  \$vite_sources = vite_get_assets_for_context();

  foreach (\$vite_sources as \$sourcePath) {
    // Convertir source → build path
    \$buildPath = str_replace('.js', '.min.js', \$sourcePath);
    \$buildPath = str_replace('.scss', '.min.css', \$buildPath);
    \$buildPath = str_replace('scss/', 'css/', \$buildPath);

    // Utiliser strpos() au lieu de regex pour plus de sécurité
    // On cherche juste si le href/src contient "optimised/css/style.min.css"
    \$searchPath = \$vite_build_folder . '/' . \$buildPath;

    // CSS - Retirer les <link> qui contiennent le chemin de build
    if (strpos(\$buildPath, '.css') !== false) {
      // Trouver toutes les balises <link> qui contiennent notre chemin
      \$html = preg_replace_callback(
        '/<link[^>]*>/i',
        function(\$matches) use (\$searchPath) {
          // Si le tag contient notre chemin de build, on le supprime
          if (strpos(\$matches[0], \$searchPath) !== false) {
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
        function(\$matches) use (\$searchPath) {
          // Si le tag contient notre chemin de build, on le supprime
          if (strpos(\$matches[0], \$searchPath) !== false) {
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
 * Retirer les assets de build du HTML - FRONT
 * Utilise template_redirect pour capturer TOUT le HTML
 */
add_action('template_redirect', function() {
  ob_start('vite_remove_build_assets_callback');
});

add_action('shutdown', function() {
  if (ob_get_level() > 0) {
    ob_end_flush();
  }
}, 999);

/**
 * Retirer les assets de build du HTML - ADMIN
 * Utilise admin_init pour capturer le HTML de l'admin
 */
add_action('admin_init', function() {
  ob_start('vite_remove_build_assets_callback');
});

/**
 * Fonction d'injection des assets Vite (utilisée pour front et admin)
 */
function vite_inject_assets() {
  \$vite_sources = vite_get_assets_for_context();

  // 1. Client Vite pour HMR
  echo '<script type="module" src="' . VITE_URL . '/@vite/client"></script>' . "\\n";

  // 2. Assets sources (JS et SCSS)
  foreach (\$vite_sources as \$sourcePath) {
    \$themePath = get_template_directory();
    \$absolutePath = \$themePath . '/' . \$sourcePath;

    // Convertir backslashes en forward slashes pour Windows
    \$absolutePath = str_replace('\\\\', '/', \$absolutePath);

    \$viteUrl = VITE_URL . '/@fs/' . \$absolutePath;

    if (preg_match('/\\\\.js$/', \$sourcePath)) {
      // Script JS module
      echo '<script type="module" src="' . esc_url(\$viteUrl) . '"></script>' . "\\n";
    } elseif (preg_match('/\\\\.(scss|css)$/', \$sourcePath)) {
      // Stylesheet SCSS/CSS via import dynamique pour que Vite compile et active le HMR
      // Au lieu de <link>, on utilise <script type="module"> avec import
      // Vite va compiler le SCSS en CSS et l'injecter dans le DOM avec HMR
      echo '<script type="module">import "' . esc_url(\$viteUrl) . '";</script>' . "\\n";
    }
  }
}

/**
 * Fonction de debug (utilisée pour front et admin)
 */
function vite_inject_debug() {
  \$vite_sources = vite_get_assets_for_context();
  \$context = is_admin() ? 'admin' : 'front';
  echo "<!-- Vite Dev Mode actif [" . \$context . "] (" . count(\$vite_sources) . " assets injectés) -->\\n";
}

/**
 * Script pour injecter les styles Vite dans l'iframe Gutenberg
 */
function vite_inject_iframe_styles_script() {
  if (!is_admin()) return;
  ?>
  <script>
  (function() {
    // Fonction pour injecter les styles Vite dans l'iframe editor-canvas
    function injectViteStylesIntoEditorCanvas() {
      const iframe = document.querySelector('iframe[name="editor-canvas"]');
      if (!iframe || !iframe.contentDocument) return false;

      // Récupérer tous les styles Vite du parent
      const viteStyles = document.querySelectorAll('style[data-vite-dev-id]');
      if (viteStyles.length === 0) return false;

      // Injecter dans l'iframe
      viteStyles.forEach(style => {
        const viteId = style.getAttribute('data-vite-dev-id');
        // Vérifier si déjà injecté
        if (iframe.contentDocument.querySelector(\`style[data-vite-dev-id="\${viteId}"]\`)) {
          // Mettre à jour le contenu existant (HMR)
          const existingStyle = iframe.contentDocument.querySelector(\`style[data-vite-dev-id="\${viteId}"]\`);
          existingStyle.textContent = style.textContent;
        } else {
          // Cloner et injecter
          const clonedStyle = style.cloneNode(true);
          iframe.contentDocument.head.appendChild(clonedStyle);
        }
      });

      return true;
    }

    // Observer l'apparition de l'iframe
    const iframeObserver = new MutationObserver(() => {
      const iframe = document.querySelector('iframe[name="editor-canvas"]');
      if (iframe) {
        // Attendre que l'iframe soit chargée
        iframe.addEventListener('load', () => {
          setTimeout(injectViteStylesIntoEditorCanvas, 100);
        });
        // Essayer aussi immédiatement
        injectViteStylesIntoEditorCanvas();
      }
    });

    // Observer les changements dans le <head> parent pour détecter les mises à jour HMR
    const stylesObserver = new MutationObserver(() => {
      injectViteStylesIntoEditorCanvas();
    });

    // Démarrer les observers quand le DOM est prêt
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        iframeObserver.observe(document.body, { childList: true, subtree: true });
        stylesObserver.observe(document.head, { childList: true, subtree: true });
        injectViteStylesIntoEditorCanvas();
      });
    } else {
      iframeObserver.observe(document.body, { childList: true, subtree: true });
      stylesObserver.observe(document.head, { childList: true, subtree: true });
      injectViteStylesIntoEditorCanvas();
    }
  })();
  </script>
  <?php
}

/**
 * Injecter les assets Vite dans le <head> - FRONT
 */
add_action('wp_head', 'vite_inject_assets', 1);
add_action('wp_head', 'vite_inject_debug', 1);

/**
 * Injecter les assets Vite dans le <head> - ADMIN
 */
add_action('admin_head', 'vite_inject_assets', 1);
add_action('admin_head', 'vite_inject_debug', 1);
add_action('admin_footer', 'vite_inject_iframe_styles_script', 999);
`;

// 2. Créer le dossier mu-plugins si nécessaire
if (!existsSync(muPluginsPath)) {
  mkdirSync(muPluginsPath, { recursive: true });
}

// 3. Écrire le MU-plugin
writeFileSync(muPluginFile, muPluginContent, 'utf8');

// 5. Nettoyer le MU-plugin à l'arrêt (Ctrl+C)
process.on('SIGINT', () => {
  try {
    // Supprimer le fichier MU-plugin
    if (existsSync(muPluginFile)) {
      unlinkSync(muPluginFile);
    }

    // Supprimer le dossier mu-plugins s'il est vide
    if (existsSync(muPluginsPath)) {
      const files = readdirSync(muPluginsPath);
      if (files.length === 0) {
        rmdirSync(muPluginsPath);
      }
    }
  } catch (err) {
    // Silencieux en cas d'erreur
  }

  process.exit(0);
});
