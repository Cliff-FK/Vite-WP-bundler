/**
 * Vite HMR Editor Guard
 *
 * Injecté dans les documents ÉDITEUR (page admin parente + canvas iframé Gutenberg)
 * quand VITE_EDITOR=true. Rôle : garder le HMR CSS natif (bénéfice réel dans
 * l'éditeur) tout en signalant les changements JS du thème.
 *
 * Les js-updates du thème ne sont plus propagés par Vite : le plugin serveur
 * (accept-all-hmr, handleHotUpdate) les suspend et émet l'événement custom
 * 'wp:theme-js-update'. Côté éditeur, pas d'infrastructure de reset (le canvas
 * est piloté par React/Gutenberg) : on invite simplement à recharger.
 */

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    // Ne rien faire sur ses propres changements
  });

  import.meta.hot.on('wp:theme-js-update', (data) => {
    const files = (data.paths || []).map(p => p.split('/').pop()).join(', ') || (data.file || '').split('/').pop();
    console.warn(
      '[Vite Editor] JS du thème modifié — recharger l\'éditeur pour appliquer :',
      files
    );
  });
}
