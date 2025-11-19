import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { config } from 'dotenv';
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';

// Charger les variables d'environnement
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '.env') });

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Racine du projet WordPress (parent du dossier vite-wp-bundler)
const WP_ROOT = resolve(__dirname, '../');

/**
 * Détecter automatiquement le chemin de base WordPress
 * Si WP_BASE_PATH est défini, l'utiliser, sinon tenter de détecter automatiquement
 */
function getWpBasePath() {
  if (process.env.WP_BASE_PATH) {
    return process.env.WP_BASE_PATH;
  }

  // Nom du dossier racine web (htdocs, www, public_html, etc.)
  const webRootFolder = process.env.WEB_ROOT_FOLDER || 'htdocs';

  // Détection automatique : extraire le chemin depuis WP_ROOT
  // Par exemple: C:\MAMP\htdocs\gambetta\site-gambetta-2025 -> /gambetta/site-gambetta-2025
  const wpRootNormalized = WP_ROOT.replace(/\\/g, '/');
  const webRootPattern = new RegExp(`/${webRootFolder}/(.+)$`);
  const webRootMatch = wpRootNormalized.match(webRootPattern);

  if (webRootMatch) {
    return '/' + webRootMatch[1];
  }

  // Si pas de détection, retourner vide (racine)
  return '';
}

const WP_BASE_PATH = getWpBasePath();
const WP_PORT = parseInt(process.env.WP_PORT || '80');
const WP_HOST = process.env.WP_HOST || 'localhost';
const WP_PROTOCOL = process.env.WP_PROTOCOL || 'http';

// Construire l'URL WordPress complète
// Si port 80 ou 443, ne pas l'afficher dans l'URL
const portDisplay = (WP_PORT === 80 && WP_PROTOCOL === 'http') || (WP_PORT === 443 && WP_PROTOCOL === 'https')
  ? ''
  : `:${WP_PORT}`;

const WP_URL = `${WP_PROTOCOL}://${WP_HOST}${portDisplay}${WP_BASE_PATH}`;

/**
 * Configuration centralisée de tous les chemins du projet
 * Tous les chemins sont paramétrables via le fichier .env
 */

// Validation : THEME_NAME est obligatoire
if (!process.env.THEME_NAME) {
  throw new Error(
    '❌ THEME_NAME is required in .env file.\n' +
    '   Example: THEME_NAME=themezero'
  );
}

const WP_THEMES_PATH = process.env.WP_THEMES_PATH || 'wp-content/themes';
const THEME_NAME = process.env.THEME_NAME;
const THEME_PATH_FULL = `${WP_THEMES_PATH}/${THEME_NAME}`;

/**
 * Auto-détecte les dossiers d'assets en scannant le système de fichiers
 * Cherche RÉCURSIVEMENT les dossiers contenant des fichiers .js, .scss, .css
 * ET détecte le dossier de build en identifiant les dossiers qui NE SONT PAS des sources
 */
