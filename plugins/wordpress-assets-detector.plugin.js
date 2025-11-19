import { PATHS, PHP_FILES_TO_SCAN } from '../paths.config.js';
import { existsSync, readdirSync, readFileSync, openSync, readSync, closeSync } from 'fs';
import { resolve, join, sep, extname } from 'path';
import { getCachedAssets, saveCachedAssets, deleteOldBuildFolder } from './cache-manager.plugin.js';

// Cache en mémoire des assets détectés pour éviter le double scan dans la même session
let cachedAssets = null;

/**
 * ============================
 * UTILITAIRES DE BASE
 * ============================
 */

/**
 * Normalise les séparateurs de chemin (Windows → Unix)
 */
function normalizePath(path) {
  return path.replace(/\\/g, '/');
}

/**
 * Extrait le nom de base d'un fichier sans .min et sans extension
 * Ex: js/components/slider.min.js → slider
 */
function getBaseName(filePath) {
  const fileName = filePath.split('/').pop();
  return fileName
    .replace(/\.min\.(js|css)$/, '.$1')
    .replace(/\.(js|css|scss)$/, '');
}

/**
 * Cherche récursivement des fichiers dans un dossier
 * @param {string} dir - Dossier de départ
 * @param {string[]} extensions - Extensions à chercher (ex: ['.js', '.scss'])
 * @param {string[]} ignoreDirs - Dossiers à ignorer
 * @returns {string[]} - Chemins relatifs depuis PATHS.themePath
 */
function findFilesRecursive(dir, extensions = [], ignoreDirs = ['node_modules', 'vendor', '.git', '.vite']) {
  const results = [];

  try {
    if (!existsSync(dir)) return results;

    const items = readdirSync(dir, { withFileTypes: true });

    for (const item of items) {
      if (ignoreDirs.includes(item.name)) continue;

      const fullPath = join(dir, item.name);

      if (item.isDirectory()) {
        results.push(...findFilesRecursive(fullPath, extensions, ignoreDirs));
      } else if (item.isFile()) {
        const ext = extname(item.name);
        if (extensions.length === 0 || extensions.includes(ext)) {
          // Convertir en chemin relatif depuis themePath
          const relativePath = normalizePath(fullPath.replace(PATHS.themePath + sep, ''));
          results.push(relativePath);
        }
      }
    }
  } catch (err) {
    // Ignorer les erreurs de lecture
  }

  return results;
}

/**
 * ============================
 * PARSING PHP
 * ============================
 */

/**
 * Parse les constantes PHP (define())
 * @returns {Object} - Map des constantes (ex: { JS_PATH: 'assets/js', OPTI_PATH_URI: 'dist' })
 */
