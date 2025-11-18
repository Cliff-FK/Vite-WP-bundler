import { PATHS, PHP_FILES_TO_SCAN } from '../paths.config.js';
import { existsSync, copyFileSync, mkdirSync, readFileSync, openSync, readSync, closeSync } from 'fs';
import { resolve, dirname } from 'path';
import chalk from 'chalk';
import { getCachedAssets, saveCachedAssets, deleteOldBuildFolder } from './cache-manager.plugin.js';

// Cache en mémoire des assets détectés pour éviter le double scan dans la même session
let cachedAssets = null;

/**
 * Détecte les assets depuis les fichiers PHP configurés (scan pur)
 * Par défaut: functions.php
 * Configurable via VITE_PHP_FILES dans .env
 * Utilise un cache persistent invalidé automatiquement si les fichiers PHP changent
 */
export async function detectAssetsFromWordPress() {
  // 1. Cache mémoire (session actuelle)
  if (cachedAssets) {
    return cachedAssets;
  }

  // 2. Cache persistent (fichier .cache/)
  const { assets: persistentCache, oldBuildFolder } = getCachedAssets();

  // Si un ancien buildFolder existe et est différent du nouveau, le supprimer
  if (oldBuildFolder && !persistentCache) {
    // Le cache est invalide, on va régénérer
    // On garde l'ancien buildFolder pour le comparer après détection
  }

  if (persistentCache) {
    cachedAssets = persistentCache;
    return cachedAssets;
  }

  try {
    // Lire et fusionner le contenu de tous les fichiers PHP configurés
    let allPhpContent = '';
    let foundFiles = 0;

    for (const phpFile of PHP_FILES_TO_SCAN) {
      const phpFilePath = resolve(PATHS.themePath, phpFile);

      if (!existsSync(phpFilePath)) {
        console.warn(`   ${phpFile} introuvable, ignoré`);
        continue;
      }

      const content = readFileSync(phpFilePath, 'utf-8');
      allPhpContent += `\n/* ===== ${phpFile} ===== */\n` + content;
      foundFiles++;
    }

    if (foundFiles === 0) {
      console.warn('Aucun fichier PHP trouvé');
      return {
        front: { sources: [], libs: [] },
        admin: { sources: [], libs: [] },
        editor: { sources: [], libs: [] },
        buildFolder: 'dist'
      };
    }


    const functionsContent = allPhpContent;

    // 1. PARSER LES CONSTANTES PHP (define()) pour construire une map de chemins
    const phpConstants = {};
    const defineRegex = /define\s*\(\s*['"]([\w_]+)['"]\s*,\s*get_template_directory(?:_uri)?\(\)\s*\.\s*['"]([^'"]+)['"]\s*\)/g;
    let defineMatch;
    while ((defineMatch = defineRegex.exec(functionsContent)) !== null) {
      const constantName = defineMatch[1]; // Ex: JS_PATH, OPTI_PATH_URI
      const relativePath = defineMatch[2]; // Ex: /assets/js/, /optimised/
      phpConstants[constantName] = relativePath.replace(/^\/|\/$/g, ''); // Nettoyer les / au début/fin
    }

    // console.log('Constantes PHP détectées:', phpConstants);

    // Détecter buildFolder depuis les constantes PHP OU utiliser la détection auto
    let buildFolder = PATHS.assetFolders.dist; // Utiliser la détection dynamique en priorité
    const buildFolderMatch = functionsContent.match(/define\s*\(\s*['"]OPTI_PATH(?:_URI)?\s*['"]\s*,\s*[^'"]*['"]([^'"]+)\//);
    if (buildFolderMatch) {
      buildFolder = buildFolderMatch[1]; // Override si trouvé dans le PHP
    }

    const assets = {
      front: { scripts: [], styles: [] },
      admin: { scripts: [], styles: [] },      // Pages admin WP (dashboard, settings, etc.)
      editor: { scripts: [], styles: [] },     // Iframe Gutenberg uniquement
      buildFolder
    };

    // Regex améliorée pour capturer le hook ET le contenu complet de la fonction
    // Cherche: add_action('hook', function() { ... wp_register_script(...) ... })
    const scriptBlockRegex = /add_action\s*\(\s*['"]([^'"]+)['"]\s*,\s*function\s*\([^)]*\)\s*\{([^}]*?wp_(?:register|enqueue)_script[^}]*)\}/gs;

    let blockMatch;
    while ((blockMatch = scriptBlockRegex.exec(functionsContent)) !== null) {
      const hook = blockMatch[1];
      const functionBody = blockMatch[2];

      // Vérifier si la fonction contient une condition !is_admin() ou $_GET['context'] === 'iframe'
      const hasAdminCheck = /!\s*is_admin\s*\(\s*\)/.test(functionBody);
      const hasIframeCheck = /\$_GET\s*\[\s*['"]context['"]\s*\]\s*===\s*['"]iframe['"]/.test(functionBody);

      // Extraire tous les scripts enqueued dans ce bloc
      // Capture: wp_enqueue_script('name', CONSTANT_NAME . 'path/file.js') ou directement 'path/file.js'
      const scriptRegex = /wp_(?:register|enqueue)_script\s*\([^,]+,\s*(?:([\w_]+)\s*\.\s*)?['"]([^'"]+\.js)['"]/g;
      let match;
      while ((match = scriptRegex.exec(functionBody)) !== null) {
        const constantUsed = match[1]; // Ex: OPTI_PATH_URI, JS_PATH, etc.
        let scriptPath = match[2]; // Le chemin capturé

        // console.log('Script détecté:', { constantUsed, scriptPath, hook });

        // Si une constante PHP est utilisée, préfixer avec le chemin correspondant
        if (constantUsed && phpConstants[constantUsed]) {
          scriptPath = phpConstants[constantUsed] + '/' + scriptPath;
          // console.log('  → Chemin reconstruit:', scriptPath);
        }

        // Ignorer les URLs externes
        if (scriptPath.startsWith('http')) continue;

        // Convertir build → source
        scriptPath = convertBuildToSourcePath(scriptPath);

        // Déterminer le contexte selon le hook ET les conditions détectées
        if (hook.includes('wp_enqueue_scripts')) {
          // Frontend public uniquement
          if (!assets.front.scripts.includes(scriptPath)) {
            assets.front.scripts.push(scriptPath);
          }
        } else if (hook.includes('enqueue_block_editor_assets')) {
          // Iframe Gutenberg uniquement (éditeur)
          if (!assets.editor.scripts.includes(scriptPath)) {
            assets.editor.scripts.push(scriptPath);
          }
        } else if (hook.includes('enqueue_block_assets')) {
          // Hybride : Frontend (rendu blocs) + Iframe Gutenberg (éditeur)
          // NOTE: WordPress charge aussi ces assets dans l'admin, mais Vite ne doit PAS les remplacer
          // Le MU-plugin se charge de ne PAS injecter Vite dans l'admin (seulement front + editor iframe)
          if (!assets.front.scripts.includes(scriptPath)) {
            assets.front.scripts.push(scriptPath);
          }
          if (!assets.editor.scripts.includes(scriptPath)) {
            assets.editor.scripts.push(scriptPath);
          }
        } else if (hook.includes('admin') || hook.includes('login') || hook.includes('customize_register')) {
          // Pages admin WP (dashboard, settings, login, customizer)
          if (!assets.admin.scripts.includes(scriptPath)) {
            assets.admin.scripts.push(scriptPath);
          }
        } else {
          // Hooks ambigus (init, after_setup_theme, etc.)
          // Par sécurité : considérer comme admin WP
          if (!assets.admin.scripts.includes(scriptPath)) {
            assets.admin.scripts.push(scriptPath);
          }
        }
      }
    }

    // Idem pour les styles - détecter les blocs add_action avec conditions
    const styleBlockRegex = /add_action\s*\(\s*['"]([^'"]+)['"]\s*,\s*function\s*\([^)]*\)\s*\{([^}]*?wp_(?:register|enqueue)_style[^}]*)\}/gs;

    while ((blockMatch = styleBlockRegex.exec(functionsContent)) !== null) {
      const hook = blockMatch[1];
      const functionBody = blockMatch[2];

      // Vérifier si la fonction contient une condition !is_admin() ou $_GET['context'] === 'iframe'
      const hasAdminCheck = /!\s*is_admin\s*\(\s*\)/.test(functionBody);
      const hasIframeCheck = /\$_GET\s*\[\s*['"]context['"]\s*\]\s*===\s*['"]iframe['"]/.test(functionBody);

      // Extraire tous les styles enqueued dans ce bloc
      const styleRegex = /wp_(?:register|enqueue)_style\s*\([^,]+,\s*(?:([\w_]+)\s*\.\s*)?['"]([^'"]+\.(?:css|scss))['"]/g;
      let match;
      while ((match = styleRegex.exec(functionBody)) !== null) {
        const constantUsed = match[1];
        let stylePath = match[2];

        // Si une constante PHP est utilisée, préfixer avec le chemin correspondant
        if (constantUsed && phpConstants[constantUsed]) {
          stylePath = phpConstants[constantUsed] + '/' + stylePath;
        }

        if (stylePath.startsWith('http')) continue;

        stylePath = convertBuildToSourcePath(stylePath);

        // Déterminer le contexte selon le hook ET les conditions détectées
        if (hook.includes('wp_enqueue_scripts')) {
          // Frontend public uniquement
          if (!assets.front.styles.includes(stylePath)) {
            assets.front.styles.push(stylePath);
          }
        } else if (hook.includes('enqueue_block_editor_assets')) {
          // Iframe Gutenberg uniquement (éditeur)
          if (!assets.editor.styles.includes(stylePath)) {
            assets.editor.styles.push(stylePath);
          }
        } else if (hook.includes('enqueue_block_assets')) {
          // Hybride : Frontend (rendu blocs) + Iframe Gutenberg (éditeur)
          // NOTE: WordPress charge aussi ces assets dans l'admin, mais Vite ne doit PAS les remplacer
          // Le MU-plugin se charge de ne PAS injecter Vite dans l'admin (seulement front + editor iframe)
          if (!assets.front.styles.includes(stylePath)) {
            assets.front.styles.push(stylePath);
          }
          if (!assets.editor.styles.includes(stylePath)) {
            assets.editor.styles.push(stylePath);
          }
        } else if (hook.includes('admin') || hook.includes('login') || hook.includes('customize_register')) {
          // Pages admin WP (dashboard, settings, login, customizer)
          if (!assets.admin.styles.includes(stylePath)) {
            assets.admin.styles.push(stylePath);
          }
        } else {
          // Hooks ambigus (init, etc.)
          // Par sécurité : considérer comme admin WP
          if (!assets.admin.styles.includes(stylePath)) {
            assets.admin.styles.push(stylePath);
          }
        }
      }
    }

    // Gérer add_editor_style() séparément (sans hook)
    const editorStyleRegex = /add_editor_style\s*\(\s*(?:([\w_]+)\s*\.\s*)?['"]([^'"]+\.(?:css|scss))['"]/g;
    let editorMatch;
    while ((editorMatch = editorStyleRegex.exec(functionsContent)) !== null) {
      const constantUsed = editorMatch[1];
      let stylePath = editorMatch[2];

      // Si une constante PHP est utilisée, préfixer avec le chemin correspondant
      if (constantUsed && phpConstants[constantUsed]) {
        stylePath = phpConstants[constantUsed] + '/' + stylePath;
      }

      if (stylePath.startsWith('http')) continue;
      stylePath = convertBuildToSourcePath(stylePath);
      if (!assets.editor.styles.includes(stylePath)) {
        assets.editor.styles.push(stylePath);
      }
    }

    // Séparer sources vs libs pour chaque contexte
    const result = categorizeAssets(assets);

    // Si buildFolder a changé, supprimer l'ancien
    if (oldBuildFolder && oldBuildFolder !== result.buildFolder) {
      deleteOldBuildFolder(oldBuildFolder);
    }

    // Mettre en cache (mémoire + persistent)
    cachedAssets = result;
    saveCachedAssets(result);

    return result;

  } catch (err) {
    console.error('Erreur scan functions.php:', err.message);
    const errorResult = {
      front: { sources: [], libs: [] },
      admin: { sources: [], libs: [] },
      editor: { sources: [], libs: [] },
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

  // Helper function: cherche un fichier par son nom dans le thème (ignore les chemins)
  function findSourceByFilename(originalPath) {
    // Extraire le nom de fichier (ex: js/main.min.js → main)
    const filename = originalPath
      .split('/').pop()           // Garder seulement le nom de fichier
      .replace(/\.min\.(js|css)$/, '.$1')  // Retirer .min
      .replace(/\.(js|css)$/, '');         // Retirer extension

    // console.log(`  → Recherche de fichiers nommés: ${filename}.{js,css,scss}`);

    // Extensions possibles à chercher (source > build)
    const extensionsToSearch = [];
    if (originalPath.endsWith('.js') || originalPath.endsWith('.min.js')) {
      extensionsToSearch.push('.js');
    }
    if (originalPath.endsWith('.css') || originalPath.endsWith('.min.css')) {
      extensionsToSearch.push('.scss', '.css');
    }

    // Dossiers où chercher - utiliser les dossiers détectés dynamiquement
    const foldersToSearch = [
      PATHS.assetFolders.js,
      PATHS.assetFolders.css,
      PATHS.assetFolders.scss,
    ].filter(Boolean); // Retirer les valeurs undefined/null

    // Chercher dans tous les dossiers avec toutes les extensions
    for (const folder of foldersToSearch) {
      for (const ext of extensionsToSearch) {
        const searchPath = `${folder}/${filename}${ext}`;
        const absolutePath = resolve(PATHS.themePath, searchPath);

        if (existsSync(absolutePath)) {
          // console.log(`  ✓ Trouvé: ${searchPath}`);
          return searchPath;
        }
      }
    }

    // console.log(`  ✗ Aucune source trouvée pour: ${filename}`);
    return null;
  }

  // Chercher le fichier source par son nom (ignore les chemins)
  const foundSource = findSourceByFilename(pathWithoutBuild);
  if (foundSource) {
    return foundSource;
  }

  // Aucune source trouvée → garder le chemin tel quel (sera copié si existe, ou erreur)
  // console.log(`  → Garde le chemin d'origine: ${pathWithoutBuild}`);
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
    console.warn(`Erreur détection lib ${filePath}:`, err.message);
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
    editor: { sources: [], libs: [] },
    buildFolder: assets.buildFolder
  };

  // Traiter chaque contexte
  for (const context of ['front', 'admin', 'editor']) {
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
    ...result.editor.sources,
    ...result.editor.libs,
    ...result.front.sources,
    ...result.front.libs,
    ...result.admin.sources,
    ...result.admin.libs
  ]);

  // Compter les assets uniques par contexte en priorisant: editor > admin > front
  const displayCounts = {
    frontSources: 0,
    frontLibs: 0,
    adminSources: 0,
    adminLibs: 0,
    editorSources: 0,
    editorLibs: 0
  };

  allAssets.forEach(asset => {
    const isEditorSource = result.editor.sources.includes(asset);
    const isEditorLib = result.editor.libs.includes(asset);
    const isAdminSource = result.admin.sources.includes(asset);
    const isAdminLib = result.admin.libs.includes(asset);
    const isFrontSource = result.front.sources.includes(asset);
    const isFrontLib = result.front.libs.includes(asset);

    // Priorité: editor > admin > front (un asset n'est compté qu'une seule fois)
    if (isEditorSource || isEditorLib) {
      if (isEditorSource) displayCounts.editorSources++;
      if (isEditorLib) displayCounts.editorLibs++;
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
 * Détecte si le dossier de build utilise une structure plate ou avec sous-dossiers
 * @returns {Object} { isFlat, hasJsSubfolder, hasCssSubfolder }
 */
export function detectBuildStructure() {
  const buildPath = resolve(PATHS.themePath, PATHS.assetFolders.dist);

  // Si le dossier de build n'existe pas encore, supposer structure avec sous-dossiers
  if (!existsSync(buildPath)) {
    return {
      isFlat: false,
      hasJsSubfolder: true,
      hasCssSubfolder: true
    };
  }

  // Chercher les sous-dossiers js/ et css/ dans le dossier de build
  // (PAS les chemins sources - juste 'js' et 'css' comme noms de dossiers)
  const hasJsSubfolder = existsSync(resolve(buildPath, 'js'));
  const hasCssSubfolder = existsSync(resolve(buildPath, 'css'));

  return {
    isFlat: !hasJsSubfolder && !hasCssSubfolder,
    hasJsSubfolder,
    hasCssSubfolder
  };
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
    ...assets.editor.sources
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

    // Générer le nom de l'entrée en préservant la structure pour le build
    // Support des multi-level subdirectories : garder les 2 derniers segments
    // Utiliser un séparateur unique (§) pour éviter la confusion avec les tirets dans les noms de fichiers
    // Ex: assets/scripts/frontend/main.js → frontend§main
    // Ex: js-src/app-main.js → js-src§app-main (préserve les tirets originaux)
    // Ex: scss/style.scss → css§style (pour générer css/style.min.css)
    const pathWithoutExt = path.replace(/\.(js|ts|scss|css)$/, '');
    const pathParts = pathWithoutExt.split('/');

    let name;
    if (pathParts.length > 2) {
      // Multi-level : garder les 2 derniers segments (dossier parent + fichier)
      name = pathParts.slice(-2).join('§');
    } else {
      // Niveau simple : comportement standard
      name = pathParts.join('§');
    }

    // Si c'est un fichier SCSS, remplacer le préfixe du dossier source par le dossier de sortie CSS
    if (path.match(/\.scss$/)) {
      // Extraire le premier segment du path (ex: scss, styles, etc.)
      const sourceFolder = pathParts[0];
      name = name.replace(new RegExp(`^${sourceFolder}§`), `${PATHS.assetFolders.css}§`);
    }

    inputs[name] = absolutePath;
  });

  // Afficher les warnings pour les fichiers manquants
  if (missingFiles.length > 0) {
    console.warn(`\n${missingFiles.length} fichier(s) enqueue(s) introuvable(s):`);
    missingFiles.forEach(file => {
      console.warn(`   ${file} - Enqueue détecté mais fichier absent`);
    });
    console.warn(`   Le build continuera sans ces fichiers\n`);
  }

  return inputs;
}
