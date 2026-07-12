/**
 * Plugin Vite : intercepteur HMR des modules JS du thème (API documentée)
 *
 * Remplace l'ancienne approche « transform + import.meta.hot.accept() injecté
 * dans chaque module + mutation du payload côté client dans vite:beforeUpdate »
 * (pattern non documenté) par le mécanisme officiel Vite :
 * handleHotUpdate invalide les modules (isHmr=true, les chaînes d'imports
 * recevront ?t= et serviront le code frais), envoie un événement custom
 * 'wp:theme-js-update' aux clients, et retourne [] pour suspendre la
 * propagation HMR par défaut.
 *
 * Consommateurs de l'événement :
 * - scripts/hmr-body-reset.js (front) : reset du fragment + réinjection
 * - scripts/hmr-editor-guard.js (admin + canvas Gutenberg) : avertissement
 *
 * Les CSS/SCSS ne sont PAS interceptés : HMR CSS natif Vite intact.
 */

import { PATHS } from '../paths.config.js';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import dotenv from 'dotenv';

/**
 * Recharge HMR_BODY_RESET depuis .env (pris en compte sans redémarrer Vite)
 */
function isHMRBodyResetEnabled() {
  const envPath = resolve(PATHS.bundlerRoot, '.env');
  if (!existsSync(envPath)) {
    return true; // Valeur par défaut
  }

  const envConfig = dotenv.parse(readFileSync(envPath, 'utf8'));
  return envConfig.HMR_BODY_RESET !== 'false';
}

// Racine du bundler normalisée : ses propres scripts (hmr-body-reset,
// hmr-editor-guard) ne sont JAMAIS des « JS du thème », même si le bundler
// est installé DANS le dossier du thème (installation portable)
const BUNDLER_ROOT = String(PATHS.bundlerRoot).replace(/\\/g, '/');

/**
 * Un fichier est un module JS SOURCE du thème (pas une lib minifiée,
 * pas un script du bundler)
 */
function isThemeJs(filePath) {
  const f = String(filePath).replace(/\\/g, '/');
  if (f.includes(BUNDLER_ROOT)) return false;
  return f.includes('/themes/') && f.endsWith('.js') && !f.endsWith('.min.js');
}

export function acceptAllHMRPlugin() {
  return {
    name: 'accept-all-hmr',

    handleHotUpdate({ server, modules, timestamp, file }) {
      // HMR_BODY_RESET=false → comportement Vite natif (full reload sur JS)
      if (!isHMRBodyResetEnabled()) return;
      // CSS/SCSS, libs minifiées, fichiers hors thème → HMR natif
      if (!isThemeJs(file)) return;
      // Fichier hors module graph (JS du thème jamais importé par la page) :
      // ne pas déclencher un reset pour un fichier qu'elle ne charge pas
      if (!modules || modules.length === 0) return;

      // Invalider les modules avec isHmr=true (pattern documenté par Vite) :
      // les imports réécrits des entrées recevront ?t= → code frais garanti
      const invalidatedModules = new Set();
      for (const mod of modules) {
        server.moduleGraph.invalidateModule(mod, invalidatedModules, timestamp, true);
      }

      // Liste des modules JS du thème connus du graphe (URLs racine-Vite) :
      // les clients les ré-importent au reset pour rejouer leurs effets
      // top-level (remplace l'ancien registre client auto-inscrit)
      const moduleUrls = new Set();
      for (const [url, mod] of server.moduleGraph.urlToModuleMap) {
        if (mod.file && isThemeJs(mod.file) && !url.includes('/_libs/')) {
          moduleUrls.add(url.split('?')[0]);
        }
      }

      server.ws.send({
        type: 'custom',
        event: 'wp:theme-js-update',
        data: {
          file: String(file).replace(/\\/g, '/'),
          paths: modules.map(m => (m.url ? m.url.split('?')[0] : '')).filter(Boolean),
          moduleUrls: [...moduleUrls],
          timestamp,
        },
      });

      // Suspendre la propagation HMR par défaut pour ces modules
      return [];
    },
  };
}
