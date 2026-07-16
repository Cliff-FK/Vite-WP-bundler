import { PATHS, PHP_FILES_TO_SCAN } from '../paths.config.js';
import { existsSync, readdirSync, readFileSync, openSync, readSync, closeSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, join, sep, extname, dirname } from 'path';
import { spawnSync } from 'child_process';
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
    constants[constantName] = relativePath.replace(/^\//, ''); // Retirer seulement le / au début, garder celui de fin
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
  // Ex: 'dist'.'css/style.min.css' → 'dist/css/style.min.css' (sans espaces)
  // Stratégie : split sur '.' (avec espaces optionnels) puis retirer les quotes
  resolvedUrl = resolvedUrl
    .split(/'\s*\.\s*'/)  // Split sur '.' ou ' . '
    .map(segment => segment.replace(/^['"]|['"]$/g, '')) // Retirer quotes début/fin de chaque segment
    .join(''); // Recoller

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

  // Dossiers où chercher (par ordre de priorité)
  const foldersToSearch = [
    PATHS.assetFolders.scss,  // SCSS en premier (priorité)
    PATHS.assetFolders.js,
    PATHS.assetFolders.css,
  ].filter(Boolean);

  const candidates = [];

  // Chercher récursivement dans chaque dossier
  for (const folder of foldersToSearch) {
    const folderPath = resolve(PATHS.themePath, folder);
    const files = findFilesRecursive(folderPath, extensions);

    // Garder seulement les fichiers qui correspondent au nom de base
    // ET qui sont bien dans le dossier source (pas dans fonts/, vendors/, etc.)
    for (const file of files) {
      const fileBaseName = getBaseName(file);
      if (fileBaseName === baseName && file.startsWith(folder + '/')) {
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
    // Plusieurs candidats → trier par priorité (SCSS > JS > CSS)
    // Priorité : SCSS > JS > CSS, puis fichiers à la racine des dossiers sources
    const priorityFolders = [
      PATHS.assetFolders.scss,
      PATHS.assetFolders.js,
      PATHS.assetFolders.css,
    ].filter(Boolean);

    candidates.sort((a, b) => {
      // Trouver l'index de priorité pour chaque candidat
      const aPriority = priorityFolders.findIndex(folder => a.startsWith(folder + '/'));
      const bPriority = priorityFolders.findIndex(folder => b.startsWith(folder + '/'));

      // Si les deux sont dans des dossiers sources, comparer les priorités
      if (aPriority !== -1 && bPriority !== -1) {
        return aPriority - bPriority; // Plus petit index = plus haute priorité
      }

      // Sinon, mettre les fichiers sources en premier
      if (aPriority !== -1) return -1; // a est dans un dossier source
      if (bPriority !== -1) return 1;  // b est dans un dossier source

      return 0; // Aucune différence
    });

    // Prendre le premier (plus haute priorité)
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

    // 5. PARSER LES SCRIPTS (y compris wp_enqueue_script_module)

    // 5a. Parser les add_action avec fonctions anonymes
    const scriptBlockRegex = /add_action\s*\(\s*['"]([^'"]+)['"]\s*,\s*function\s*\([^)]*\)\s*\{([^}]*?wp_(?:register|enqueue)_script(?:_module)?[^}]*)\}/gs;

    // 5b. Parser les add_action avec fonctions nommées
    const namedFunctionRegex = /add_action\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"](\w+)['"]\s*\)/g;
    const namedFunctions = new Map();

    // D'abord, détecter toutes les fonctions nommées liées aux hooks
    let namedMatch;
    while ((namedMatch = namedFunctionRegex.exec(functionsContent)) !== null) {
      const hook = namedMatch[1];
      const functionName = namedMatch[2];

      // Chercher la définition de cette fonction
      const funcDefRegex = new RegExp(`function\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{([^]*?)\\n\\s*\\}`, 's');
      const funcDefMatch = funcDefRegex.exec(functionsContent);

      if (funcDefMatch && funcDefMatch[1].includes('wp_')) {
        namedFunctions.set(hook, funcDefMatch[1]);
      }
    }

    let blockMatch;

    // Parser les fonctions anonymes
    while ((blockMatch = scriptBlockRegex.exec(functionsContent)) !== null) {
      const hook = blockMatch[1];
      const functionBody = blockMatch[2];

      // Extraire les scripts enqueued (y compris script_module)
      // Capture seulement le 2ème argument (URL) jusqu'à la virgule suivante
      const scriptRegex = /wp_(?:register|enqueue)_script(?:_module)?\s*\([^,]+,\s*([^,]+?)(?=\s*,|\s*\))/g;
      let scriptMatch;

      while ((scriptMatch = scriptRegex.exec(functionBody)) !== null) {
        const urlPattern = scriptMatch[1].trim();

        // Résoudre l'URL complète avec constantes et variables
        let scriptPath = resolvePhpUrl(urlPattern, phpConstants, phpVariables);

        // Ignorer les URLs externes, les false/null, les variables JS et le code JS inline WordPress
        if (
          scriptPath.startsWith('http') ||
          scriptPath === 'false' ||
          scriptPath === 'null' ||
          !scriptPath.includes('.') ||
          scriptPath.startsWith('wp.') ||  // wp.domReady, wp.i18n, etc.
          scriptPath.includes('(')  // Code JS inline
        ) continue;

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

    // Parser les fonctions nommées détectées
    for (const [hook, functionBody] of namedFunctions) {
      const scriptRegex = /wp_(?:register|enqueue)_script(?:_module)?\s*\([^,]+,\s*([^,]+?)(?=\s*,|\s*\))/g;
      let scriptMatch;

      while ((scriptMatch = scriptRegex.exec(functionBody)) !== null) {
        const urlPattern = scriptMatch[1].trim();

        let scriptPath = resolvePhpUrl(urlPattern, phpConstants, phpVariables);

        // Ignorer les URLs externes, les false/null, les variables JS et le code JS inline WordPress
        if (
          scriptPath.startsWith('http') ||
          scriptPath === 'false' ||
          scriptPath === 'null' ||
          !scriptPath.includes('.') ||
          scriptPath.startsWith('wp.') ||  // wp.domReady, wp.i18n, etc.
          scriptPath.includes('(')  // Code JS inline
        ) continue;

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

    // 6a. Parser les fonctions anonymes
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

    // 6b. Parser les fonctions nommées pour les styles
    for (const [hook, functionBody] of namedFunctions) {
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

/**
 * ============================
 * DÉTECTION DES BLOCS (marqueurs natifs WP)
 * ============================
 * Un thème peut déclarer ses blocs par plusieurs technologies natives WordPress ; on les
 * parse TOUTES pour générer une entrée CSS par feuille de bloc (chargement conditionnel
 * côté WP via style_handles) :
 *   P1. block.json — marqueur canonique. Couvre aussi les collections de métadonnées
 *       (wp_register_block_metadata_collection) : le manifest n'est qu'un cache des block.json.
 *   P2. PHP — register_block_type(_from_metadata) à chemin statiquement résoluble ;
 *       wp_register_block_types_from_metadata_collection → racine de scan additionnelle ;
 *       forme nom+args : 'style'/'editor_style' => handle, résolu via wp_register_style
 *       puis remonté au fichier source (findSourceFile).
 *   P3. JS — registerBlockType( dans un JS source : le dossier du fichier déclarant est un bloc.
 * Règles communes : les *.scss DIRECTS d'un dossier de bloc (hors editor* — convention WP,
 * les styles éditeur s'enqueuent à part) deviennent chacun une entrée `<dossier>§<basename>` ;
 * la sortie ne garde que le basename → collision de basename = échec BRUYANT du build.
 * Appel non résoluble statiquement (chemin en variable, boucle) → listé au log, jamais avalé
 * en silence : le bloc reste couvert s'il porte un block.json. Rien trouvé → {}, comportement
 * stock du bundler.
 */

const BLOCK_SCAN_IGNORE = ['node_modules', 'vendor', '.git', '.vite', 'languages'];

/**
 * Liste (chemins absolus) des dossiers contenant un block.json sous une racine.
 * Les dossiers préfixés `_` sont privés/désactivés (même convention que les partials
 * Sass : archive de blocs, gabarits de base) → jamais traversés.
 */
function findBlockJsonDirs(rootAbs, ignoreDirs) {
  const dirs = [];
  if (!existsSync(rootAbs)) return dirs;

  const walk = (dir) => {
    let items;
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      if (item.isDirectory()) {
        if (!ignoreDirs.includes(item.name) && !item.name.startsWith('.') && !item.name.startsWith('_')) walk(join(dir, item.name));
      } else if (item.name === 'block.json') {
        dirs.push(dir);
      }
    }
  };

  walk(rootAbs);
  return dirs;
}

/**
 * Extrait les appels `nom( ... )` d'un source PHP/JS avec parenthésage équilibré
 * (les parenthèses/virgules dans les chaînes sont ignorées).
 * @returns {Array<{name: string, args: string}>} - args = blob brut entre les parenthèses
 */
function extractCalls(content, callNames) {
  const calls = [];
  const re = new RegExp(`\\b(${callNames.join('|')})\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(content)) !== null) {
    let depth = 1, i = re.lastIndex, quote = null;
    while (i < content.length && depth > 0) {
      const c = content[i];
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; }
      else if (c === "'" || c === '"') quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    calls.push({ name: m[1], args: content.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return calls;
}

/**
 * Split d'un blob d'arguments sur les virgules de premier niveau uniquement.
 */
function splitTopLevelArgs(blob) {
  const args = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < blob.length; i++) {
    const c = blob[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; }
    else if (c === "'" || c === '"') quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { args.push(blob.slice(start, i)); start = i + 1; }
  }
  args.push(blob.slice(start));
  return args.map(a => a.trim()).filter(Boolean);
}

/**
 * Résout statiquement une expression PHP de chemin : littéraux, __DIR__, helpers de thème,
 * constantes WP de chemin, concaténation `.`. Retourne un chemin absolu, ou null si un
 * segment n'est pas résoluble (variable, appel inconnu).
 */
function resolvePhpPathExpr(expr, phpDirAbs) {
  const tokenRe = /(__DIR__|get_template_directory\(\)|get_stylesheet_directory\(\)|get_theme_file_path\(\s*['"]([^'"]*)['"]\s*\)|ABSPATH|WP_CONTENT_DIR|WP_PLUGIN_DIR|'([^']*)'|"([^"]*)")\s*(?:\.\s*|$)/y;
  const src = expr.trim();
  let out = '', pos = 0;
  while (pos < src.length) {
    tokenRe.lastIndex = pos;
    const m = tokenRe.exec(src);
    if (!m) return null;
    const t = m[1];
    if (t === '__DIR__') out += phpDirAbs;
    else if (t.startsWith('get_template_directory') || t.startsWith('get_stylesheet_directory')) out += PATHS.themePath;
    else if (t.startsWith('get_theme_file_path')) out += join(PATHS.themePath, m[2]);
    else if (t === 'ABSPATH') out += PATHS.wpRoot + sep;
    else if (t === 'WP_CONTENT_DIR') out += join(PATHS.wpRoot, 'wp-content');
    else if (t === 'WP_PLUGIN_DIR') out += join(PATHS.wpRoot, 'wp-content', 'plugins');
    else out += m[3] !== undefined ? m[3] : m[4];
    pos = tokenRe.lastIndex;
  }
  return out ? out : null;
}

/**
 * Map handle → chemin buildé (relatif au thème) depuis les wp_register_style /
 * wp_enqueue_style du thème (réutilise la résolution constantes/variables existante).
 */
function buildStyleHandleMap(phpSources, allPhpContent) {
  const map = {};
  const constants = parsePhpConstants(allPhpContent);
  for (const { content } of phpSources) {
    for (const call of extractCalls(content, ['wp_register_style', 'wp_enqueue_style'])) {
      const [handleArg, urlArg] = splitTopLevelArgs(call.args);
      const h = handleArg && handleArg.match(/^['"]([^'"]+)['"]$/);
      if (!h || !urlArg) continue;
      const vars = parsePhpVariables(allPhpContent, extractVariablesFromUrl(urlArg));
      const url = resolvePhpUrl(urlArg, constants, vars)
        .replace(/get_(?:template|stylesheet)_directory_uri\(\)\s*(?:\.\s*)?/g, '')
        .replace(/^['"]|['"]$/g, '')
        .split('?')[0]
        .replace(/^\//, '');
      if (url && /\.css$/.test(url)) map[h[1]] = url;
    }
  }
  return map;
}

/**
 * Garde anti-collision de SORTIE sur l'ensemble des entrées Rollup FUSIONNÉES (entrées
 * classiques + entrées de blocs) : la sortie CSS ne garde que le basename (assetFileNames),
 * et le JS aussi en structure plate (entryFileNames) — deux entrées de même basename
 * s'écraseraient donc EN SILENCE dans le dist. Échec bruyant avec la liste des sources.
 * Complémentaire de la dédup interne de detectBlockCssInputs : elle voit les collisions
 * ENTRE ensembles (ex. un bloc nommé style.scss vs le style.min.css global), que chaque
 * générateur pris isolément ne peut pas voir.
 * @param {Object} inputs - Entrées Rollup fusionnées { clé: cheminAbsolu }
 * @param {boolean} isFlat - Structure de build plate (JS aussi réduit au basename)
 */
export function assertNoOutputCollisions(inputs, isFlat) {
  const outputs = new Map(); // fichier final → [sources]
  for (const [key, src] of Object.entries(inputs)) {
    const isCss = /\.(scss|css)$/.test(normalizePath(src));
    const base = key.split('§').pop();
    const out = isCss
      ? `${base}.min.css`
      : (isFlat ? `${base}.min.js` : `${key.replace(/§/g, '/')}.min.js`);
    if (!outputs.has(out)) outputs.set(out, []);
    outputs.get(out).push(normalizePath(src));
  }
  const clashes = [...outputs.entries()].filter(([, srcs]) => new Set(srcs).size > 1);
  if (clashes.length) {
    const detail = clashes
      .map(([out, srcs]) => `  ${out} serait produit par :\n    ${[...new Set(srcs)].join('\n    ')}`)
      .join('\n');
    throw new Error(`[block-detector] Collision de fichiers de sortie (écrasement silencieux évité) :\n${detail}`);
  }
}

/**
 * ---- Vérification « code vivant » via le registre WP à runtime ----
 * WP est le SEUL oracle fiable du vivant : l'enregistrement des blocs est dynamique
 * (boucles sur scandir, conditions, options en DB), donc statiquement indécidable.
 * On demande à WP-CLI la liste des blocs réellement enregistrés, avec :
 *   - cache (.cache/registered-blocks.json) invalidé par le mtime le plus récent des PHP
 *     du thème (l'enregistrement vit dans le PHP) + TTL 24 h en filet pour les changements
 *     côté DB (activation de plugin) → coût 0 ms en régime de croisière ;
 *   - dégradation propre : WP-CLI introuvable / WP ou DB down → vérification sautée avec
 *     log, jamais de dépendance dure au site pour builder.
 * Config .env : WP_CLI_BIN (binaire, défaut `wp` du PATH), VERIFY_BLOCKS_RUNTIME=false
 * pour couper, STRICT_LIVE_BLOCKS=true pour EXCLURE les blocs non enregistrés (défaut :
 * avertir seulement — l'exclusion par défaut rendrait le build non déterministe selon
 * l'état de la DB, et exclure à tort un bloc vivant casse la prod : risque asymétrique).
 */

const LIVE_CACHE_FILE = resolve(PATHS.bundlerRoot, '.cache', 'registered-blocks.json');
const LIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Liste des noms de blocs enregistrés côté WP (Set), ou null si l'oracle est indisponible.
 * @returns {{ names: Set<string>|null, via: string }} - via = 'cache' | 'wp-cli' | raison de l'échec
 */
function getRegisteredBlockNames(phpSources) {
  let maxMtime = 0;
  for (const { abs } of phpSources) {
    try { const t = statSync(abs).mtimeMs; if (t > maxMtime) maxMtime = t; } catch { /* ignoré */ }
  }
  const cacheKey = String(maxMtime);

  try {
    const c = JSON.parse(readFileSync(LIVE_CACHE_FILE, 'utf-8'));
    if (c.key === cacheKey && Date.now() - c.at < LIVE_CACHE_TTL_MS) {
      return { names: new Set(c.names), via: 'cache' };
    }
  } catch { /* cache absent/invalide → interroger */ }

  const bin = process.env.WP_CLI_BIN || 'wp';
  const code = 'echo json_encode(array_keys(WP_Block_Type_Registry::get_instance()->get_all_registered()));';
  // shell:true (obligatoire pour les .bat sous Windows) → commande pré-quotée
  const res = spawnSync(`"${bin}" eval "${code}" --path="${PATHS.wpRoot}"`, {
    shell: true,
    timeout: 20000,
    encoding: 'utf-8',
  });
  const jsonMatch = (res.stdout || '').match(/\[[^\]]*\]/s);
  if (res.status !== 0 || !jsonMatch) {
    const raison = (res.error && res.error.message) || (res.stderr || '').trim().split('\n').pop() || 'sortie WP-CLI vide';
    return { names: null, via: raison };
  }
  let names;
  try { names = JSON.parse(jsonMatch[0]); } catch { return { names: null, via: 'JSON WP-CLI invalide' }; }

  try {
    mkdirSync(dirname(LIVE_CACHE_FILE), { recursive: true });
    writeFileSync(LIVE_CACHE_FILE, JSON.stringify({ key: cacheKey, at: Date.now(), names }));
  } catch { /* cache non bloquant */ }

  return { names: new Set(names), via: 'wp-cli' };
}

/**
 * Génère les entrées Rollup CSS-par-bloc depuis TOUS les marqueurs natifs (P1/P2/P3).
 * @param {string} buildFolderName - Nom du dossier de build (exclu des scans)
 * @returns {Object} - Entrées { '<dossier>§<basename>': cheminAbsolu }
 */
export function detectBlockCssInputs(buildFolderName = PATHS.assetFolders.dist) {
  const inputs = {};
  const seen = new Map();          // basename → chemin source (collision bruyante)
  const blockDirs = new Set();     // dossiers de bloc (absolus normalisés)
  const report = { blockJson: 0, php: 0, js: 0, handles: 0, unresolved: [] };
  const ignoreDirs = [...new Set([...BLOCK_SCAN_IGNORE, buildFolderName])];
  const relTheme = (abs) => normalizePath(abs).replace(normalizePath(PATHS.themePath) + '/', '');
  const short = (s) => (s.length > 90 ? s.slice(0, 87) + '…' : s).replace(/\s+/g, ' ');

  const addBlockDir = (dirAbs, origin) => {
    const key = normalizePath(dirAbs);
    if (blockDirs.has(key)) return;
    blockDirs.add(key);
    report[origin]++;
  };

  const addSourceEntry = (srcAbs) => {
    const norm = normalizePath(srcAbs);
    const base = norm.split('/').pop().replace(/\.(scss|css)$/, '');
    if (base.startsWith('editor') || base.startsWith('_')) return; // styles éditeur et partials Sass
    const prev = seen.get(base);
    if (prev && prev !== norm) {
      throw new Error(`[block-detector] Collision de basename CSS de bloc : "${base}"\n  ${prev}\n  ${norm}`);
    }
    if (prev) return;
    seen.set(base, norm);
    inputs[`${norm.split('/').slice(-2, -1)[0]}§${base}`] = srcAbs;
  };

  // Un segment de chemin préfixé `_` = privé/désactivé (archive, gabarit) : hors détection
  const inPrivateDir = (rel) => /(^|\/)_/.test(normalizePath(rel));

  // ---- Parsing PHP (P2) : collecte racines de collections, dossiers directs, handles
  const phpSources = findFilesRecursive(PATHS.themePath, ['.php'], ignoreDirs)
    .filter((rel) => !inPrivateDir(rel))
    .map((rel) => {
      const abs = resolve(PATHS.themePath, rel);
      try { return { abs, content: readFileSync(abs, 'utf-8') }; } catch { return null; }
    })
    .filter(Boolean);
  const allPhpContent = phpSources.map((s) => s.content).join('\n');
  const collectionRoots = [];
  const phpBlockDirs = [];
  const handleSources = [];
  let handleMap = null; // construit à la demande (coût nul sans forme nom+args)

  for (const { abs, content } of phpSources) {
    if (!/register_block_type|metadata_collection/.test(content)) continue;

    // Collections de métadonnées → racines de scan block.json additionnelles
    for (const call of extractCalls(content, ['wp_register_block_types_from_metadata_collection', 'wp_register_block_metadata_collection'])) {
      const [pathArg] = splitTopLevelArgs(call.args);
      const p = pathArg && resolvePhpPathExpr(pathArg, dirname(abs));
      if (p && existsSync(p)) collectionRoots.push(p);
      else report.unresolved.push(`${relTheme(abs)} → ${call.name}(${short(pathArg || '')})`);
    }

    // register_block_type : forme chemin OU forme nom+args
    for (const call of extractCalls(content, ['register_block_type', 'register_block_type_from_metadata'])) {
      const args = splitTopLevelArgs(call.args);
      const arg1 = args[0] || '';
      const nameForm = arg1.match(/^['"]([\w-]+\/[\w-]+)['"]$/);

      if (nameForm) {
        // Forme nom+args : extraire les handles style/editor_style, remonter aux sources
        const styleHandles = [];
        const blob = args.slice(1).join(',');
        const hRe = /['"](?:style|editor_style)['"]\s*=>\s*(?:'([^']+)'|"([^"]+)"|(?:array\s*\(|\[)([^\])]*))/g;
        let hm;
        while ((hm = hRe.exec(blob)) !== null) {
          if (hm[3] !== undefined) {
            for (const part of hm[3].split(',')) {
              const q = part.trim().match(/^['"]([^'"]+)['"]$/);
              if (q) styleHandles.push(q[1]);
            }
          } else {
            styleHandles.push(hm[1] !== undefined ? hm[1] : hm[2]);
          }
        }
        if (!styleHandles.length) continue; // bloc sans style déclaré : rien à builder
        handleMap = handleMap || buildStyleHandleMap(phpSources, allPhpContent);
        for (const h of styleHandles) {
          const built = handleMap[h];
          const source = built && findSourceFile(built);
          if (source && /\.(scss|css)$/.test(source)) {
            handleSources.push(resolve(PATHS.themePath, source));
          } else {
            report.unresolved.push(`${relTheme(abs)} → bloc '${nameForm[1]}', handle '${h}' sans source retrouvable`);
          }
        }
      } else {
        const p = arg1 && resolvePhpPathExpr(arg1, dirname(abs));
        const dir = p && existsSync(p) ? (statSync(p).isDirectory() ? p : dirname(p)) : null;
        if (dir) phpBlockDirs.push(dir);
        else report.unresolved.push(`${relTheme(abs)} → ${call.name}(${short(arg1)})`);
      }
    }
  }

  // ---- P1 : block.json (thème + racines de collections) — marqueur canonique, prioritaire
  for (const root of [PATHS.themePath, ...collectionRoots]) {
    for (const dir of findBlockJsonDirs(root, ignoreDirs)) addBlockDir(dir, 'blockJson');
  }

  // ---- P2 : dossiers issus des chemins PHP résolus
  for (const dir of phpBlockDirs) addBlockDir(dir, 'php');

  // ---- P3 : registerBlockType( dans les JS sources
  const jsFiles = findFilesRecursive(PATHS.themePath, ['.js'], ignoreDirs)
    .filter((f) => !f.endsWith('.min.js') && !inPrivateDir(f));
  for (const rel of jsFiles) {
    const abs = resolve(PATHS.themePath, rel);
    let content;
    try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
    if (/\bregisterBlockType\s*\(/.test(content)) addBlockDir(dirname(abs), 'js');
  }

  // ---- Vérification « code vivant » : croisement avec le registre WP à runtime.
  // Ne s'applique qu'aux dossiers porteurs d'un block.json (server-registered) : les blocs
  // P3 (registerBlockType JS pur) sont client-side, absents du registre PHP par nature,
  // et les dossiers P2 sans block.json n'ont pas de nom à croiser.
  if (process.env.VERIFY_BLOCKS_RUNTIME !== 'false') {
    const strict = process.env.STRICT_LIVE_BLOCKS === 'true';
    const { names: registered, via } = getRegisteredBlockNames(phpSources);
    if (!registered) {
      console.log(`[block-detector] vérification runtime sautée (${via}) — détection statique seule`);
    } else {
      report.registryVia = `${registered.size} bloc(s) au registre WP (${via})`;
      for (const dir of [...blockDirs]) {
        let name = null;
        try { name = JSON.parse(readFileSync(join(dir, 'block.json'), 'utf-8')).name || null; } catch { /* pas de block.json */ }
        if (!name || registered.has(name)) continue;
        console.log(`[block-detector]   bloc '${name}' présent sur disque mais NON enregistré côté WP${strict ? ' → EXCLU' : ' → conservé (STRICT_LIVE_BLOCKS=true pour exclure)'} : ${relTheme(dir)}`);
        if (strict) blockDirs.delete(dir);
      }
    }
  }

  // ---- Entrées : *.scss directs de chaque dossier de bloc + sources résolues par handle
  for (const dir of blockDirs) {
    let files;
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (f.endsWith('.scss')) addSourceEntry(join(dir, f));
    }
  }
  for (const src of handleSources) {
    addSourceEntry(src);
    report.handles++;
  }

  // ---- Récapitulatif : détail gated par BLOCK_DETECTOR_VERBOSE=true (.env) — les ANOMALIES
  // (bloc non enregistré, vérification sautée) restent toujours visibles plus haut.
  const total = Object.keys(inputs).length;
  if (process.env.BLOCK_DETECTOR_VERBOSE === 'true' && (total || report.unresolved.length)) {
    console.log(`[block-detector] ${total} entrée(s) CSS de bloc — ${report.blockJson} bloc(s) via block.json, ${report.php} via chemin PHP, ${report.js} via registerBlockType JS${report.handles ? `, ${report.handles} source(s) via handle` : ''}${report.registryVia ? ` — vivant vérifié : ${report.registryVia}` : ''}`);
    for (const u of report.unresolved) {
      console.log(`[block-detector]   non résolu statiquement : ${u}`);
    }
  }

  return inputs;
}
