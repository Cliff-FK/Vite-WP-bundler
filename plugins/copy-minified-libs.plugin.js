import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { resolve, basename, join } from 'path';
import { PATHS } from '../paths.config.js';

/**
 * Plugin Rollup pour copier les fichiers .min.js dans le dossier de build
 * Scanne récursivement le dossier JS source pour trouver tous les .min.js
 */
export function copyMinifiedLibsPlugin() {
  return {
    name: 'copy-minified-libs',

    // Hook: après que tous les fichiers soient écrits sur le disque
    closeBundle() {
      // Lire le buildFolder depuis le cache assets
      const cacheFile = resolve(PATHS.bundlerRoot, '.cache/assets-cache.json');
      let buildFolder = PATHS.assetFolders.dist; // Fallback: détection dynamique depuis paths.config.js

      try {
        const cache = JSON.parse(readFileSync(cacheFile, 'utf-8'));
        if (cache.assets?.buildFolder) {
          buildFolder = cache.assets.buildFolder.replace(/^\//, ''); // Retirer le / initial
        }
      } catch (err) {
        console.warn('  ⚠ Impossible de lire le cache, utilisation du fallback:', buildFolder);
      }

      const jsSourcePath = resolve(PATHS.themePath, PATHS.assetFolders.js);
      const buildPath = resolve(PATHS.themePath, buildFolder);
      const jsOutputPath = resolve(buildPath, 'js');

      // Créer le dossier de sortie si nécessaire
      if (!existsSync(jsOutputPath)) {
        mkdirSync(jsOutputPath, { recursive: true });
      }

      // Fonction récursive pour trouver tous les .min.js
      function findMinifiedFiles(dir) {
        const files = [];

        try {
          const items = readdirSync(dir);

          for (const item of items) {
            const fullPath = join(dir, item);
            const stat = statSync(fullPath);

            if (stat.isDirectory()) {
              // Récursif dans les sous-dossiers
              files.push(...findMinifiedFiles(fullPath));
            } else if (item.endsWith('.min.js')) {
              files.push(fullPath);
            }
          }
        } catch (err) {
          // Ignorer les erreurs de lecture
        }

        return files;
      }

      // Trouver tous les .min.js dans le dossier source
      const minifiedFiles = findMinifiedFiles(jsSourcePath);

      if (minifiedFiles.length === 0) {
        return;
      }

      // Dédupliquer par nom de fichier (garder le premier trouvé)
      const uniqueFiles = new Map();
      for (const filePath of minifiedFiles) {
        const fileName = basename(filePath);
        if (!uniqueFiles.has(fileName)) {
          uniqueFiles.set(fileName, filePath);
        }
      }

      // Copier chaque fichier unique
      for (const [fileName, sourcePath] of uniqueFiles) {
        const destPath = resolve(jsOutputPath, fileName);

        try {
          copyFileSync(sourcePath, destPath);
        } catch (err) {
          console.warn(`Erreur copie ${fileName}:`, err.message);
        }
      }
    }
  };
}
