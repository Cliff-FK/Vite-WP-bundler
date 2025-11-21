/**
 * Plugin Vite pour servir les assets statiques depuis plusieurs dossiers en mode dev
 * Permet de servir fonts/, images/, inc/ etc. qui sont hors des dossiers sources
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { resolve, extname } from 'path';
import { PATHS } from '../paths.config.js';

/**
 * Extensions d'assets statiques à servir
 */
const STATIC_EXTENSIONS = new Set([
  // Images
  '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.avif', '.ico', '.bmp',
  // Fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  // Data
  '.json', '.xml', '.txt', '.csv',
  // Autres
  '.pdf', '.zip',
]);

/**
 * Types MIME pour les assets
 */
const MIME_TYPES = {
  // Images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',

  // Fonts
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',

  // Data
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.csv': 'text/csv',

  // Autres
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

/**
 * Liste des dossiers d'assets à servir (à la racine du thème)
 */
function getStaticAssetFolders() {
  const folders = [];

  // Ajouter fonts/ si détecté
  if (PATHS.assetFolders.fonts) {
    folders.push(PATHS.assetFolders.fonts);
  }

  // Ajouter images/ si détecté
  if (PATHS.assetFolders.images) {
    folders.push(PATHS.assetFolders.images);
  }

  // Ajouter inc/includes/ si détecté
  if (PATHS.assetFolders.includes) {
    folders.push(PATHS.assetFolders.includes);
  }

  return folders;
}

/**
 * Plugin Vite pour servir les assets statiques
 */
export function serveStaticAssetsPlugin() {
  const staticFolders = getStaticAssetFolders();

  return {
    name: 'serve-static-assets',

    configureServer(server) {
      // Ajouter un middleware pour servir les assets statiques
      server.middlewares.use((req, res, next) => {
        // Extraire le chemin de l'URL (sans query string)
        const url = req.url.split('?')[0];
        const ext = extname(url);

        // Gérer les requêtes OPTIONS (preflight CORS)
        if (req.method === 'OPTIONS' && STATIC_EXTENSIONS.has(ext)) {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          res.statusCode = 204;
          res.end();
          return;
        }

        // Vérifier si c'est une extension d'asset statique
        if (!STATIC_EXTENSIONS.has(ext)) {
          return next();
        }

        // Enlever le slash initial
        const requestPath = url.startsWith('/') ? url.slice(1) : url;

        // Essayer de trouver le fichier dans les dossiers d'assets
        for (const folder of staticFolders) {
          // Vérifier si le chemin de la requête commence par ce dossier
          if (requestPath.startsWith(folder + '/')) {
            const filePath = resolve(PATHS.themePath, requestPath);

            // Vérifier si le fichier existe
            if (existsSync(filePath) && statSync(filePath).isFile()) {
              try {
                // Lire et servir le fichier
                const content = readFileSync(filePath);
                const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

                // Headers CORS pour permettre les requêtes cross-origin
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

                res.setHeader('Content-Type', mimeType);
                res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                res.end(content);
                return;
              } catch (err) {
                console.error(`❌ Erreur lecture asset ${filePath}:`, err.message);
                res.statusCode = 500;
                res.end('Internal Server Error');
                return;
              }
            }
          }
        }

        // Fichier non trouvé, passer au middleware suivant
        next();
      });
    },
  };
}
