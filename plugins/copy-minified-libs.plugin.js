import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { resolve, basename, join, dirname, sep } from 'path';
import { PATHS } from '../paths.config.js';

/**
 * Plugin Rollup pour copier les fichiers .min.js dans le dossier de build
 * Scanne récursivement le dossier JS source pour trouver tous les .min.js.
 * Les fichiers directement dans un dossier _libs/ sont copiés à plat dans js/ ;
 * les SOUS-DOSSIERS de _libs/ sont préservés (ex. _libs/swiper/nav.min.js → js/swiper/nav.min.js),
 * car les imports dynamiques runtime (lib-loader.js) référencent ces chemins relatifs.
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

      // Chemin de destination relatif : portion après le dernier segment `_libs` du chemin
      // source (préserve les sous-dossiers de _libs/), sinon nom de fichier seul.
      const destRelOf = (filePath) => {
        const parts = filePath.split(sep);
        const libsIdx = parts.lastIndexOf('_libs');
        return libsIdx !== -1 ? parts.slice(libsIdx + 1).join(sep) : basename(filePath);
      };

      // Dédupliquer par chemin relatif de destination (garder le premier trouvé)
      const uniqueFiles = new Map();
      for (const filePath of minifiedFiles) {
        const destRel = destRelOf(filePath);
        if (!uniqueFiles.has(destRel)) {
          uniqueFiles.set(destRel, filePath);
        }
      }

      // Copier chaque fichier unique (en créant les sous-dossiers préservés)
      for (const [destRel, sourcePath] of uniqueFiles) {
        const destPath = resolve(jsOutputPath, destRel);

        try {
          mkdirSync(dirname(destPath), { recursive: true });
          copyFileSync(sourcePath, destPath);
        } catch (err) {
          console.warn(`Erreur copie ${destRel}:`, err.message);
        }
      }
    }
  };
}
