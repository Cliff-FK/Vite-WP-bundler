/**
 * Plugin Vite maison : expansion des globs dans les @import/@use SCSS
 *
 * Remplace vite-plugin-sass-glob-import (plafonné à peer vite ^6||^7, ce qui
 * bloquait Vite 8). Sémantique répliquée à l'identique depuis sa v6.0.3 pour
 * garantir une sortie CSS byte-identique :
 *   - même regex d'@import/@use avec commentaires de début/fin préservés
 *   - même expansion globSync (windowsPathsNoEscape) et même tri localeCompare 'en'
 *   - même format de réécriture (`@import "fichier";`, sans ; pour .sass)
 * Différences assumées :
 *   - pas de warning « Directories don't exist » (check naïf bugué de l'original
 *     sur les patterns extglob type `bloc-parts/!(_libs)/**` — le monkey-patch
 *     de console.warn dans vite.config.js devient inutile)
 *   - pas d'option ignorePaths (jamais utilisée ici)
 */

import path from 'path';
import fs from 'fs';
import { globSync } from 'glob';

const FILE_REGEX = /\.s[c|a]ss(\?direct)?$/;
const IMPORT_REGEX = /^([ \t]*(?:\/\*.*)?)@(import|use)\s+["']([^"']+\*[^"']*(?:\.scss|\.sass)?)["'];?([ \t]*(?:\/[/*].*)?)$/gm;

function isSassOrScss(filename) {
  try {
    return !fs.statSync(filename).isDirectory() && path.extname(filename).match(/\.sass|\.scss/i);
  } catch (err) {
    // Fichier disparu entre le glob et le stat, ou symlink cassé : l'ignorer
    return false;
  }
}

function expandGlobs(src, filePath, fileName) {
  const isSass = path.extname(fileName).match(/\.sass/i);
  const contentLinesCount = src.split('\n').length;

  for (let i = 0; i < contentLinesCount; i++) {
    const result = [...src.matchAll(IMPORT_REGEX)];
    if (!result.length) break;

    const [importRule, startComment, importType, globPattern, endComment] = result[0];

    const files = globSync(path.join(filePath, globPattern), {
      cwd: './',
      windowsPathsNoEscape: true,
    }).sort((a, b) => a.localeCompare(b, 'en'));

    const imports = [];
    files.forEach((filename) => {
      if (isSassOrScss(filename)) {
        const rel = path.relative(filePath, filename).replace(/\\/g, '/').replace(/^\//, '');
        imports.push(`@${importType} "` + rel + '"' + (isSass ? '' : ';'));
      }
    });

    if (startComment) imports.unshift(startComment);
    if (endComment) imports.push(endComment);

    src = src.replace(importRule, imports.join('\n'));
  }

  return src;
}

export function sassGlobImports() {
  return {
    name: 'sass-glob-import',
    enforce: 'pre',

    transform(src, id) {
      const result = { code: src, map: null };
      if (FILE_REGEX.test(id)) {
        result.code = expandGlobs(src, path.dirname(id), path.basename(id));
      }
      return result;
    },
  };
}
