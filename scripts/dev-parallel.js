import { spawn, spawnSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { readdirSync, unlinkSync } from 'fs';
import { BUILD_ON_EXIT } from '../paths.config.js';
import { deleteMuPlugin } from '../plugins/generate-mu-plugin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundlerRoot = resolve(__dirname, '..');

let isExiting = false;

/**
 * Purge les fichiers temporaires de chargement de config Vite
 * (vite.config.js.timestamp-*.mjs, laissés sur disque après un crash)
 */
function cleanStaleTimestamps() {
  try {
    for (const f of readdirSync(bundlerRoot)) {
      if (/^vite\.config\.js\.timestamp-.*\.mjs$/.test(f)) {
        try { unlinkSync(resolve(bundlerRoot, f)); } catch (err) { /* Ignorer */ }
      }
    }
  } catch (err) { /* Ignorer */ }
}

/**
 * Nettoyage de sortie : TOUJOURS retirer le MU-plugin et les fichiers temporaires
 * (même si BUILD_ON_EXIT=false — sinon les traces dev survivent jusqu'à la
 * prochaine visite de page qui déclenche l'auto-destruction PHP), puis build
 * de production si configuré
 */
function runExitCleanup() {
  if (isExiting) return;
  isExiting = true;

  try { deleteMuPlugin(); } catch (err) { /* Ignorer */ }
  cleanStaleTimestamps();

  if (!BUILD_ON_EXIT) return;

  const buildResult = spawnSync('npm', ['run', 'build'], {
    cwd: bundlerRoot,
    shell: true,
    stdio: 'inherit'
  });

  // Laisser Node terminer naturellement pour que PowerShell affiche son prompt
  process.exitCode = buildResult.status || 0;
}

/**
 * Démarrage du bundler :
 * Le MU-plugin est maintenant généré automatiquement par le plugin Vite
 * Ce script lance simplement Vite qui se charge de tout
 */

// Démarrer Vite (le plugin generate-mu-plugin.plugin.js génère le MU-plugin automatiquement)
const viteProcess = spawn('vite', [], {
  cwd: bundlerRoot,
  shell: true,
  stdio: 'inherit'
});

// Gérer les erreurs du processus
viteProcess.on('error', (err) => {
  console.error('Erreur lors du démarrage de Vite:', err);
  runBuildIfNeeded();
  // Laisser Node terminer naturellement
});

// Gérer la fermeture propre de Vite
viteProcess.on('exit', (code, signal) => {
  runBuildIfNeeded();
  // Laisser Node terminer naturellement
});

// Intercepter Ctrl+C (SIGINT)
process.on('SIGINT', () => {
  console.log(''); // Forcer un retour à la ligne propre
  viteProcess.kill('SIGINT');
  setTimeout(() => {
    runBuildIfNeeded();
  }, 250); // Délai pour laisser Vite libérer les fichiers
});

// Intercepter SIGTERM
process.on('SIGTERM', () => {
  viteProcess.kill('SIGTERM');
  setTimeout(() => {
    runBuildIfNeeded();
  }, 250); // Délai pour laisser Vite libérer les fichiers
});

// Intercepter la fermeture du terminal
process.on('exit', () => {
  if (!isExiting && viteProcess.pid) {
    viteProcess.kill();
  }
  // Réinitialiser le terminal et afficher un faux prompt PowerShell
  process.stdout.write(`\x1b[0m\x1b[?25h\nPS ${process.cwd()}> `);
});