function detectAssetFolders() {
  const themePath = resolve(WP_ROOT, THEME_PATH_FULL);
  const folders = { js: 'js', css: 'css', scss: 'scss', dist: 'dist' };

  if (!existsSync(themePath)) {
    return folders; // Fallback sur conventions
  }

  try {
    const ignoreDirs = ['node_modules', 'vendor', '.git', '.vite', 'inc', 'includes', 'languages', 'acf-json'];

    // Fonction récursive pour scanner les dossiers
    function findFolderWithExtension(basePath, extensions, excludeMinified = false, maxDepth = 3, currentDepth = 0) {
      if (currentDepth >= maxDepth) return null;

      const dirs = readdirSync(basePath, { withFileTypes: true })
        .filter(d => d.isDirectory() && !ignoreDirs.includes(d.name))
        .map(d => d.name);

      for (const dir of dirs) {
        const dirPath = join(basePath, dir);

        try {
          const files = readdirSync(dirPath);
          const hasMatchingFiles = files.some(f => {
            const matchesExt = extensions.some(ext => f.endsWith(ext));
            const isNotMinified = excludeMinified ? !f.endsWith('.min.js') && !f.endsWith('.min.css') : true;
            return matchesExt && isNotMinified;
          });

          if (hasMatchingFiles) {
            // Retourner le chemin relatif depuis themePath
            // Normaliser les slashes pour Windows
            const normalizedDirPath = dirPath.replace(/\\/g, '/');
            const normalizedThemePath = themePath.replace(/\\/g, '/');
            return normalizedDirPath.replace(normalizedThemePath + '/', '');
          }

          // Chercher récursivement dans les sous-dossiers
          const subResult = findFolderWithExtension(dirPath, extensions, excludeMinified, maxDepth, currentDepth + 1);
          if (subResult) {
            return subResult;
          }
        } catch (err) {
          // Ignorer les erreurs de lecture
        }
      }

      return null;
    }

    const sourceFolders = new Set();

    // Chercher dossier contenant .js (récursif, max 3 niveaux)
    const jsFolder = findFolderWithExtension(themePath, ['.js'], true);
    if (jsFolder) {
      folders.js = jsFolder;
      sourceFolders.add(jsFolder.toLowerCase());
    }

    // Chercher dossier contenant .scss (récursif)
    const scssFolder = findFolderWithExtension(themePath, ['.scss'], false);
    if (scssFolder) {
      folders.scss = scssFolder;
      sourceFolders.add(scssFolder.toLowerCase());
    }

    // Chercher dossier contenant .css (récursif)
    const cssFolder = findFolderWithExtension(themePath, ['.css'], true);
    if (cssFolder) {
      folders.css = cssFolder;
      sourceFolders.add(cssFolder.toLowerCase());
    }

    const dirs = readdirSync(themePath, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    // Détecter le dossier de build : tout dossier qui n'est PAS un dossier source
    // ni un dossier système/WordPress courant
    const commonIgnoreFolders = ['node_modules', 'vendor', 'images', 'fonts', 'inc', 'includes', 'templates', 'template-parts', 'languages', 'acf-json'];

    // Liste des noms de dossiers qui indiquent clairement un dossier de build
    const buildFolderPatterns = ['dist', 'build', 'optimized', 'optimised', 'compiled', 'bundle', 'assets', 'output', 'public'];

    // Chercher un dossier qui correspond aux patterns de build
    for (const dir of dirs) {
      const dirLower = dir.toLowerCase();

      // Ignorer les dossiers sources et les dossiers communs WordPress/système
      if (sourceFolders.has(dirLower) || commonIgnoreFolders.includes(dirLower)) {
        continue;
      }

      // Si le nom du dossier correspond à un pattern de build, on l'utilise
      if (buildFolderPatterns.some(pattern => dirLower.includes(pattern))) {
        folders.dist = dir;
        break;
      }
    }

    // Si aucun dossier de build n'a été trouvé via les patterns,
    // chercher un dossier qui contient déjà des fichiers .min.js ou .min.css
    if (folders.dist === 'dist') {
      for (const dir of dirs) {
        const dirLower = dir.toLowerCase();

        if (sourceFolders.has(dirLower) || commonIgnoreFolders.includes(dirLower)) {
          continue;
        }

        const dirPath = join(themePath, dir);
        try {
          const files = readdirSync(dirPath);
          if (files.some(f => f.endsWith('.min.js') || f.endsWith('.min.css'))) {
            folders.dist = dir;
            break;
          }
        } catch (err) {
          // Ignorer les erreurs de lecture
        }
      }
    }
  } catch (err) {
    // En cas d'erreur, utiliser les conventions
  }

  return folders;
}

const detectedFolders = detectAssetFolders();

/**
 * Détecte dynamiquement les dossiers d'assets statiques
 */
function detectStaticAssetFolders() {
  const themePath = resolve(WP_ROOT, THEME_PATH_FULL);
  const folders = { images: null, fonts: null, includes: null, includesDest: null };

  try {
    const themeFiles = readdirSync(themePath, { withFileTypes: true });

    // Chercher un dossier contenant images
    const imagesFolders = themeFiles.filter(f =>
      f.isDirectory() && (f.name === 'sources' || f.name === 'assets' || f.name === 'src')
    );
    for (const folder of imagesFolders) {
      const folderPath = resolve(themePath, folder.name);
      const subFiles = readdirSync(folderPath, { withFileTypes: true });
      if (subFiles.some(f => f.isDirectory() && f.name === 'images')) {
        folders.images = `${folder.name}/images`;
        break;
      }
    }

    // Chercher un dossier contenant fonts
    for (const folder of imagesFolders) {
      const folderPath = resolve(themePath, folder.name);
      const subFiles = readdirSync(folderPath, { withFileTypes: true });
      if (subFiles.some(f => f.isDirectory() && f.name === 'fonts')) {
        folders.fonts = `${folder.name}/fonts`;
        break;
      }
    }

    // Chercher un dossier includes/inc
    if (themeFiles.some(f => f.isDirectory() && f.name === 'includes')) {
      folders.includes = 'includes';
      folders.includesDest = 'inc';
    } else if (themeFiles.some(f => f.isDirectory() && f.name === 'inc')) {
      folders.includes = 'inc';
      folders.includesDest = 'inc';
    }

  } catch (err) {
    // Silencieux
  }

  return folders;
}

const detectedStaticFolders = detectStaticAssetFolders();

const ASSET_FOLDERS = {
  dist: detectedFolders.dist,
  js: detectedFolders.js,
  css: detectedFolders.css,
  scss: detectedFolders.scss,
  images: detectedStaticFolders.images,
  fonts: detectedStaticFolders.fonts,
  includes: detectedStaticFolders.includes,
  includesDest: detectedStaticFolders.includesDest,
};

export const PATHS = {
  // WordPress
  wpRoot: WP_ROOT,
  wpBasePath: WP_BASE_PATH,
  wpUrl: WP_URL,
  wpPort: WP_PORT,
  wpHost: WP_HOST,
  wpProtocol: WP_PROTOCOL,

  // Thème
  themePath: resolve(WP_ROOT, THEME_PATH_FULL),
  themeUrl: `${WP_URL}/${THEME_PATH_FULL}`,
  themeName: THEME_NAME,
  themePathRelative: THEME_PATH_FULL, // Chemin relatif depuis la racine WP

  // Noms des dossiers d'assets (configurables)
  assetFolders: ASSET_FOLDERS,

  // Assets du thème (chemins absolus système)
  themeDist: resolve(WP_ROOT, THEME_PATH_FULL, ASSET_FOLDERS.dist),

  // Assets du thème (chemins URL relatifs pour les regex)
  themeDistUrl: `/${THEME_PATH_FULL}/${ASSET_FOLDERS.dist}`,

  // Bundler
  bundlerRoot: __dirname,

  // Vite
  viteHost: process.env.VITE_HOST || 'localhost',
  vitePort: parseInt(process.env.VITE_PORT || '5173'),
  viteUrl: `http://${process.env.VITE_HOST || 'localhost'}:${process.env.VITE_PORT || '5173'}`,
  viteClientUrl: `http://${process.env.VITE_HOST || 'localhost'}:${process.env.VITE_PORT || '5173'}/@vite/client`,
};

/**
 * Active le reload PHP si configuré (défaut: true)
 */
export const WATCH_PHP = process.env.WATCH_PHP !== 'false';

/**
 * Active le HMR Body Reset pour JavaScript si configuré (défaut: true)
 */
export const HMR_BODY_RESET = process.env.HMR_BODY_RESET !== 'false';

/**
 * Active l'auto-incrément de la version du thème à la fermeture du mode dev (défaut: true)
 */
export const AUTO_INCREMENT_VERSION = process.env.AUTO_INCREMENT_VERSION !== 'false';

/**
 * Liste des fichiers PHP à scanner pour détecter les enqueues
 * Par défaut: ['functions.php']
 * Exemple: ['functions.php', 'inc/enqueue.php', 'lib/assets.php']
 */
export const PHP_FILES_TO_SCAN = process.env.VITE_PHP_FILES
  ? process.env.VITE_PHP_FILES.split(',').map(f => f.trim())
  : ['functions.php'];

/**
 * Dossier de destination du build
 * Null pour utiliser la détection automatique depuis functions.php
 */
export const BUILD_FOLDER = null;

