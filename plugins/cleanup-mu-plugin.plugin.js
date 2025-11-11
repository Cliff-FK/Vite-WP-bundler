/**
 * Plugin Vite pour nettoyer le MU-plugin à la fermeture
 */

import { existsSync, unlinkSync, rmdirSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { PATHS } from '../paths.config.js';

export function cleanupMuPluginOnClose() {
  const muPluginsPath = resolve(PATHS.wpRoot, 'wp-content/mu-plugins');
  const muPluginFile = resolve(muPluginsPath, 'vite-dev-mode.php');

  const cleanup = () => {
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

  // Écouter les signaux de fermeture du processus
  let signalsRegistered = false;

  return {
    name: 'cleanup-mu-plugin',
    configResolved() {
      // Enregistrer les handlers de signaux une seule fois
      if (!signalsRegistered) {
        signalsRegistered = true;

        // Ctrl+C
        process.on('SIGINT', () => {
          cleanup();
          process.exit(0);
        });

        // Kill
        process.on('SIGTERM', () => {
          cleanup();
          process.exit(0);
        });

        // Fermeture normale
        process.on('exit', () => {
          cleanup();
        });
      }
    }
  };
}
