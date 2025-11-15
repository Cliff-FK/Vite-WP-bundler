/**
 * Plugin Vite pour nettoyer le MU-plugin à la fermeture
 */

import { existsSync, unlinkSync, rmdirSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { PATHS } from '../paths.config.js';

// Flag global pour éviter d'enregistrer les listeners plusieurs fois
let signalsRegistered = false;

export function cleanupMuPluginOnClose() {
  const muPluginsPath = resolve(PATHS.wpRoot, 'wp-content/mu-plugins');
  const muPluginFile = resolve(muPluginsPath, 'vite-dev-mode.php');

  /**
   * Nettoie le MU-plugin
   */
  const cleanupMuPlugin = () => {
    try {
      if (existsSync(muPluginFile)) {
        unlinkSync(muPluginFile);
      }
      if (existsSync(muPluginsPath)) {
        const files = readdirSync(muPluginsPath);
        if (files.length === 0) {
          rmdirSync(muPluginsPath);
        }
      }
    } catch (err) {
      // Silencieux
    }
  };

  return {
    name: 'cleanup-mu-plugin',
    configResolved() {
      // Enregistrer les handlers de signaux une seule fois globalement
      if (!signalsRegistered) {
        signalsRegistered = true;

        // Augmenter la limite de listeners pour éviter les warnings
        process.setMaxListeners(20);

        // Ctrl+C - Nettoyer uniquement le MU-plugin
        process.on('SIGINT', () => {
          cleanupMuPlugin();
          process.exit(0);
        });

        // Kill - Nettoyer uniquement le MU-plugin
        process.on('SIGTERM', () => {
          cleanupMuPlugin();
          process.exit(0);
        });

        // Fermeture normale - Nettoyer uniquement le MU-plugin
        process.on('exit', () => {
          cleanupMuPlugin();
        });
      }
    }
  };
}
