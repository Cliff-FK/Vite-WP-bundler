/**
 * Plugin Vite pour gérer les assets statiques
 * - Dev : Crée des symlinks vers sources/ (pas de copie)
 * - Build : Scanne les fichiers compilés et copie uniquement les assets utilisés
 */

import { copyFileSync, mkdirSync, existsSync, readdirSync, readFileSync, symlinkSync, rmSync } from 'fs';
import { resolve, dirname, join, normalize, sep } from 'path';
import { PATHS } from '../paths.config.js';

/**
 * Extrait les chemins d'assets depuis le CSS compilé
 */
function extractAssetsFromCSS(cssContent) {
  const assets = new Set();
  // Matcher url(../path) avec ou sans guillemets
  const urlPattern = /url\s*\(\s*["']?\.\.\/([^"')]+?)["']?\s*\)/g;

  let match;
  while ((match = urlPattern.exec(cssContent)) !== null) {
    assets.add(match[1]);
  }

  return Array.from(assets);
}

/**
 * Extrait les chemins d'assets depuis le JS compilé
 */
function extractAssetsFromJS(jsContent) {
  const assets = new Set();

  // Pattern 1: fetch() avec template strings et variables (fetch(`${var}/inc/xxx.json`))
  const fetchTemplatePattern = /fetch\(`[^`]*\$\{[^}]+\}\/([^`]+\.(json|xml|txt))`\)/g;
  let match;
  while ((match = fetchTemplatePattern.exec(jsContent)) !== null) {
    const path = match[1];
    if (path.startsWith('inc/') || path.startsWith('includes/')) {
      assets.add(path);
    }
  }

  // Pattern 2: fetch() avec strings littérales
  const fetchLiteralPattern = /fetch\([`'"]([^`'"]+\.(json|xml|txt))[`'"]\)/g;
  while ((match = fetchLiteralPattern.exec(jsContent)) !== null) {
    const path = match[1];
    if (path.includes('/inc/') || path.includes('/includes/')) {
      const segments = path.split('/');
      const incIndex = segments.findIndex(s => s === 'inc' || s === 'includes');
      if (incIndex >= 0) {
        const relativePath = segments.slice(incIndex).join('/');
        assets.add(relativePath);
      }
    }
  }

  return Array.from(assets);
}

/**
 * Copie un fichier unique avec création des dossiers parents
 */
function copyFile(src, dest) {
  const destDir = dirname(dest);
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }
  if (existsSync(src)) {
    copyFileSync(src, dest);
  }
}

export function copyStaticAssetsPlugin(mode = 'build') {
  const isDev = mode === 'serve' || mode === 'development';

  const scanAndCopyUsedAssets = (buildPath) => {
    try {
      const usedAssets = new Set();

      // 1. Scanner tous les fichiers CSS compilés dans dist/css/
      const cssFolder = resolve(buildPath, 'css');
      if (existsSync(cssFolder)) {
        const cssFiles = readdirSync(cssFolder).filter(f => f.endsWith('.css'));
        cssFiles.forEach(file => {
          const content = readFileSync(resolve(cssFolder, file), 'utf-8');
          const assets = extractAssetsFromCSS(content);
          assets.forEach(asset => usedAssets.add(asset));
        });
      }

      // 2. Scanner tous les fichiers JS compilés dans dist/js/
      const jsFolder = resolve(buildPath, 'js');
      if (existsSync(jsFolder)) {
        const jsFiles = readdirSync(jsFolder).filter(f => f.endsWith('.js'));
        jsFiles.forEach(file => {
          const content = readFileSync(resolve(jsFolder, file), 'utf-8');
          const assets = extractAssetsFromJS(content);
          assets.forEach(asset => usedAssets.add(asset));
        });
      }

      // 3. Copier uniquement les assets utilisés
      usedAssets.forEach(assetPath => {
        // Résoudre le chemin source basé sur le type d'asset
        let sourcePath;

        // Extraire le premier segment du chemin (images, fonts, inc, etc.)
        const firstSegment = assetPath.split('/')[0];

        // Mapper vers le dossier source correspondant
        if (PATHS.assetFolders.images && PATHS.assetFolders.images.endsWith(firstSegment)) {
          sourcePath = resolve(PATHS.themePath, PATHS.assetFolders.images, assetPath.substring(firstSegment.length + 1));
        } else if (PATHS.assetFolders.fonts && PATHS.assetFolders.fonts.endsWith(firstSegment)) {
          sourcePath = resolve(PATHS.themePath, PATHS.assetFolders.fonts, assetPath.substring(firstSegment.length + 1));
        } else if (PATHS.assetFolders.includesDest && firstSegment === PATHS.assetFolders.includesDest) {
          sourcePath = resolve(PATHS.themePath, PATHS.assetFolders.includes, assetPath.substring(PATHS.assetFolders.includesDest.length + 1));
        } else {
          sourcePath = resolve(PATHS.themePath, assetPath);
        }

        // Résoudre le chemin de destination
        const destPath = resolve(buildPath, assetPath);

        // Copier le fichier
        copyFile(sourcePath, destPath);
      });

    } catch (err) {
      console.error('❌ Erreur lors de la copie des assets:', err.message);
    }
  };

  return {
    name: 'copy-static-assets',

    // En mode dev : créer des symlinks vers les sources (pas de copie)
    configResolved() {
      if (isDev) {
        const themePath = PATHS.themePath;

        // Symlink images: sources/images → ./images
        if (PATHS.assetFolders.images && existsSync(resolve(themePath, PATHS.assetFolders.images))) {
          const srcImages = resolve(themePath, PATHS.assetFolders.images);
          const destImages = resolve(themePath, 'images');
          createSymlink(srcImages, destImages);
        }

        // Symlink fonts: sources/fonts → ./fonts
        if (PATHS.assetFolders.fonts && existsSync(resolve(themePath, PATHS.assetFolders.fonts))) {
          const srcFonts = resolve(themePath, PATHS.assetFolders.fonts);
          const destFonts = resolve(themePath, 'fonts');
          createSymlink(srcFonts, destFonts);
        }

        // Symlink includes: includes → ./inc
        if (PATHS.assetFolders.includes && PATHS.assetFolders.includesDest) {
          const srcIncludes = resolve(themePath, PATHS.assetFolders.includes);
          const destInc = resolve(themePath, PATHS.assetFolders.includesDest);
          if (existsSync(srcIncludes)) {
            createSymlink(srcIncludes, destInc);
          }
        }
      }
    },

    // En mode build : scanner et copier après compilation
    closeBundle() {
      if (!isDev) {
        const buildPath = resolve(PATHS.themePath, PATHS.assetFolders.dist);
        scanAndCopyUsedAssets(buildPath);
      }
    }
  };
}

/**
 * Crée un lien symbolique (pour mode dev uniquement)
 * Si la destination existe déjà (dossier ou symlink), on la supprime d'abord
 */
function createSymlink(src, dest) {
  try {
    // Si destination existe, la supprimer
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true, force: true });
    }

    // Créer le symlink (type 'junction' pour Windows, 'dir' pour Unix)
    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(src, dest, symlinkType);
  } catch (err) {
    console.error(`❌ Erreur création symlink ${dest}:`, err.message);
  }
}
