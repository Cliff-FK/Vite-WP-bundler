/**
 * Custom Sass Importer pour supporter les imports glob dans SCSS
 *
 * Syntaxes supportées:
 * - @import "vendors/*.scss";
 * - @import "utilities/star-star/star.scss"; (utilise ** pour récursif)
 * - @import "../components/star-star/star.scss";
 *
 * Compatible avec Vite 5 et Sass modern-compiler API
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, join, relative, extname, basename } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

/**
 * Crée un custom importer pour Sass qui gère les globs
 * Doit être injecté dans les options Sass de Vite
 */
export function createSassGlobImporter() {
  return {
    canonicalize(url, context) {
      // Si pas de glob, laisser Sass gérer
      if (!url.includes('*')) {
        return null;
      }

      // Obtenir le dossier depuis lequel on importe
      const fromFile = context.containingUrl ? fileURLToPath(context.containingUrl) : process.cwd();
      const fromDir = dirname(fromFile);

      // Créer une URL canonique unique pour ce glob
      // On utilise le pattern comme identifiant
      const canonicalUrl = new URL(`sass-glob:${url}?from=${fromDir}`);
      return canonicalUrl;
    },

    load(canonicalUrl) {
      // Extraire le pattern et le dossier source
      const urlString = canonicalUrl.href;
      if (!urlString.startsWith('sass-glob:')) {
        return null;
      }

      const params = new URL(urlString);
      const pattern = urlString.split('?')[0].replace('sass-glob:', '');
      const fromDir = params.searchParams.get('from');

      // Expanser le glob
      const files = expandGlobPattern(pattern, fromDir);

      if (files.length === 0) {
        console.warn(`[sass-glob-import] Aucun fichier trouvé pour: ${pattern}`);
        return { contents: '', syntax: 'scss' };
      }

      // Générer le contenu avec tous les imports
      // Sass modern API nécessite des URLs file:// au lieu de chemins relatifs
      const imports = files
        .map(filePath => {
          // Convertir le chemin absolu en URL file://
          const fileUrl = pathToFileURL(filePath).href;
          return `@import "${fileUrl}";`;
        })
        .join('\n');

      return {
        contents: imports,
        syntax: 'scss'
      };
    }
  };
}

/**
 * Expanse un pattern glob en liste de fichiers SCSS
 *
 * @param {string} pattern - Pattern avec * ou ** (ex: "utilities/*.scss", "components/star-star/star.scss")
 * @param {string} baseDir - Dossier de base depuis lequel résoudre le pattern
 * @returns {string[]} - Liste des chemins absolus des fichiers trouvés
 */
function expandGlobPattern(pattern, baseDir) {
  // Nettoyer le pattern (enlever ./ au début si présent)
  let cleanPattern = pattern.replace(/^\.\//, '');

  // Séparer le pattern en segments (path + glob)
  const segments = cleanPattern.split('/');
  let currentPath = baseDir;
  let globStartIndex = -1;

  // Trouver où commence le glob (* ou **)
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].includes('*')) {
      globStartIndex = i;
      break;
    }
    // Construire le chemin jusqu'au premier glob
    currentPath = resolve(currentPath, segments[i]);
  }

  if (globStartIndex === -1) {
    // Pas de glob, retourner le fichier directement
    const fullPath = resolve(baseDir, cleanPattern);
    return [fullPath];
  }

  // Vérifier que le dossier existe
  if (!existsSync(currentPath)) {
    console.warn(`[sass-glob-import] Dossier inexistant: ${currentPath} (depuis ${baseDir})`);
    return [];
  }

  // Extraire le pattern de glob et l'extension
  const globSegments = segments.slice(globStartIndex);
  const isRecursive = globSegments.some(seg => seg === '**');
  const extension = pattern.match(/\.(scss|sass)$/)?.[0] || '.scss';

  // Scanner les fichiers
  const files = [];
  scanDirectory(currentPath, globSegments, 0, isRecursive, extension, files);

  // Trier par nom de fichier pour ordre prévisible
  return files.sort();
}

/**
 * Scanne récursivement un dossier pour trouver les fichiers SCSS
 *
 * @param {string} dir - Dossier à scanner
 * @param {string[]} patterns - Segments de pattern restants
 * @param {number} depth - Profondeur actuelle dans les patterns
 * @param {boolean} recursive - Si ** est présent (recherche récursive)
 * @param {string} extension - Extension à matcher (.scss ou .sass)
 * @param {string[]} results - Tableau accumulateur des résultats
 */
function scanDirectory(dir, patterns, depth, recursive, extension, results) {
  try {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat;

      try {
        stat = statSync(fullPath);
      } catch (err) {
        continue; // Ignorer les fichiers inaccessibles
      }

      if (stat.isDirectory()) {
        // Si on a **, scanner récursivement tous les sous-dossiers
        if (recursive) {
          scanDirectory(fullPath, patterns, depth, recursive, extension, results);
        }
        // Si le pattern courant est un nom de dossier, descendre dedans
        else if (depth < patterns.length - 1 && patterns[depth] === entry) {
          scanDirectory(fullPath, patterns, depth + 1, recursive, extension, results);
        }
      } else if (stat.isFile()) {
        const currentPattern = patterns[depth];

        // Matcher le nom de fichier avec le pattern
        if (matchPattern(entry, currentPattern, extension)) {
          // Les globs incluent TOUS les fichiers (même les partials _)
          // C'est le comportement attendu quand on fait vendors/*.scss
          results.push(fullPath);
        }
      }
    }
  } catch (err) {
    // Dossier inexistant ou inaccessible
    console.warn(`[sass-glob-import] Impossible de scanner: ${dir}`);
  }
}

/**
 * Vérifie si un nom de fichier correspond au pattern
 *
 * @param {string} filename - Nom du fichier
 * @param {string} pattern - Pattern (peut contenir *)
 * @param {string} extension - Extension attendue
 * @returns {boolean}
 */
function matchPattern(filename, pattern, extension) {
  // Si le pattern contient *, le convertir en regex
  if (pattern.includes('*')) {
    // Échapper les caractères spéciaux sauf *
    const regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(filename);
  }

  // Sinon, match exact
  return filename === pattern || filename === pattern + extension;
}
