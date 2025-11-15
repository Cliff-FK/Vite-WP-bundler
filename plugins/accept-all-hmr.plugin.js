/**
 * Plugin Vite pour accepter automatiquement le HMR sur TOUS les modules JS du thème
 *
 * Objectif: Empêcher Vite de faire un full-reload quand un module ne définit pas import.meta.hot.accept()
 * Solution: Injecter automatiquement import.meta.hot.accept() dans tous les fichiers JS du thème
 *
 * Ainsi, le script HMR du bundler peut intercepter les changements via vite:beforeUpdate
 * au lieu que Vite décide de faire un reload complet
 */

import { PATHS } from '../paths.config.js';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import dotenv from 'dotenv';

/**
 * Recharge HMR_BODY_RESET depuis .env
 */
function isHMRBodyResetEnabled() {
  const envPath = resolve(PATHS.bundlerRoot, '.env');
  if (!existsSync(envPath)) {
    return true; // Valeur par défaut
  }

  const envConfig = dotenv.parse(readFileSync(envPath, 'utf8'));
  return envConfig.HMR_BODY_RESET !== 'false';
}

export function acceptAllHMRPlugin() {
  return {
    name: 'accept-all-hmr',
    enforce: 'post', // Appliquer après les autres transformations

    transform(code, id) {
      // Vérifier si HMR_BODY_RESET est activé dans .env
      // Si désactivé, on ne transforme rien et Vite fera un full reload natif
      if (!isHMRBodyResetEnabled()) {
        return null;
      }

      // Accepter le HMR uniquement pour les fichiers JS du thème (non minifiés)
      // Critères:
      // - Dans /themes/ (donc pas node_modules, ni bundler s'il est hors themes)
      // - Fichier .js mais pas .min.js (donc pas de libs minifiées)
      // - Pas dans le dossier du bundler (pour les scripts HMR du bundler)
      const isThemeJS =
        id.includes('/themes/') &&
        !id.includes(PATHS.bundlerRoot) &&
        !id.endsWith('.min.js') &&
        id.endsWith('.js');

      if (!isThemeJS) {
        return null; // Ne pas transformer
      }

      // Si le fichier contient déjà import.meta.hot, ne rien faire
      if (code.includes('import.meta.hot')) {
        return null;
      }

      // Injecter import.meta.hot.accept() à la fin du fichier
      const injectedCode = `${code}

// Auto-injected by accept-all-hmr plugin
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    // HMR accepté - la logique de reset est gérée par hmr-body-reset.js
  });
}
`;

      return {
        code: injectedCode,
        map: null, // Pas de sourcemap pour cette injection
      };
    },
  };
}
