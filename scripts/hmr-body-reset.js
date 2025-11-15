/**
 * Vite HMR Body Reset Helper
 *
 * Script injecté automatiquement en mode dev pour gérer un HMR simplifié :
 * - Cache le HTML du body au chargement
 * - Détecte les changements HMR sur les modules JS
 * - Reset le body et réinjecte les scripts Vite
 *
 * Avantages :
 * - Pas de modification du code du thème
 * - Nettoyage automatique des event listeners DOM
 * - Simple et efficace
 */

(function() {
  'use strict';

  // Mode debug (mettre à false pour désactiver les logs détaillés)
  const DEBUG = false;

  // Cache du HTML original du body
  let originalBodyHTML = null;

  // Liste des scripts JS Vite sources à réinjecter (seulement .js, pas .scss/.css)
  let viteSourceScripts = [];

  // Position du scroll sauvegardée
  let savedScrollPosition = { x: 0, y: 0 };

  // Tracker des event listeners window/document pour nettoyage
  let trackedListeners = [];

  // Wrapper addEventListener pour tracker automatiquement
  const originalWindowAddEventListener = window.addEventListener;
  const originalDocumentAddEventListener = document.addEventListener;

  window.addEventListener = function(type, listener, options) {
    trackedListeners.push({ target: window, type, listener, options });
    return originalWindowAddEventListener.call(this, type, listener, options);
  };

  document.addEventListener = function(type, listener, options) {
    trackedListeners.push({ target: document, type, listener, options });
    return originalDocumentAddEventListener.call(this, type, listener, options);
  };

  /**
   * Nettoie tous les event listeners window/document trackés
   */
  function cleanTrackedListeners() {
    if (DEBUG) console.log('[Vite HMR] Nettoyage de', trackedListeners.length, 'listeners window/document');
    trackedListeners.forEach(({ target, type, listener, options }) => {
      try {
        target.removeEventListener(type, listener, options);
      } catch (e) {
        // Ignorer les erreurs de nettoyage
      }
    });
    trackedListeners = [];
  }

  /**
   * Sauvegarde le HTML du body et détecte les scripts JS Vite
   */
  function captureInitialState() {
    // Sauvegarder le HTML du body
    if (!originalBodyHTML && document.body) {
      originalBodyHTML = document.body.innerHTML;
      console.log('[Vite HMR] Body HTML sauvegardé');
    }

    // Détecter uniquement les scripts JS externes (type="module" avec src="/@fs/" et .js)
    const externalScripts = document.querySelectorAll('script[type="module"][src*="/@fs/"]');
    viteSourceScripts = Array.from(externalScripts)
      .filter(script => script.src.endsWith('.js'))
      .map(script => ({
        src: script.src,
        path: script.src.split('/@fs/').pop()
      }));

    if (viteSourceScripts.length > 0) {
      console.log('[Vite HMR] Scripts JS Vite détectés:', viteSourceScripts.length);
      viteSourceScripts.forEach(s => console.log('  -', s.path));
    }
  }

  /**
   * Réinitialise le body et réinjecte les scripts Vite
   */
  function resetBodyAndReinjectScripts() {
    if (!originalBodyHTML) {
      console.warn('[Vite HMR] Pas de HTML sauvegardé, impossible de réinitialiser');
      return;
    }

    console.log('[Vite HMR] Réinitialisation du body...');

    try {
      // 1. Sauvegarder la position du scroll
      savedScrollPosition = {
        x: window.scrollX || window.pageXOffset,
        y: window.scrollY || window.pageYOffset
      };
      if (DEBUG) console.log('[Vite HMR] Position du scroll sauvegardée:', savedScrollPosition);

      // 2. Nettoyer les event listeners window/document trackés
      cleanTrackedListeners();

      // 3. Supprimer les anciens scripts du thème du <head> (mais garder Vite client et hmr-body-reset.js)
      const timestamp = Date.now();

      // Parcourir tous les scripts dans le head
      const headScripts = document.head.querySelectorAll('script[type="module"][src*="/@fs/"]');
      headScripts.forEach(script => {
        // Supprimer uniquement les scripts du thème (pas hmr-body-reset.js ni @vite/client)
        if (script.src.includes('/themes/') &&
            !script.src.includes('hmr-body-reset.js') &&
            !script.src.includes('@vite/client')) {
          if (DEBUG) console.log('[Vite HMR] Suppression:', script.src);
          script.remove();
        }
      });

      // 4. Cloner et remplacer le body pour supprimer TOUS les event listeners
      // On le fait AVANT de réinjecter les scripts pour que le DOM soit vide
      const oldBody = document.body;
      const newBody = oldBody.cloneNode(false); // Clone sans enfants ni listeners
      newBody.innerHTML = ''; // Body vide temporairement
      oldBody.parentNode.replaceChild(newBody, oldBody);

      console.log('[Vite HMR] ✓ Body réinitialisé (vide temporairement)');

      // 5. Réinjecter les scripts du thème avec timestamp et attendre leur chargement
      console.log('[Vite HMR] Réinjection des scripts du thème...');

      const scriptPromises = [];

      viteSourceScripts.forEach(scriptInfo => {
        // Ne réinjecter que si c'est un script du thème (pas hmr-body-reset.js)
        if (!scriptInfo.path.includes('hmr-body-reset.js')) {
          const promise = new Promise((resolve) => {
            const script = document.createElement('script');
            script.type = 'module';
            script.src = scriptInfo.src + (scriptInfo.src.includes('?') ? '&' : '?') + 't=' + timestamp;

            script.onload = () => {
              console.log('[Vite HMR] ✓ Script chargé:', scriptInfo.path);
              resolve();
            };
            script.onerror = () => {
              console.warn('[Vite HMR] ⚠ Erreur script:', scriptInfo.path);
              resolve(); // Résoudre quand même
            };

            console.log('[Vite HMR] Injection:', scriptInfo.path);
            document.head.appendChild(script);
          });

          scriptPromises.push(promise);
        }
      });

      // 6. Une fois TOUS les scripts chargés, restaurer le body
      Promise.all(scriptPromises).then(() => {
        console.log('[Vite HMR] ✓ Tous les scripts chargés, restauration du body...');

        // Restaurer le HTML du body
        document.body.innerHTML = originalBodyHTML;

        console.log('[Vite HMR] ✓ Body restauré avec contenu');

        // 7. Déclencher manuellement un événement DOMContentLoaded custom pour que les modules se réinitialisent
        // Attendre un micro-tick pour que le DOM soit bien à jour
        setTimeout(() => {
          const event = new Event('DOMContentLoaded', {
            bubbles: true,
            cancelable: false
          });
          document.dispatchEvent(event);
          console.log('[Vite HMR] ✓ Événement DOMContentLoaded déclenché');

          // 8. Restaurer la position du scroll après un court délai pour que les modules s'initialisent
          setTimeout(() => {
            window.scrollTo(savedScrollPosition.x, savedScrollPosition.y);
            console.log('[Vite HMR] ✓ Position du scroll restaurée:', savedScrollPosition);
            console.log('[Vite HMR] ✓ HMR complet terminé');
          }, 50);
        }, 0);
      });
    } catch (error) {
      console.error('[Vite HMR] Erreur lors de la réinitialisation:', error);
    }
  }

  /**
   * Configuration du HMR Vite
   */
  function setupHMR() {
    // Vérifier que import.meta.hot est disponible
    if (!import.meta.hot) {
      console.warn('[Vite HMR] import.meta.hot non disponible');
      return;
    }

    console.log('[Vite HMR] Hook HMR activé');

    // Accepter les changements de ce module sans callback (ne rien faire sur ses propres changements)
    import.meta.hot.accept(() => {
      // Ne rien faire - on ne veut pas se réinitialiser nous-mêmes
    });

    // Hook global pour forcer la réinitialisation (debug)
    window.__VITE_HMR_RESET__ = resetBodyAndReinjectScripts;

    // Intercepter TOUS les updates HMR avant que Vite décide de reload
    // On utilise 'vite:beforeUpdate' pour détecter les changements
    import.meta.hot.on('vite:beforeUpdate', (payload) => {
      console.log('[Vite HMR] Changement détecté:', payload);

      // Vérifier s'il y a des updates JS UNIQUEMENT pour les fichiers .js du thème
      // NE PAS réinitialiser pour les .scss, .css, ou hmr-body-reset.js
      const jsUpdates = payload.updates?.filter(update =>
        update.type === 'js-update' &&
        update.path.endsWith('.js') &&
        !update.path.includes('.scss') &&
        !update.path.includes('.css') &&
        !update.path.includes('hmr-body-reset.js')
      );

      if (jsUpdates && jsUpdates.length > 0) {
        console.log('[Vite HMR] Mise à jour JS détectée:', jsUpdates.map(u => u.path).join(', '));

        // Empêcher le reload complet de Vite pour ces updates JS
        payload.updates = payload.updates.filter(update =>
          !(update.type === 'js-update' &&
            update.path.endsWith('.js') &&
            !update.path.includes('.scss') &&
            !update.path.includes('.css') &&
            !update.path.includes('hmr-body-reset.js'))
        );

        // Faire notre propre HMR
        resetBodyAndReinjectScripts();
      }
    });
  }

  // Initialisation au chargement du DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      captureInitialState();
      setupHMR();
    });
  } else {
    captureInitialState();
    setupHMR();
  }

  console.log('[Vite HMR] Body Reset Helper chargé');
})();