function parsePhpConstants(phpContent) {
  const constants = {};

  // Pattern: define('CONSTANT_NAME', get_template_directory_uri() . '/path/to/folder')
  const defineRegex = /define\s*\(\s*['"]([\w_]+)['"]\s*,\s*get_template_directory(?:_uri)?\(\)\s*\.\s*['"]([^'"]+)['"]\s*\)/g;

  let match;
  while ((match = defineRegex.exec(phpContent)) !== null) {
    const constantName = match[1];
    const relativePath = match[2];
    constants[constantName] = relativePath.replace(/^\/|\/$/g, ''); // Nettoyer les /
  }

  return constants;
}

/**
 * Parse les variables PHP ($var = 'value')
 * @param {string} phpContent - Contenu PHP
 * @param {string[]} variablesToFind - Noms des variables à chercher (ex: ['theme_version', 'css_path'])
 * @returns {Object} - Map des variables trouvées
 */
function parsePhpVariables(phpContent, variablesToFind) {
  const variables = {};

  if (!variablesToFind || variablesToFind.length === 0) {
    return variables;
  }

  for (const varName of variablesToFind) {
    // Pattern: $varName = 'value' ou $varName = "value"
    const varRegex = new RegExp(`\\$${varName}\\s*=\\s*['"]([^'"]+)['"]`, 'g');
    const match = varRegex.exec(phpContent);

    if (match) {
      variables[varName] = match[1];
    }
  }

  return variables;
}

/**
 * Extrait les noms de variables utilisées dans une URL d'enqueue
 * Ex: $theme_version . '/css/style.css' → ['theme_version']
 * Ex: CSS_PATH . $suffix . '.css' → ['suffix']
 */
function extractVariablesFromUrl(urlPattern) {
  const variables = [];

  // Matcher $varName (avec le $)
  const varRegex = /\$(\w+)/g;
  let match;

  while ((match = varRegex.exec(urlPattern)) !== null) {
    variables.push(match[1]);
  }

  return [...new Set(variables)]; // Dédupliquer
}

/**
 * Résout une URL PHP avec constantes et variables
 * Ex: OPTI_PATH_URI . '/css/' . $suffix . '.css'
 * → 'dist/css/dark.css' (si OPTI_PATH_URI=dist, suffix=dark)
 */
function resolvePhpUrl(urlPattern, constants, variables) {
  let resolvedUrl = urlPattern;

  // 1. Remplacer les constantes (CONSTANT_NAME)
  for (const [constantName, constantValue] of Object.entries(constants)) {
    const regex = new RegExp(`\\b${constantName}\\b`, 'g');
    resolvedUrl = resolvedUrl.replace(regex, `'${constantValue}'`); // Entourer de quotes
  }

  // 2. Remplacer les variables ($varName)
  for (const [varName, varValue] of Object.entries(variables)) {
    const regex = new RegExp(`\\$${varName}\\b`, 'g');
    resolvedUrl = resolvedUrl.replace(regex, `'${varValue}'`); // Entourer de quotes
  }

  // 3. Nettoyer la concaténation PHP (. operator)
  // Ex: 'dist/' . 'css/' . 'style.min.css' → 'dist/css/style.min.css'
  resolvedUrl = resolvedUrl
    .replace(/['"]\s*\.\s*['"]/g, '') // Retirer . entre quotes ('xxx' . 'yyy' → 'xxxyyy')
    .replace(/^['"]|['"]$/g, ''); // Retirer quotes au début/fin

  return resolvedUrl;
}

/**
 * ============================
 * SIGNATURE MATCHING
 * ============================
 */

/**
 * Extrait une signature d'un fichier compilé (éléments immuables)
 * Signature = strings, nombres, sélecteurs CSS, APIs natives
 * (Ne PAS utiliser les noms de variables car ils changent en minification)
 */
function extractSignature(code, isJs = true) {
  const signature = {
    strings: [],
    numbers: [],
    selectors: [], // CSS uniquement
    apis: [] // JS uniquement
  };

  if (isJs) {
    // Strings: 'xxx' ou "xxx" (limite à 100 premiers)
    const stringRegex = /['"]([^'"]{3,50})['"]/g;
    let match;
    let count = 0;
    while ((match = stringRegex.exec(code)) !== null && count < 100) {
      signature.strings.push(match[1]);
      count++;
    }

    // Nombres (entiers et décimaux, limite à 50)
    const numberRegex = /\b(\d+\.?\d*)\b/g;
    count = 0;
    while ((match = numberRegex.exec(code)) !== null && count < 50) {
      signature.numbers.push(match[1]);
      count++;
    }

    // APIs natives JS (fetch, document., window., console., etc.)
    const apiPatterns = [
      /\b(fetch|querySelector|getElementById|addEventListener|setTimeout|setInterval|Math\.\w+|JSON\.\w+|localStorage\.\w+|sessionStorage\.\w+)\(/g
    ];

    for (const pattern of apiPatterns) {
      while ((match = pattern.exec(code)) !== null) {
        signature.apis.push(match[1]);
      }
    }
  } else {
    // CSS: extraire sélecteurs et valeurs

    // Sélecteurs (classe, ID, tag) - limite à 100
    const selectorRegex = /([.#]?[\w-]+)\s*\{/g;
    let match;
    let count = 0;
    while ((match = selectorRegex.exec(code)) !== null && count < 100) {
      signature.selectors.push(match[1]);
      count++;
    }

    // Strings dans les CSS (fonts, urls, etc.)
    const stringRegex = /['"]([^'"]{3,50})['"]/g;
    count = 0;
    while ((match = stringRegex.exec(code)) !== null && count < 50) {
      signature.strings.push(match[1]);
      count++;
    }

    // Nombres (dimensions, couleurs, etc.)
    const numberRegex = /:\s*([0-9.]+(?:px|em|rem|%|vh|vw)?)\b/g;
    count = 0;
    while ((match = numberRegex.exec(code)) !== null && count < 50) {
      signature.numbers.push(match[1]);
      count++;
    }
  }

  return signature;
}

/**
 * Calcule la similarité entre deux signatures (0-1)
 */
function calculateSimilarity(sig1, sig2) {
  const compareArrays = (arr1, arr2) => {
    if (arr1.length === 0 && arr2.length === 0) return 0;
    const set1 = new Set(arr1);
    const set2 = new Set(arr2);
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    return union.size > 0 ? intersection.size / union.size : 0;
  };

  const stringSim = compareArrays(sig1.strings, sig2.strings);
  const numberSim = compareArrays(sig1.numbers, sig2.numbers);
  const selectorSim = compareArrays(sig1.selectors, sig2.selectors);
  const apiSim = compareArrays(sig1.apis, sig2.apis);

  // Moyenne pondérée (strings et selectors/apis ont plus de poids)
  const weights = {
    strings: 0.4,
    numbers: 0.2,
    selectors: 0.3, // CSS
    apis: 0.3 // JS
  };

  const totalWeight = weights.strings + weights.numbers +
    (sig1.selectors.length > 0 ? weights.selectors : weights.apis);

  const weightedSum =
    stringSim * weights.strings +
    numberSim * weights.numbers +
    (sig1.selectors.length > 0 ? selectorSim * weights.selectors : apiSim * weights.apis);

  return weightedSum / totalWeight;
}

/**
 * Trouve le meilleur candidat par signature matching
 * @param {string} minifiedPath - Chemin du fichier minifié (relatif)
 * @param {string[]} candidates - Liste des candidats possibles (chemins relatifs)
 * @returns {string|null} - Meilleur candidat ou null
 */
function findBySignature(minifiedPath, candidates) {
  try {
    const minifiedFullPath = resolve(PATHS.themePath, minifiedPath);
    if (!existsSync(minifiedFullPath)) return null;

    const minifiedCode = readFileSync(minifiedFullPath, 'utf-8');
    const isJs = minifiedPath.endsWith('.js');
    const minifiedSig = extractSignature(minifiedCode, isJs);

    let bestMatch = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const candidateFullPath = resolve(PATHS.themePath, candidate);
      if (!existsSync(candidateFullPath)) continue;

      const candidateCode = readFileSync(candidateFullPath, 'utf-8');
      const candidateSig = extractSignature(candidateCode, isJs);

      const score = calculateSimilarity(minifiedSig, candidateSig);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = candidate;
      }
    }

    // Seuil de confiance: au moins 30% de similarité
    return bestScore >= 0.3 ? bestMatch : null;

  } catch (err) {
    console.warn(`Erreur signature matching pour ${minifiedPath}:`, err.message);
    return null;
  }
}

/**
 * ============================
 * RECHERCHE DE FICHIERS SOURCES
 * ============================
 */

/**
 * Retire le préfixe de dossier de build d'un chemin
 * Ex: dist/css/components/slider.min.css → css/components/slider.min.css
 * Ex: optimised/js/main.min.js → js/main.min.js
 */
function removeBuildPrefix(path) {
  const buildPatterns = ['dist', 'build', 'optimised', 'optimized', 'compiled', 'bundle', 'public', 'assets', 'output'];

  for (const pattern of buildPatterns) {
    if (path.startsWith(pattern + '/')) {
      return path.substring(pattern.length + 1);
    }
  }

  return path;
}

/**
 * PRIORITÉ 1: Recherche par arborescence préservée
 * Ex: dist/css/components/slider.min.css → sources/scss/components/slider.scss
 *
 * @param {string} minifiedPath - Chemin du fichier minifié (peut inclure build prefix)
 * @returns {string[]|null} - Liste des candidats trouvés ou null
 */
function searchWithPreservedPath(minifiedPath) {
  // 1. Retirer le préfixe de build
  const pathWithoutBuild = removeBuildPrefix(minifiedPath);

  // 2. Extraire l'arborescence et le nom de fichier
  // Ex: css/components/slider.min.css → { dir: 'components', base: 'slider' }
  const pathParts = pathWithoutBuild.split('/');
  const fileName = pathParts.pop();

  // IMPORTANT: Retirer le premier segment si c'est 'js' ou 'css'
  // Car en build: dist/css/style.min.css mais en source: sources/scss/style.scss
  const firstSegment = pathParts[0];
  if (firstSegment === 'js' || firstSegment === 'css') {
    pathParts.shift(); // Retirer le premier élément
  }

  const dirStructure = pathParts.join('/'); // Peut être vide si fichier à la racine

  const baseName = getBaseName(fileName);
  const isJs = fileName.endsWith('.js') || fileName.endsWith('.min.js');

  // 3. Extensions à chercher
  const extensions = isJs ? ['.js'] : ['.scss', '.css'];

  // 4. Dossiers sources où chercher
  const sourceFolders = [
    PATHS.assetFolders.js,
    PATHS.assetFolders.scss,
    PATHS.assetFolders.css,
    PATHS.assetFolders.publicDir // Ex: sources/, assets/, etc.
  ].filter(Boolean);

  const candidates = [];

  // 5. Chercher dans chaque dossier source avec la structure préservée
  for (const sourceFolder of sourceFolders) {
    for (const ext of extensions) {
      // Construire le chemin avec arborescence préservée
      // Ex: sources/scss/components/slider.scss (si dirStructure = 'components')
      // Ex: sources/scss/style.scss (si dirStructure vide)
      const candidatePath = dirStructure
        ? `${sourceFolder}/${dirStructure}/${baseName}${ext}`
        : `${sourceFolder}/${baseName}${ext}`;
      const absolutePath = resolve(PATHS.themePath, candidatePath);

      if (existsSync(absolutePath)) {
        candidates.push(candidatePath);
      }
    }
  }

  return candidates.length > 0 ? candidates : null;
}

/**
 * FALLBACK: Recherche par nom de fichier uniquement (ignore l'arborescence)
 * @param {string} minifiedPath - Chemin du fichier minifié
 * @returns {string[]|null} - Liste des candidats trouvés ou null
 */
function searchByFilename(minifiedPath) {
  const pathWithoutBuild = removeBuildPrefix(minifiedPath);
  const baseName = getBaseName(pathWithoutBuild);
  const isJs = pathWithoutBuild.endsWith('.js') || pathWithoutBuild.endsWith('.min.js');

  const extensions = isJs ? ['.js'] : ['.scss', '.css'];

  // Dossiers où chercher
  const foldersToSearch = [
    PATHS.assetFolders.js,
    PATHS.assetFolders.css,
    PATHS.assetFolders.scss,
  ].filter(Boolean);

  const candidates = [];

  // Chercher récursivement dans chaque dossier
  for (const folder of foldersToSearch) {
    const folderPath = resolve(PATHS.themePath, folder);
    const files = findFilesRecursive(folderPath, extensions);

    // Garder seulement les fichiers qui correspondent au nom de base
    for (const file of files) {
      const fileBaseName = getBaseName(file);
      if (fileBaseName === baseName) {
        candidates.push(file);
      }
    }
  }

  return candidates.length > 0 ? candidates : null;
}

/**
 * Fonction principale: trouve le fichier source depuis un chemin minifié
 * Stratégie hybride:
 *   1. Chercher avec arborescence préservée
 *   2. Si plusieurs candidats → signature matching
 *   3. Sinon fallback: chercher par nom uniquement
 */
function findSourceFile(minifiedPath) {
  // PRIORITÉ 1: Arborescence préservée
  let candidates = searchWithPreservedPath(minifiedPath);

  if (candidates && candidates.length === 1) {
    return candidates[0]; // Trouvé directement
  }

  if (candidates && candidates.length > 1) {
    // Plusieurs candidats → signature matching
    const bestMatch = findBySignature(minifiedPath, candidates);
    if (bestMatch) return bestMatch;

    // Fallback: prendre le premier candidat
    return candidates[0];
  }

  // FALLBACK: Chercher par nom uniquement
  candidates = searchByFilename(minifiedPath);

  if (candidates && candidates.length === 1) {
    return candidates[0];
  }

  if (candidates && candidates.length > 1) {
    // Signature matching
    const bestMatch = findBySignature(minifiedPath, candidates);
    if (bestMatch) return bestMatch;

    // Fallback: prendre le premier
    return candidates[0];
  }

  // Aucun candidat trouvé
  return null;
}

/**
 * ============================
 * DÉTECTION DES ASSETS WORDPRESS
 * ============================
 */

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

    // 1. PARSER LES CONSTANTES PHP (define())
    const phpConstants = parsePhpConstants(functionsContent);

    // 2. Détecter toutes les variables utilisées dans les enqueues
    const allEnqueueUrls = [];

    // Extraire toutes les URLs des enqueues (scripts + styles)
    const allEnqueueRegex = /wp_(?:register|enqueue)_(?:script|style)\s*\([^,]+,\s*([^)]+)\)/g;
    let match;
    while ((match = allEnqueueRegex.exec(functionsContent)) !== null) {
      allEnqueueUrls.push(match[1]);
    }

    // Extraire toutes les variables utilisées dans ces URLs
    const allVariables = new Set();
    for (const url of allEnqueueUrls) {
      const vars = extractVariablesFromUrl(url);
      vars.forEach(v => allVariables.add(v));
    }

    // 3. PARSER LES VARIABLES PHP (uniquement celles utilisées)
    const phpVariables = parsePhpVariables(functionsContent, Array.from(allVariables));

    // 4. Détecter buildFolder
    let buildFolder = PATHS.assetFolders.dist;
    const buildFolderMatch = functionsContent.match(/define\s*\(\s*['"]OPTI_PATH(?:_URI)?\s*['"]\s*,\s*[^'"]*['"]([^'"]+)\//);
    if (buildFolderMatch) {
      buildFolder = buildFolderMatch[1];
    }

    const assets = {
      front: { scripts: [], styles: [] },
      admin: { scripts: [], styles: [] },
      editor: { scripts: [], styles: [] },
      buildFolder
    };

    // 5. PARSER LES SCRIPTS
    const scriptBlockRegex = /add_action\s*\(\s*['"]([^'"]+)['"]\s*,\s*function\s*\([^)]*\)\s*\{([^}]*?wp_(?:register|enqueue)_script[^}]*)\}/gs;

    let blockMatch;
    while ((blockMatch = scriptBlockRegex.exec(functionsContent)) !== null) {
      const hook = blockMatch[1];
      const functionBody = blockMatch[2];

      // Extraire les scripts enqueued
      // Capture seulement le 2ème argument (URL) jusqu'à la virgule suivante
      const scriptRegex = /wp_(?:register|enqueue)_script\s*\([^,]+,\s*([^,]+?)(?=\s*,|\s*\))/g;
      let scriptMatch;

      while ((scriptMatch = scriptRegex.exec(functionBody)) !== null) {
        const urlPattern = scriptMatch[1].trim();

        // Résoudre l'URL complète avec constantes et variables
        let scriptPath = resolvePhpUrl(urlPattern, phpConstants, phpVariables);

        // Ignorer les URLs externes
        if (scriptPath.startsWith('http')) continue;

        // Convertir build → source avec la nouvelle logique
        const sourcePath = findSourceFile(scriptPath);
        if (!sourcePath) {
          console.warn(`   ⚠ Source introuvable pour: ${scriptPath}`);
          continue;
        }

        scriptPath = sourcePath;

        // Catégoriser selon le hook
        if (hook.includes('wp_enqueue_scripts')) {
          if (!assets.front.scripts.includes(scriptPath)) {
            assets.front.scripts.push(scriptPath);
          }
        } else if (hook.includes('enqueue_block_editor_assets')) {
          if (!assets.editor.scripts.includes(scriptPath)) {
            assets.editor.scripts.push(scriptPath);
          }
        } else if (hook.includes('enqueue_block_assets')) {
          if (!assets.front.scripts.includes(scriptPath)) {
            assets.front.scripts.push(scriptPath);
          }
          if (!assets.editor.scripts.includes(scriptPath)) {
            assets.editor.scripts.push(scriptPath);
          }
        } else if (hook.includes('admin') || hook.includes('login') || hook.includes('customize_register')) {
          if (!assets.admin.scripts.includes(scriptPath)) {
            assets.admin.scripts.push(scriptPath);
          }
        } else {
          if (!assets.admin.scripts.includes(scriptPath)) {
            assets.admin.scripts.push(scriptPath);
          }
        }
      }
    }

    // 6. PARSER LES STYLES
    const styleBlockRegex = /add_action\s*\(\s*['"]([^'"]+)['"]\s*,\s*function\s*\([^)]*\)\s*\{([^}]*?wp_(?:register|enqueue)_style[^}]*)\}/gs;

    while ((blockMatch = styleBlockRegex.exec(functionsContent)) !== null) {
      const hook = blockMatch[1];
      const functionBody = blockMatch[2];

      // Capture seulement le 2ème argument (URL) jusqu'à la virgule suivante
      const styleRegex = /wp_(?:register|enqueue)_style\s*\([^,]+,\s*([^,]+?)(?=\s*,|\s*\))/g;
      let styleMatch;

      while ((styleMatch = styleRegex.exec(functionBody)) !== null) {
        const urlPattern = styleMatch[1].trim();

        let stylePath = resolvePhpUrl(urlPattern, phpConstants, phpVariables);

        if (stylePath.startsWith('http')) continue;

        const sourcePath = findSourceFile(stylePath);
        if (!sourcePath) {
          console.warn(`   ⚠ Source introuvable pour: ${stylePath}`);
          continue;
        }

        stylePath = sourcePath;

        if (hook.includes('wp_enqueue_scripts')) {
          if (!assets.front.styles.includes(stylePath)) {
            assets.front.styles.push(stylePath);
          }
        } else if (hook.includes('enqueue_block_editor_assets')) {
          if (!assets.editor.styles.includes(stylePath)) {
            assets.editor.styles.push(stylePath);
          }
        } else if (hook.includes('enqueue_block_assets')) {
          if (!assets.front.styles.includes(stylePath)) {
            assets.front.styles.push(stylePath);
          }
          if (!assets.editor.styles.includes(stylePath)) {
            assets.editor.styles.push(stylePath);
          }
        } else if (hook.includes('admin') || hook.includes('login') || hook.includes('customize_register')) {
          if (!assets.admin.styles.includes(stylePath)) {
            assets.admin.styles.push(stylePath);
          }
        } else {
          if (!assets.admin.styles.includes(stylePath)) {
            assets.admin.styles.push(stylePath);
          }
        }
      }
    }

    // 7. PARSER add_editor_style()
    const editorStyleRegex = /add_editor_style\s*\(\s*([^)]+)\)/g;
    let editorMatch;

    while ((editorMatch = editorStyleRegex.exec(functionsContent)) !== null) {
      const urlPattern = editorMatch[1].trim();

      let stylePath = resolvePhpUrl(urlPattern, phpConstants, phpVariables);

      if (stylePath.startsWith('http')) continue;

      const sourcePath = findSourceFile(stylePath);
      if (!sourcePath) {
        console.warn(`   ⚠ Source introuvable pour: ${stylePath}`);
        continue;
      }

      stylePath = sourcePath;

      if (!assets.editor.styles.includes(stylePath)) {
        assets.editor.styles.push(stylePath);
      }
    }

    // Séparer sources vs libs
    const result = categorizeAssets(assets);

    // Si buildFolder a changé, supprimer l'ancien
    if (oldBuildFolder && oldBuildFolder !== result.buildFolder) {
      deleteOldBuildFolder(oldBuildFolder);
    }

    // Mettre en cache
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

    cachedAssets = errorResult;
    return errorResult;
  }
}

/**
 * Détecte si un fichier est une librairie (analyse du contenu)
 */
function isLibrary(filePath) {
  try {
    const absolutePath = resolve(PATHS.themePath, filePath);
    if (!existsSync(absolutePath)) return false;

    const fd = openSync(absolutePath, 'r');
    const buffer = Buffer.alloc(2000);
    const bytesRead = readSync(fd, buffer, 0, 2000, 0);
    closeSync(fd);
    const content = buffer.toString('utf-8', 0, bytesRead);

    if (/^\/\*[!*]?\s*(?:@preserve|@license|@version|@name|\w+\s+v\d+\.\d+)/i.test(content)) {
      return true;
    }

    const firstLine = content.split('\n')[0];
    if (firstLine.length > 500) {
      return true;
    }

    const hasMinifiedPattern =
      /[a-z]\.[a-z]{1,3}\(/.test(content) &&
      !/\n\s{2,}/.test(content.substring(0, 500));

    if (hasMinifiedPattern) {
      return true;
    }

    const basename = filePath.split('/').pop().replace(/\.min\.(js|css)$/, '');
    const KNOWN_SOURCES = ['main', 'style', 'admin', 'editor'];

    if (filePath.includes('.min.')) {
      return !KNOWN_SOURCES.includes(basename);
    }

    return false;

  } catch (err) {
    console.warn(`Erreur détection lib ${filePath}:`, err.message);
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

  for (const context of ['front', 'admin', 'editor']) {
    for (const script of assets[context].scripts) {
      if (isLibrary(script)) {
        result[context].libs.push(script);
      } else {
        result[context].sources.push(script);
      }
    }

    for (const style of assets[context].styles) {
      if (isLibrary(style)) {
        result[context].libs.push(style);
      } else {
        result[context].sources.push(style);
      }
    }
  }

  return result;
}

/**
 * Détecte si le dossier de build utilise une structure plate ou avec sous-dossiers
 */
export function detectBuildStructure() {
  const buildPath = resolve(PATHS.themePath, PATHS.assetFolders.dist);

  if (!existsSync(buildPath)) {
    return {
      isFlat: false,
      hasJsSubfolder: true,
      hasCssSubfolder: true
    };
  }

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
 */
export function generateRollupInputs(assets) {
  const inputs = {};
  const missingFiles = [];

  const allSources = [
    ...assets.front.sources,
    ...assets.admin.sources,
    ...assets.editor.sources
  ];

  const uniqueSources = [...new Set(allSources)];

  uniqueSources.forEach(path => {
    const absolutePath = resolve(PATHS.themePath, path);

    if (!existsSync(absolutePath)) {
      missingFiles.push(path);
      return;
    }

    const pathWithoutExt = path.replace(/\.(js|ts|scss|css)$/, '');
    const pathParts = pathWithoutExt.split('/');

    let name;
    if (pathParts.length > 2) {
      name = pathParts.slice(-2).join('§');
    } else {
      name = pathParts.join('§');
    }

    if (path.match(/\.scss$/)) {
      const sourceFolder = pathParts[0];
      name = name.replace(new RegExp(`^${sourceFolder}§`), `${PATHS.assetFolders.css}§`);
    }

    inputs[name] = absolutePath;
  });

  if (missingFiles.length > 0) {
    console.warn(`\n${missingFiles.length} fichier(s) enqueue(s) introuvable(s):`);
    missingFiles.forEach(file => {
      console.warn(`   ${file} - Enqueue détecté mais fichier absent`);
    });
    console.warn(`   Le build continuera sans ces fichiers\n`);
  }

  return inputs;
}
