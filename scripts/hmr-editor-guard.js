/**
 * Vite HMR Editor Guard
 *
 * Injecté dans les documents ÉDITEUR (page admin parente + canvas iframé Gutenberg)
 * quand VITE_EDITOR=true. Rôle : garder le HMR CSS natif (bénéfice réel dans
 * l'éditeur) mais BLOQUER l'application des js-updates.
 *
 * Pourquoi : accept-all-hmr rend tous les modules du thème auto-acceptants ;
 * sans ce garde, chaque édition JS réévalue les modules dans l'éditeur SANS
 * l'infrastructure de reset du front (hmr-body-reset) → les abonnements
 * s'empilent à chaque save (wp.data.subscribe, acf.addAction...) et l'éditeur
 * se dégrade progressivement. Ici on absorbe l'update et on invite à recharger.
 */

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    // Ne rien faire sur ses propres changements
  });

  import.meta.hot.on('vite:beforeUpdate', (payload) => {
    const jsUpdates = (payload.updates || []).filter(update =>
      update.type === 'js-update' &&
      update.path.endsWith('.js') &&
      !update.path.includes('.scss') &&
      !update.path.includes('.css')
    );

    if (jsUpdates.length > 0) {
      payload.updates = payload.updates.filter(update => !jsUpdates.includes(update));
      console.warn(
        '[Vite Editor] JS du thème modifié — recharger l\'éditeur pour appliquer :',
        jsUpdates.map(u => u.path.split('/').pop()).join(', ')
      );
    }
  });
}
