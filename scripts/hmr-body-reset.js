/**
 * Vite HMR Body Reset Helper
 *
 * Script injecté automatiquement en mode dev pour gérer un HMR simplifié :
 * - Capture l'état initial du fragment principal au chargement
 * - Détecte les changements HMR sur les modules JS
 * - Restaure le fragment principal puis réinjecte les scripts du thème
 *
 * Principe clé : ne JAMAIS remplacer les nœuds pérennes (body, header, footer, main).
 * Les modules ES du thème non modifiés ne sont pas réévalués (cache module navigateur) ;
 * toute référence DOM figée au scope module (ex: export const bodyDOM = document.querySelector(...))
 * pointerait vers un nœud détaché si on remplaçait le nœud : les actions du thème partiraient
 * alors silencieusement dans un arbre mort (cas historique des modales).
 * On restaure donc le HTML DU fragment principal (granularité calquée sur le swap Unpoly :
 * [up-main] / main, fallback body) en conservant l'identité des nœuds structurants.
 *
 * Avantages :
 * - Pas de modification du code du thème
 * - Nettoyage automatique des event listeners (tous nœuds, window, document) et des handlers up.on
 * - Reset des flags globaux primitifs (guards type window.xxxInit) sans toucher aux libs
 */

(function() {
  'use strict';

  // Garde d'installation : si ce module est réévalué (édition de ce fichier même),
  // ne pas empiler une seconde instance de wrappers/baselines — recharger la page.
  if (window.__VITE_HMR_RESET_INSTALLED__) {
    console.warn('[Vite HMR] hmr-body-reset déjà installé — recharge la page pour appliquer sa nouvelle version');
    return;
  }
  window.__VITE_HMR_RESET_INSTALLED__ = true;

  // Mode debug (mettre à true pour activer les logs détaillés)
  const DEBUG = true;

  // Origine du serveur Vite (déduite de notre propre URL de module) : les URLs
  // de modules envoyées par le serveur sont relatives à la racine Vite
  const VITE_ORIGIN = new URL(import.meta.url).origin;

  // Liste des modules JS du thème, fournie par le serveur dans chaque événement
  // wp:theme-js-update (calculée depuis le module graph). Ré-importés avec
  // cache-bust au reset pour re-exécuter leurs effets de bord top-level
  // (ex: un addEventListener au scope module) que le nettoyage des listeners a
  // retirés et que le cache ES module ne rejouerait jamais sinon.
  // Vide tant qu'aucun événement n'est arrivé (un __VITE_HMR_RESET__() manuel
  // avant le premier update resette sans ré-imports top-level).
  let lastModuleUrls = [];

  /*------------------------------------*/
  // BASELINE — capturé à l'évaluation de ce module, c'est-à-dire APRÈS tous les
  // scripts classiques (libs, unpoly, jQuery...) et AVANT les modules du thème
  // (ordre d'exécution des <script type="module"> = ordre d'insertion dans le head)
  /*------------------------------------*/

  // Fragment principal à restaurer : même granularité que le swap Unpoly en prod
  const mainEl = document.querySelector('[up-main]') || document.querySelector('main') || document.body;
  const isBodyFallback = mainEl === document.body;

  const originalMainHTML = mainEl ? mainEl.innerHTML : null;
  const originalMainAttrs = mainEl ? Array.from(mainEl.attributes).map(a => [a.name, a.value]) : [];
  const originalBodyAttrs = document.body ? Array.from(document.body.attributes).map(a => [a.name, a.value]) : [];

  // Enfants directs du body à l'initial : tout enfant direct ajouté ensuite par le JS
  // (ex: modales déplacées en fin de body) sera retiré au reset pour éviter les doublons
  const originalBodyChildren = new Set(document.body ? Array.from(document.body.children) : []);

  // Clés window à l'initial : les clés PRIMITIVES apparues ensuite (flags/guards du thème,
  // ex: window.mdlEventInit) seront purgées au reset. Les fonctions/objets (libs UMD comme
  // Masonry, Unpoly, tableaux de bookkeeping) sont préservés : leurs modules restent en
  // cache ES et ne se ré-exécuteraient pas pour les recréer.
  const baselineWindowKeys = new Set(Object.keys(window));

  // Liste des scripts JS Vite sources à réinjecter (seulement .js, pas .scss/.css)
  let viteSourceScripts = [];

  // Position du scroll sauvegardée
  let savedScrollPosition = { x: 0, y: 0 };

  /*------------------------------------*/
  // TRACKING DES RESSOURCES CRÉÉES PAR LES SCRIPTS DU THÈME
  /*------------------------------------*/

  // Tracker TOUS les addEventListener posés après ce point (nœuds, window, document).
  // Les nœuds pérennes survivant au reset (body, header, footer...), leurs listeners
  // doivent être retirés explicitement avant re-init, sinon ils s'empilent.
  const trackedListeners = [];
  const originalAddEventListener = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    // Ne tracker que le DOM : les cibles non-DOM (WebSocket du client Vite,
    // MediaQueryList, XHR...) gèrent leur propre cycle de vie
    if (this === window || this === document || this instanceof Node) {
      trackedListeners.push({ target: this, type, listener, options });
    }
    return originalAddEventListener.call(this, type, listener, options);
  };

  // Tracker les handlers Unpoly (up.on) : ils ne passent pas par addEventListener
  // et s'empileraient à chaque réinjection de main.js. Unpoly est un script classique,
  // donc déjà chargé quand ce module s'évalue ; on garde un wrap lazy par sécurité.
  const trackedUpUnbinds = [];
  let upOnWrapped = false;
  function wrapUpOn() {
    if (upOnWrapped || typeof window.up === 'undefined' || typeof window.up.on !== 'function') return;
    upOnWrapped = true;
    const originalUpOn = window.up.on;
    window.up.on = function(...args) {
      const unbind = originalUpOn.apply(this, args);
      if (typeof unbind === 'function') trackedUpUnbinds.push(unbind);
      return unbind;
    };
  }
  wrapUpOn();

  /**
   * Nettoie tous les listeners et handlers up.on trackés
   */
  function cleanTrackedListeners() {
    if (DEBUG) console.log('[Vite HMR] Nettoyage de', trackedListeners.length, 'listeners et', trackedUpUnbinds.length, 'handlers up.on');
    trackedListeners.forEach(({ target, type, listener, options }) => {
      try {
        target.removeEventListener(type, listener, options);
      } catch (e) {
        // Ignorer les erreurs de nettoyage
      }
    });
    trackedListeners.length = 0;

    trackedUpUnbinds.forEach(unbind => {
      try { unbind(); } catch (e) { /* Ignorer */ }
    });
    trackedUpUnbinds.length = 0;
  }

  /**
   * Purge les flags globaux primitifs posés par les scripts du thème depuis le baseline.
   * Cible les guards du type `if (!window.xxxInit) { bind(); } window.xxxInit = true;` :
   * leurs listeners viennent d'être nettoyés, le guard doit tomber pour que la
   * réinjection re-binde. Les fonctions/objets/arrays sont préservés (libs, instances).
   */
  function purgeThemePrimitiveGlobals() {
    const purged = [];
    for (const key of Object.keys(window)) {
      if (baselineWindowKeys.has(key)) continue;
      const type = typeof window[key];
      if (type === 'boolean' || type === 'number' || type === 'string') {
        try {
          delete window[key];
          purged.push(key);
        } catch (e) {
          try { window[key] = undefined; purged.push(key); } catch (e2) { /* Ignorer */ }
        }
      }
    }
    if (DEBUG && purged.length) console.log('[Vite HMR] Guards globaux purgés:', purged.join(', '));
  }

  /**
   * Restaure les attributs d'un élément à leur état sauvegardé
   */
  function restoreAttributes(el, savedAttrs) {
    Array.from(el.attributes).forEach(attr => el.removeAttribute(attr.name));
    savedAttrs.forEach(([name, value]) => el.setAttribute(name, value));
  }

  /**
   * Détecte les scripts JS Vite (le HTML est déjà capturé à l'initialisation)
   */
  function captureInitialState() {
    // Détecter uniquement les scripts JS externes (type="module" avec src="/@fs/" et .js)
    const externalScripts = document.querySelectorAll('script[type="module"][src*="/@fs/"]');
    viteSourceScripts = Array.from(externalScripts)
      .filter(script => script.src.endsWith('.js'))
      .map(script => ({
        src: script.src,
        path: script.src.split('/@fs/').pop()
      }));
  }

  /**
   * Ré-exécute les <script> présents dans le fragment restauré.
   * innerHTML réinsère les balises script INERTES : les blocs qui embarquent un
   * loader (carte, sticky...) resteraient morts. Cloner chaque script dans un
   * nouvel élément déclenche son exécution, comme à un vrai chargement de page.
   */
  function reExecuteFragmentScripts(root) {
    root.querySelectorAll('script').forEach(oldScript => {
      const s = document.createElement('script');
      Array.from(oldScript.attributes).forEach(a => s.setAttribute(a.name, a.value));
      const type = (oldScript.getAttribute('type') || 'text/javascript').toLowerCase();
      const isClassicJs = /^(text|application)\/(java|ecma)script$/.test(type);
      if (!oldScript.src && isClassicJs && oldScript.textContent.trim()) {
        // Script inline classique : envelopper dans une IIFE. Ses const/let top-level
        // ont créé des bindings lexicaux globaux à la 1re exécution ; une ré-exécution
        // telle quelle jetterait "Identifier ... has already been declared".
        // Contrepartie assumée : un var/function destiné à un AUTRE script inline
        // n'est plus global au re-run (exposer via window.x si ce besoin existe).
        s.textContent = ';(function(){\n' + oldScript.textContent + '\n})();';
      } else {
        s.textContent = oldScript.textContent;
      }
      oldScript.replaceWith(s);
    });
  }

  // Garde de ré-entrance : deux saves rapprochés déclenchent deux événements ;
  // sans garde, les deux réinjections s'entremêlent (scripts ?t=T1 ET ?t=T2 évalués
  // → double init du thème). On sérialise : un reset en vol, au plus un en attente.
  // La file PORTE les chemins modifiés du dernier save (null = rien en attente) :
  // sans eux, la relance ré-importerait le module changé une 2e fois (bloc 7b).
  let resetInFlight = false;
  let resetQueuedPaths = null;

  /**
   * Restaure le fragment principal et réinjecte les scripts Vite
   * @param {string[]} changedPaths - Chemins des modules modifiés par cet update
   *   (déjà réévalués via la chaîne d'imports des entrées : exclus du ré-import 7b
   *   pour éviter leur double évaluation)
   */
  function resetBodyAndReinjectScripts(changedPaths = []) {
    if (originalMainHTML === null) {
      return;
    }

    if (resetInFlight) {
      resetQueuedPaths = changedPaths;
      if (DEBUG) console.log('[Vite HMR] Reset déjà en vol — mis en file');
      return;
    }
    resetInFlight = true;

    try {
      // 1. Sauvegarder la position du scroll
      savedScrollPosition = {
        x: window.scrollX || window.pageXOffset,
        y: window.scrollY || window.pageYOffset
      };
      if (DEBUG) console.log('[Vite HMR] Position du scroll sauvegardée:', savedScrollPosition);

      // 2. Nettoyer les event listeners et handlers up.on trackés
      cleanTrackedListeners();

      // 3. Purger les guards globaux primitifs pour que la réinjection re-binde
      purgeThemePrimitiveGlobals();

      // 4. Retirer les enfants directs du body ajoutés par le JS depuis le chargement
      // (modales déplacées, overlays...) : leurs originaux reviennent avec le fragment restauré
      Array.from(document.body.children).forEach(child => {
        if (!originalBodyChildren.has(child)) {
          if (DEBUG) console.log('[Vite HMR] Suppression enfant body ajouté par JS:', child.tagName + '.' + (child.className || ''));
          child.remove();
        }
      });

      // 5. Restaurer le fragment principal SANS remplacer les nœuds pérennes.
      // body/header/footer/main gardent leur identité : les références figées au
      // scope module des scripts non réévalués restent valides.
      restoreAttributes(document.body, originalBodyAttrs);
      if (!isBodyFallback) {
        restoreAttributes(mainEl, originalMainAttrs);
      }
      mainEl.innerHTML = originalMainHTML;
      reExecuteFragmentScripts(mainEl);

      // 6. Supprimer les anciens scripts du thème du <head> (mais garder Vite client et hmr-body-reset.js)
      const timestamp = Date.now();
      const headScripts = document.head.querySelectorAll('script[type="module"][src*="/@fs/"]');
      headScripts.forEach(script => {
        if (script.src.includes('/themes/') &&
            !script.src.includes('hmr-body-reset.js') &&
            !script.src.includes('@vite/client')) {
          if (DEBUG) console.log('[Vite HMR] Suppression:', script.src);
          script.remove();
        }
      });

      // 7. Réinjecter les scripts du thème avec timestamp. Le DOM est DÉJÀ restauré :
      // les effets de bord top-level des modules réévalués (querySelector au scope module)
      // voient un DOM complet, pas un fragment vide.
      const scriptPromises = [];

      viteSourceScripts.forEach(scriptInfo => {
        // Ne réinjecter que les modules custom du thème
        // Exclure: hmr-body-reset.js et les libs tierces (_libs/) qui ne supportent pas le re-boot
        if (!scriptInfo.path.includes('hmr-body-reset.js') && !scriptInfo.path.includes('/_libs/')) {
          const promise = new Promise((resolve) => {
            const script = document.createElement('script');
            script.type = 'module';
            script.src = scriptInfo.src + (scriptInfo.src.includes('?') ? '&' : '?') + 't=' + timestamp;

            script.onload = () => resolve();
            script.onerror = () => resolve();
            document.head.appendChild(script);
          });

          scriptPromises.push(promise);
        }
      });

      // 7b. Ré-importer chaque module du thème enregistré (hors entrées, déjà réinjectées)
      // avec cache-bust : re-exécute leurs effets de bord top-level (listeners au scope
      // module retirés par le nettoyage) que le cache ES module ne rejouerait jamais.
      const entryPaths = new Set(viteSourceScripts.map(i => i.src.split('?')[0]));
      const changedClean = changedPaths.map(p => p.split('?')[0]);
      lastModuleUrls.forEach(moduleUrl => {
        // URLs racine-Vite envoyées par le serveur (ex: /@fs/C:/.../modal.js)
        const cleanUrl = moduleUrl.split('?')[0];
        const absoluteUrl = cleanUrl.startsWith('http') ? cleanUrl : VITE_ORIGIN + cleanUrl;
        if (entryPaths.has(absoluteUrl) || cleanUrl.includes('/_libs/')) return;
        // Le module modifié est déjà réévalué via la chaîne d'imports des entrées
        // (?t serveur, invalidation isHmr) : le ré-importer ici l'évaluerait une 2e fois
        if (changedClean.some(p => cleanUrl.endsWith(p) || absoluteUrl.endsWith(p))) return;
        scriptPromises.push(
          import(/* @vite-ignore */ absoluteUrl + '?t=' + timestamp).catch(() => {})
        );
      });

      // 8. Une fois TOUS les scripts chargés, déclencher l'événement d'init du thème
      Promise.all(scriptPromises).then(() => {
        setTimeout(() => {
          try {
            wrapUpOn(); // Au cas où Unpoly serait apparu tardivement

            // Si Unpoly est présent, utiliser son événement (le thème écoute up:fragment:inserted)
            // Sinon utiliser DOMContentLoaded
            if (typeof up !== 'undefined' && up.emit) {
              up.emit('up:fragment:inserted', { target: document.body });
            } else {
              const event = new Event('DOMContentLoaded', {
                bubbles: true,
                cancelable: false
              });
              document.dispatchEvent(event);
            }
          } catch (error) {
            console.error('[Vite HMR] Erreur lors du re-init du thème:', error);
          } finally {
            // 9. Restaurer le scroll après un court délai (init des modules), PUIS
            // 10. libérer la garde de ré-entrance et rejouer l'éventuel reset en file
            // (après la restauration, pour que le reset suivant capture un scroll juste)
            setTimeout(() => {
              try {
                window.scrollTo(savedScrollPosition.x, savedScrollPosition.y);
              } catch (e) { /* Ignorer */ }
              resetInFlight = false;
              if (resetQueuedPaths !== null) {
                const queuedPaths = resetQueuedPaths;
                resetQueuedPaths = null;
                if (DEBUG) console.log('[Vite HMR] Reset en file — relance');
                resetBodyAndReinjectScripts(queuedPaths);
              }
            }, 50);
          }
        }, 0);
      });
    } catch (error) {
      console.error('[Vite HMR] Erreur lors de la réinitialisation:', error);
      resetInFlight = false;
      if (resetQueuedPaths !== null) {
        const queuedPaths = resetQueuedPaths;
        resetQueuedPaths = null;
        resetBodyAndReinjectScripts(queuedPaths);
      }
    }
  }

  /**
   * Configuration du HMR Vite
   */
  function setupHMR() {
    // Vérifier que import.meta.hot est disponible
    if (!import.meta.hot) {
      return;
    }

    // Accepter les changements de ce module sans callback (ne rien faire sur ses propres changements)
    import.meta.hot.accept(() => {
      // Ne rien faire - on ne veut pas se réinitialiser nous-mêmes
    });

    // Hook global pour forcer la réinitialisation (debug)
    window.__VITE_HMR_RESET__ = resetBodyAndReinjectScripts;

    // Écouter l'événement custom envoyé par le plugin serveur (handleHotUpdate,
    // API documentée Vite) : les js-updates du thème ne sont plus propagés par
    // Vite lui-même — le serveur les a suspendus (return []), invalidés (isHmr)
    // et nous notifie avec la liste des modules du thème et des modules changés
    import.meta.hot.on('wp:theme-js-update', (data) => {
      lastModuleUrls = data.moduleUrls || [];
      resetBodyAndReinjectScripts(data.paths || []);
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
})();
