import { spawn, spawnSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { BUILD_ON_EXIT } from '../paths.config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundlerRoot = resolve(__dirname, '..');

let isExiting = false;

/**
 * Lance le build si BUILD_ON_EXIT est activé
 */
function runBuildIfNeeded() {
  if (isExiting || !BUILD_ON_EXIT) return;
  isExiting = true;

  
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
