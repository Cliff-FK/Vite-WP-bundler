import { PATHS, BUILD_FOLDER } from '../paths.config.js';
import { relative, dirname, join } from 'path';

/**
 * Plugin PostCSS pour réécrire les URLs dans le CSS compilé
 * S'exécute APRÈS la compilation SCSS, quand les url() sont déjà résolues
 *
 * Utilise des chemins relatifs depuis le fichier CSS généré vers dist/
 * Compatible avec tout domaine (dev, staging, prod)
 */
export function postcssUrlRewrite(mode = 'development', buildConfig = {}) {
  const isDev = mode === 'development' || mode === 'serve';

  return {
    postcssPlugin: 'postcss-url-rewrite',

    // Hook qui traite chaque déclaration CSS
    Declaration(decl, { result }) {
      // En mode dev, transformer les chemins relatifs ../../ en chemins absolus /
      // pour que Vite les serve via publicDir
      if (isDev) {
        // Transformer url("../../images/...") → url("/images/...")
        // Vite servira /images/ depuis publicDir (sources/)
        decl.value = decl.value.replace(
          /url\((['"]?)\.\.\/\.\.\/([^'")\s]+)(['"]?)\)/g,
          'url($1/$2$3)'
        );
        return;
      }

      // Traiter uniquement les déclarations qui contiennent url()
      if (!decl.value || !decl.value.includes('url(')) {
        return;
      }

      // Marquer les URLs déjà transformées pour éviter les doublons
      const processed = new Set();

      // 1. Réécrire les URLs relatives avec remontées de dossiers (../../images/...)
      //    En prod : dist/css/style.css → ../../images/ devient ../images/
      //    Car les assets sont copiés dans dist/images/
      decl.value = decl.value.replace(
        /url\((['"]?)((?:\.\.\/)+)([^'")\s]+)(['"]?)\)/g,
        (fullMatch, _quote1, _dots, path) => {
          if (processed.has(fullMatch)) return fullMatch;
          processed.add(fullMatch);

          // Chemins relatifs depuis dist/css/ vers dist/images|fonts|inc
          // ../../images/svg/ico.svg → ../images/svg/ico.svg
          return `url("../${path}")`;
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
          // Chemins relatifs depuis dist/css/
          return `url("../${path}")`;
        }
      );

      // 3. Réécrire les URLs absolues (commençant par /)
      decl.value = decl.value.replace(
        /url\((['"]?)\/([^'")\s:]+)(['"]?)\)/g,
        (fullMatch, _quote1, path) => {
          if (processed.has(fullMatch)) return fullMatch;
          processed.add(fullMatch);

          // Chemins relatifs depuis dist/css/
          return `url("../${path}")`;
        }
      );
    },
  };
}

// Important pour PostCSS
postcssUrlRewrite.postcss = true;
