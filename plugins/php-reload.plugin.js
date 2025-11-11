import { PATHS } from '../paths.config.js';
import chokidar from 'chokidar';

/**
 * Plugin personnalisé pour reload des fichiers PHP avec debounce intelligent
 * Évite les reloads multiples en groupant les changements sur une période donnée
 */
export function phpReloadPlugin() {
  let reloadTimer = null;
  let pendingReloads = new Set();
  const DEBOUNCE_DELAY = 400; // 400ms de délai (réduit pour une meilleure réactivité)

  return {
    name: 'php-reload',

    configureServer(server) {
      // Créer le watcher pour tous les fichiers PHP du thème
      const watcher = chokidar.watch(
        `${PATHS.themePath}/**/*.php`,
        {
          ignoreInitial: true,
          ignored: [
            '**/*.js',   // Ignorer les fichiers JS (gérés par HMR Vite)
            '**/*.css',  // Ignorer les fichiers CSS (gérés par HMR Vite)
            '**/*.scss', // Ignorer les fichiers SCSS (gérés par HMR Vite)
          ],
          awaitWriteFinish: {
            stabilityThreshold: 200, // Attendre 200ms de stabilité
            pollInterval: 100,
          },
        }
      );

      // Fonction de reload avec debounce
      const scheduleReload = (filePath) => {
        // Ajouter le fichier à la liste des changements en attente
        pendingReloads.add(filePath);

        // Annuler le timer précédent
        if (reloadTimer) {
          clearTimeout(reloadTimer);
        }

        // Créer un nouveau timer
        reloadTimer = setTimeout(() => {
          // Logger dans le style Vite natif avec couleurs
          const now = new Date();
          const time = now.toLocaleTimeString('fr-FR', { hour12: false });
          const files = Array.from(pendingReloads);

          // Codes couleurs ANSI (style Vite)
          const dim = '\x1b[2m';          // Gris clair pour l'heure et le chemin
          const cyan = '\x1b[36m';        // Cyan pour [vite]
          const bold = '\x1b[1m';         // Gras
          const green = '\x1b[32m';       // Vert pour "page reload"
          const reset = '\x1b[0m';        // Reset

          // Log pour chaque fichier (style Vite)
          files.forEach(file => {
            // Extraire dynamiquement le nom du dossier racine
            const normalizedPath = file.replace(/\\/g, '/');
            const wpRootNormalized = PATHS.wpRoot.replace(/\\/g, '/');
            const rootFolderName = wpRootNormalized.split('/').pop();

            // Extraire le chemin depuis le dossier racine
            const rootIndex = normalizedPath.lastIndexOf(rootFolderName + '/');
            const relativePath = rootIndex !== -1
              ? normalizedPath.substring(rootIndex)
              : normalizedPath;

            console.log(`${dim}${time}${reset} ${bold}${cyan}[vite]${reset} ${green}page reload${reset} ${dim}${relativePath}${reset}`);
          });

          // Envoyer UN SEUL reload pour tous les fichiers changés
          server.ws.send({
            type: 'full-reload',
            path: '*',
          });

          // Réinitialiser
          pendingReloads.clear();
          reloadTimer = null;
        }, DEBOUNCE_DELAY);
      };

      // Écouter les changements
      watcher.on('change', (filePath) => {
        scheduleReload(filePath);
      });

      watcher.on('add', (filePath) => {
        scheduleReload(filePath);
      });

      watcher.on('unlink', (filePath) => {
        scheduleReload(filePath);
      });

      // Cleanup à la fermeture du serveur
      server.httpServer?.on('close', () => {
        if (reloadTimer) {
          clearTimeout(reloadTimer);
        }
        watcher.close();
      });
    },
  };
}
