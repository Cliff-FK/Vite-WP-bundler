import { PATHS, PHP_FILES_TO_SCAN } from '../paths.config.js';
import { existsSync, copyFileSync, mkdirSync, readFileSync, openSync, readSync, closeSync } from 'fs';
import { resolve, dirname } from 'path';
import chalk from 'chalk';

// Cache des assets détectés pour éviter le double scan
let cachedAssets = null;

/**
 * Détecte les assets depuis les fichiers PHP configurés (scan pur)
 * Par défaut: functions.php
 * Configurable via VITE_PHP_FILES dans .env
 */
export async function detectAssetsFromWordPress() {
  // Retourner le cache si disponible
  if (cachedAssets) {
    return cachedAssets;
  }

  try {
    // Lire et fusionner le contenu de tous les fichiers PHP configurés
    let allPhpContent = '';
    let foundFiles = 0;

    for (const phpFile of PHP_FILES_TO_SCAN) {
      const phpFilePath = resolve(PATHS.themePath, phpFile);

      if (!existsSync(phpFilePath)) {
        console.warn(`   ⚠ ${phpFile} introuvable, ignoré`);
        continue;
      }

      const content = readFileSync(phpFilePath, 'utf-8');
      allPhpContent += `\n/* ===== ${phpFile} ===== */\n` + content;
      foundFiles++;
    }

    if (foundFiles === 0) {
      console.warn('⚠ Aucun fichier PHP trouvé');
      return {
        front: { sources: [], libs: [] },
        admin: { sources: [], libs: [] },
        both: { sources: [], libs: [] },
        buildFolder: 'dist'
      };
    }


    const functionsContent = allPhpContent;

    // Détecter buildFolder depuis les constantes PHP OU utiliser la détection auto
    let buildFolder = PATHS.assetFolders.dist; // Utiliser la détection dynamique en priorité
    const buildFolderMatch = functionsContent.match(/define\s*\(\s*['"]OPTI_PATH(?:_URI)?\s*['"]\s*,\s*[^'"]*['"]([^'"]+)\//);
    if (buildFolderMatch) {
      buildFolder = buildFolderMatch[1]; // Override si trouvé dans le PHP
    }

    const assets = {
      front: { scripts: [], styles: [] },
      admin: { scripts: [], styles: [] },
      both: { scripts: [], styles: [] },
      buildFolder
    };

    // Regex améliorée pour capturer le hook ET le chemin du fichier
    // Cherche: add_action('wp_enqueue_scripts', function() { wp_register_script(..., 'js/main.min.js', ...) })
    const scriptRegex = /add_action\s*\(\s*['"]([^'"]+)['"]\s*,\s*function\s*\([^)]*\)\s*\{[^}]*?wp_(?:register|enqueue)_script\s*\([^,]+,\s*(?:OPTI_PATH(?:_URI)?\s*\.\s*)?['"](js\/[^'"]+\.js)['"]/gs;

    let match;
    while ((match = scriptRegex.exec(functionsContent)) !== null) {
      const hook = match[1];
      let scriptPath = match[2];

      // Ignorer les URLs externes
      if (scriptPath.startsWith('http')) continue;

      // Convertir build → source
      scriptPath = convertBuildToSourcePath(scriptPath);

      // Déterminer le contexte
      if (hook.includes('admin') || hook.includes('login') || hook.includes('customize_register')) {
        // Admin uniquement
        if (!assets.admin.scripts.includes(scriptPath)) {
          assets.admin.scripts.push(scriptPath);
        }
      } else if (hook.includes('wp_enqueue_scripts')) {
        // Front uniquement
        if (!assets.front.scripts.includes(scriptPath)) {
          assets.front.scripts.push(scriptPath);
        }
      } else if (hook.includes('enqueue_block_assets') || hook.includes('enqueue_block_editor_assets')) {
        // Gutenberg : both (front ET admin car éditeur + rendu front)
        if (!assets.both.scripts.includes(scriptPath)) {
          assets.both.scripts.push(scriptPath);
        }
      } else {
        // Autres hooks (init, after_setup_theme, etc.) → both par défaut
        if (!assets.both.scripts.includes(scriptPath)) {
          assets.both.scripts.push(scriptPath);
        }
      }
    }

    // Idem pour les styles avec add_editor_style
    const styleRegex = /(?:add_action\s*\(\s*['"]([^'"]+)['"]\s*,\s*function\s*\([^)]*\)\s*\{[^}]*?(?:wp_(?:register|enqueue)_style|add_editor_style)\s*\([^,]*,?\s*(?:OPTI_PATH(?:_URI)?\s*\.\s*)?['"]([^'"]+\.(?:css|scss))['"]|add_editor_style\s*\(\s*(?:OPTI_PATH(?:_URI)?\s*\.\s*)?['"]([^'"]+\.(?:css|scss))['"])/gs;

    while ((match = styleRegex.exec(functionsContent)) !== null) {
      const hook = match[1] || 'after_setup_theme'; // add_editor_style n'a pas de hook
      let stylePath = match[2] || match[3];

      if (stylePath.startsWith('http')) continue;

      stylePath = convertBuildToSourcePath(stylePath);

      if (hook.includes('admin') || hook.includes('editor') || hook.includes('after_setup_theme') || hook.includes('customize_register') || hook.includes('login')) {
        // Admin/Editor uniquement (inclut add_editor_style, customizer, login)
        if (!assets.admin.styles.includes(stylePath)) {
          assets.admin.styles.push(stylePath);
        }
      } else if (hook.includes('wp_enqueue_scripts')) {
        // Front uniquement
        if (!assets.front.styles.includes(stylePath)) {
          assets.front.styles.push(stylePath);
        }
      } else if (hook.includes('enqueue_block_assets') || hook.includes('enqueue_block_editor_assets')) {
        // Gutenberg : both (front ET admin)
        if (!assets.both.styles.includes(stylePath)) {
          assets.both.styles.push(stylePath);
        }
      } else {
        // Autres hooks → both par défaut
        if (!assets.both.styles.includes(stylePath)) {
          assets.both.styles.push(stylePath);
        }
      }
    }

    // Séparer sources vs libs pour chaque contexte
    const result = categorizeAssets(assets);

    // Mettre en cache pour éviter le double scan
    cachedAssets = result;

    return result;

  } catch (err) {
    console.error('⚠ Erreur scan functions.php:', err.message);
    const errorResult = {
      front: { sources: [], libs: [] },
      admin: { sources: [], libs: [] },
      both: { sources: [], libs: [] },
      buildFolder: 'dist'
    };

    // Mettre en cache même en cas d'erreur
    cachedAssets = errorResult;

    return errorResult;
  }
}

/**
 * Convertit un chemin de build vers un chemin source
 * Ex: optimised/js/main.min.js → js/main.js (si main.js existe)
 * Ex: optimised/js/unpoly.min.js → js/unpoly.min.js (si unpoly.js n'existe pas)
 * Ex: optimised/css/style.min.css → scss/style.scss (si style.scss existe)
 */
function convertBuildToSourcePath(path) {
  const buildPatterns = ['dist', 'build', 'optimised', 'optimized', 'compiled', 'bundle', 'public', 'assets', 'output'];

  // Retirer le dossier de build s'il est présent
  let pathWithoutBuild = path;
  for (const pattern of buildPatterns) {
    if (path.startsWith(pattern + '/')) {
      pathWithoutBuild = path.substring(pattern.length + 1);
      break;
    }
  }

  // CAS 1: Fichier .min.js ou .min.css
  if (pathWithoutBuild.match(/\.min\.(js|css)$/)) {
    const ext = pathWithoutBuild.match(/\.min\.js$/) ? 'js' : 'css';

    // Tenter de retirer .min pour trouver la source
    const sourcePath = pathWithoutBuild.replace(new RegExp(`\\.min\\.${ext}$`), `.${ext}`);

    // Vérifier si la version non-minifiée existe
    const sourceAbsolutePath = resolve(PATHS.themePath, sourcePath);
    if (existsSync(sourceAbsolutePath)) {
      // La source existe → utiliser la source (sera bundlée)
      pathWithoutBuild = sourcePath;
    } else {
      // La source n'existe pas → SI C'EST UN CSS, tester .scss
      if (ext === 'css') {
        const scssPath = sourcePath
          .replace(/(^|\/)css\//, '$1scss/')
          .replace(/\.css$/, '.scss');

        const scssAbsolutePath = resolve(PATHS.themePath, scssPath);
        if (existsSync(scssAbsolutePath)) {
          return scssPath;
        }
      }

      // Aucune source trouvée → garder le .min tel quel (sera copié)
      return pathWithoutBuild;
    }
  }

  // CAS 2: Fichier .css (non-minifié) → tenter conversion vers .scss
  if (pathWithoutBuild.match(/\.css$/)) {
    const scssPath = pathWithoutBuild
      .replace(/(^|\/)css\//, '$1scss/')
      .replace(/\.css$/, '.scss');

    const scssAbsolutePath = resolve(PATHS.themePath, scssPath);
    if (existsSync(scssAbsolutePath)) {
      return scssPath;
    }

    // Si .scss n'existe pas, garder le .css tel quel (sera bundlé)
    return pathWithoutBuild;
  }

  // CAS 3: Fichier .js (non-minifié) → garder tel quel
  return pathWithoutBuild;
}

/**
 * Détecte si un fichier est une librairie (analyse du contenu)
 * Performance: ~0.5-1ms par fichier (lecture partielle uniquement)
 * @param {string} filePath - Chemin relatif (ex: "js/main.js")
 * @returns {boolean}
 */
function isLibrary(filePath) {
  try {
    const absolutePath = resolve(PATHS.themePath, filePath);
    if (!existsSync(absolutePath)) return false;

    // ÉTAPE 1: Lecture partielle (premiers 2000 caractères = ultra rapide)
    const fd = openSync(absolutePath, 'r');
    const buffer = Buffer.alloc(2000);
    const bytesRead = readSync(fd, buffer, 0, 2000, 0);
    closeSync(fd);
    const content = buffer.toString('utf-8', 0, bytesRead);

    // ÉTAPE 2: Vérifier headers de libs (99% des cas détectés ici)
    // Header avec @license, @preserve, ou version (ex: /*! jQuery v3.6.0 */)
    if (/^\/\*[!*]?\s*(?:@preserve|@license|@version|@name|\w+\s+v\d+\.\d+)/i.test(content)) {
      return true;
    }

    // ÉTAPE 3: Détecter code minifié (ligne unique longue)
    const firstLine = content.split('\n')[0];
    if (firstLine.length > 500) {
      return true;
    }

    // ÉTAPE 4: Détection par pattern de code minifié
    const hasMinifiedPattern =
      /[a-z]\.[a-z]{1,3}\(/.test(content) && // Appels courts (t.e(), a.push())
      !/\n\s{2,}/.test(content.substring(0, 500)); // Pas d'indentation

    if (hasMinifiedPattern) {
      return true;
    }

    // ÉTAPE 5: Fallback basé sur le nom
    // Si contient .min → probablement une lib
    // Sauf si c'est un nom de source connue (main.min.js, style.min.css)
    const basename = filePath.split('/').pop().replace(/\.min\.(js|css)$/, '');
    const KNOWN_SOURCES = ['main', 'style', 'admin', 'editor'];

    if (filePath.includes('.min.')) {
      // C'est un .min → lib SAUF si c'est un nom connu
      return !KNOWN_SOURCES.includes(basename);
    }

    // Pas de .min → source par défaut
    return false;

  } catch (err) {
    console.warn(`⚠ Erreur détection lib ${filePath}:`, err.message);
    // Fallback: si .min dans le nom et pas dans KNOWN_SOURCES
    return filePath.includes('.min.') && !['main', 'style', 'admin'].some(s => filePath.includes(s));
  }
}

/**
 * Sépare les assets en sources vs libs pour chaque contexte
 */
function categorizeAssets(assets) {
  const result = {
    front: { sources: [], libs: [] },
    admin: { sources: [], libs: [] },
    both: { sources: [], libs: [] },
    buildFolder: assets.buildFolder
  };

  // Traiter chaque contexte
  for (const context of ['front', 'admin', 'both']) {
    // Scripts
    for (const script of assets[context].scripts) {
      if (isLibrary(script)) {
        result[context].libs.push(script);
      } else {
        result[context].sources.push(script);
      }
    }

    // Styles
    for (const style of assets[context].styles) {
      if (isLibrary(style)) {
        result[context].libs.push(style);
      } else {
        result[context].sources.push(style);
      }
    }
  }

  // Logs de debug avec déduplication pour affichage uniquement
  // (les assets réels ne sont PAS modifiés, juste les compteurs d'affichage)
  const allAssets = new Set([
    ...result.both.sources,
    ...result.both.libs,
    ...result.front.sources,
    ...result.front.libs,
    ...result.admin.sources,
    ...result.admin.libs
  ]);

  // Compter les assets uniques par contexte en priorisant: both > admin > front
  const displayCounts = {
    frontSources: 0,
    frontLibs: 0,
    adminSources: 0,
    adminLibs: 0,
    bothSources: 0,
    bothLibs: 0
  };

  allAssets.forEach(asset => {
    const isBothSource = result.both.sources.includes(asset);
    const isBothLib = result.both.libs.includes(asset);
    const isAdminSource = result.admin.sources.includes(asset);
    const isAdminLib = result.admin.libs.includes(asset);
    const isFrontSource = result.front.sources.includes(asset);
    const isFrontLib = result.front.libs.includes(asset);

    // Priorité: both > admin > front (un asset n'est compté qu'une seule fois)
    if (isBothSource || isBothLib) {
      if (isBothSource) displayCounts.bothSources++;
      if (isBothLib) displayCounts.bothLibs++;
    } else if (isAdminSource || isAdminLib) {
      if (isAdminSource) displayCounts.adminSources++;
      if (isAdminLib) displayCounts.adminLibs++;
    } else if (isFrontSource || isFrontLib) {
      if (isFrontSource) displayCounts.frontSources++;
      if (isFrontLib) displayCounts.frontLibs++;
    }
  });

  return result;
}

/**
 * Génère les entry points Rollup depuis les assets détectés
 * Combine tous les contextes (front + admin + both)
 * Valide l'existence des fichiers pour éviter les erreurs Rollup
 */
export function generateRollupInputs(assets) {
  const inputs = {};
  const missingFiles = [];

  // Fusionner tous les contexts
  const allSources = [
    ...assets.front.sources,
    ...assets.admin.sources,
    ...assets.both.sources
  ];

  // Dédupliquer
  const uniqueSources = [...new Set(allSources)];

  uniqueSources.forEach(path => {
    const absolutePath = resolve(PATHS.themePath, path);

    // Vérifier si le fichier existe avant de l'ajouter
    if (!existsSync(absolutePath)) {
      missingFiles.push(path);
      return; // Ignorer ce fichier
    }

    // Utiliser le chemin sans extension comme clé
    // Ex: js/main.js → js-main, scss/style.scss → scss-style
    const name = path.replace(/\.(js|ts|scss|css)$/, '').replace(/\//g, '-');
    inputs[name] = absolutePath;
  });

  // Afficher les warnings pour les fichiers manquants
  if (missingFiles.length > 0) {
    console.warn(`\n⚠️  ${missingFiles.length} fichier(s) enqueue(s) introuvable(s):`);
    missingFiles.forEach(file => {
      console.warn(`   ⚠️  ${file} - Enqueue détecté mais fichier absent`);
    });
    console.warn(`   → Le build continuera sans ces fichiers\n`);
  }

  return inputs;
}
