/**
 * Plugin Vite pour nettoyer le MU-plugin à la fermeture
 * et incrémenter la version du thème dans style.css
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { PATHS, AUTO_INCREMENT_VERSION } from '../paths.config.js';
import { deleteMuPlugin } from './generate-mu-plugin.js';

// Flag global pour éviter d'enregistrer les listeners plusieurs fois
let signalsRegistered = false;
// Flag pour éviter l'incrémentation multiple de la version
let versionIncremented = false;

export function cleanupMuPluginOnClose() {
  /**
   * Incrémente la version du thème dans style.css
   */
  const incrementThemeVersion = () => {
    // Éviter l'incrémentation multiple
    if (versionIncremented) return;
    versionIncremented = true;

    try {
      const stylePath = resolve(PATHS.themePath, 'style.css');
      if (!existsSync(stylePath)) return;

      let content = readFileSync(stylePath, 'utf-8');
      const versionMatch = content.match(/Version:\s*(\d+)\.(\d+)/);
      if (!versionMatch) return;

      const major = parseInt(versionMatch[1]);
      const minor = parseInt(versionMatch[2]);
      const newMinor = minor + 1;
      const newVersion = `${major}.${newMinor}`;

      content = content.replace(/Version:\s*\d+\.\d+/, `Version: ${newVersion}`);
      writeFileSync(stylePath, content, 'utf-8');
      console.log(`\n📝 Version du thème incrémentée: ${major}.${minor} → ${newVersion}`);
    } catch (err) {
      return;
    }
  };

  /**
   * Actions à la fermeture de Vite
   */
  const cleanupOnClose = () => {
    try {
      // Incrémenter la version du thème (si activé)
      if (AUTO_INCREMENT_VERSION) {
        incrementThemeVersion();
      }

      // Supprimer le MU-plugin
      deleteMuPlugin();
    } catch (err) {
      // Silencieux - les erreurs sont déjà gérées dans deleteMuPlugin()
    }
  };

  return {
    name: 'cleanup-mu-plugin',

    // closeBundle s'exécute uniquement en mode build
    closeBundle() {
      cleanupOnClose();
    }
  };
}
