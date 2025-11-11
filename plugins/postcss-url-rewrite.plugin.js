import { PATHS } from '../paths.config.js';

/**
 * Plugin PostCSS pour réécrire les URLs dans le CSS compilé
 * S'exécute APRÈS la compilation SCSS, quand les url() sont déjà résolues
 */
export function postcssUrlRewrite() {
  const viteBaseUrl = `http://${PATHS.viteHost}:${PATHS.vitePort}`;
  const themeAssetsBase = `${viteBaseUrl}/${PATHS.themePathRelative}`;

  return {
    postcssPlugin: 'postcss-url-rewrite',

    // Hook qui traite chaque déclaration CSS
    Declaration(decl) {
      // Traiter uniquement les déclarations qui contiennent url()
      if (!decl.value || !decl.value.includes('url(')) {
        return;
      }

      // 1. Réécrire TOUTES les URLs relatives avec ../
      decl.value = decl.value.replace(
        /url\((['"]?)((?:\.\.\/)+)([^'")\s]+)(['"]?)\)/g,
        (match, quote1, dots, path, quote2) => {
          return `url("${themeAssetsBase}/${path}")`;
        }
      );

      // 2. Réécrire TOUTES les URLs relatives sans ../
      decl.value = decl.value.replace(
        /url\((['"]?)(?!http|\/\/|data:|["'])([^'")\s]+)(['"]?)\)/g,
        (match, quote1, path, quote2) => {
          // Ignorer si déjà transformé
          if (path.startsWith('http') || path.startsWith('data:')) {
            return match;
          }
          return `url("${themeAssetsBase}/${path}")`;
        }
      );

      // 3. Réécrire les URLs absolues commençant par /
      decl.value = decl.value.replace(
        /url\((['"]?)\/([^'")\s:]+)(['"]?)\)/g,
        (match, quote1, path, quote2) => {
          // Si le path contient déjà le chemin du thème
          if (path.startsWith(PATHS.themePathRelative)) {
            return `url("${viteBaseUrl}/${path}")`;
          }
          // Sinon, ajouter le chemin du thème
          return `url("${themeAssetsBase}/${path}")`;
        }
      );
    },
  };
}

// Important pour PostCSS
postcssUrlRewrite.postcss = true;
