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
import { resolve } from 'path';
import chalk from 'chalk';
import { exec } from 'child_process';
import { promisify } from 'util';
import { platform } from 'os';

const execAsync = promisify(exec);

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
const detectedAssets = await detectAssetsFromWordPress();
const buildFolder = detectedAssets.buildFolder;

// Extraire les sources par catégorie (front/admin/editor)
const frontSources = detectedAssets.front.sources;
const adminSources = detectedAssets.admin.sources;
const editorSources = detectedAssets.editor.sources;

// Construire l'URL WordPress
const wpUrl = `${PATHS.wpProtocol}://${PATHS.wpHost}:${PATHS.wpPort}${PATHS.wpBasePath}`;

// Affichage de l'URL WordPress
console.log(
  chalk.bold('Ouvre:') + ' ' +
  chalk.green(wpUrl)
);

// Ouvrir l'URL dans le navigateur par défaut
const os = platform();
const openCommand = os === 'win32' ? `start "" "${wpUrl}"` : os === 'darwin' ? `open "${wpUrl}"` : `xdg-open "${wpUrl}"`;
try {
  await execAsync(openCommand);
} catch (err) {
  // Silencieux en cas d'erreur
}

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

  // 1. Client Vite pour HMR
  echo '<script type="module" src="' . VITE_URL . '/@vite/client"></script>' . "\\n";

  // 2. Assets sources (JS et SCSS)
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
      // Stylesheet SCSS/CSS via import dynamique pour que Vite compile et active le HMR
      echo '<script type="module">import "' . esc_url(\$viteUrl) . '";</script>' . "\\n";
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
