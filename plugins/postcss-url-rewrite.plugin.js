import { PATHS, BUILD_FOLDER } from '../paths.config.js';
import { relative, dirname, join } from 'path';

/**
 * Plugin PostCSS pour réécrire les URLs dans le CSS compilé
 * S'exécute APRÈS la compilation SCSS, quand les url() sont déjà résolues
 *
 * MODE DEV et BUILD : Utilise des URLs absolues WordPress pour garantir
 * la compatibilité frontend, backend, et iframes
 */
export function postcssUrlRewrite(mode = 'development', buildConfig = {}) {
  const isDev = mode === 'development' || mode === 'serve';

  return {
    postcssPlugin: 'postcss-url-rewrite',

    // Hook qui traite chaque déclaration CSS
    Declaration(decl, { result }) {
      // Traiter uniquement les déclarations qui contiennent url()
      if (!decl.value || !decl.value.includes('url(')) {
        return;
      }

      // Utiliser toujours l'URL WordPress absolue (dev ET build)
      // Cela garantit que les assets fonctionnent partout : frontend, backend, iframes
      const themeAssetsBase = `${PATHS.wpUrl}/${PATHS.themePathRelative}`;

      // Marquer les URLs déjà transformées pour éviter les doublons
      const processed = new Set();

      // 1. Réécrire les URLs relatives avec remontées de dossiers (../)
      decl.value = decl.value.replace(
        /url\((['"]?)((?:\.\.\/)+)([^'")\s]+)(['"]?)\)/g,
        (fullMatch, _quote1, _dots, path) => {
          if (processed.has(fullMatch)) return fullMatch;
          processed.add(fullMatch);
          // Dev et Build : toujours utiliser l'URL WordPress absolue
          return `url("${themeAssetsBase}/${path}")`;
        }
      );

      // 2. Réécrire les URLs relatives simples (sans ../, http, data:)
      decl.value = decl.value.replace(
        /url\((['"]?)(?!http|\/\/|data:|\.\.\/|["'])([^'")\s]+)(['"]?)\)/g,
        (fullMatch, _quote1, path) => {
          // Ignorer si déjà transformé ou si URL externe
          if (processed.has(fullMatch) || path.startsWith('http') || path.startsWith('data:')) {
            return fullMatch;
          }
          processed.add(fullMatch);
          // Dev et Build : toujours utiliser l'URL WordPress absolue
          return `url("${themeAssetsBase}/${path}")`;
        }
      );

      // 3. Réécrire les URLs absolues (commençant par /)
      decl.value = decl.value.replace(
        /url\((['"]?)\/([^'")\s:]+)(['"]?)\)/g,
        (fullMatch, _quote1, path) => {
          if (processed.has(fullMatch)) return fullMatch;
          processed.add(fullMatch);

          // Si le chemin pointe déjà vers le thème, construire l'URL complète
          if (path.startsWith(PATHS.themePathRelative)) {
            return `url("${PATHS.wpUrl}/${path}")`;
          }
          // Sinon, utiliser la base du thème
          return `url("${themeAssetsBase}/${path}")`;
        }
      );
    },
  };
}

// Important pour PostCSS
postcssUrlRewrite.postcss = true;
