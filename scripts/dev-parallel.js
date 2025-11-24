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

  console.log('\n🔨 Lancement du build automatique...\n');

  const buildResult = spawnSync('npm', ['run', 'build'], {
    cwd: bundlerRoot,
    shell: true,
    stdio: 'inherit'
  });

  process.exit(buildResult.status || 0);
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
  if (!isExiting) process.exit(0);
});

// Gérer la fermeture propre de Vite
viteProcess.on('exit', (code, signal) => {
  runBuildIfNeeded();
  if (!isExiting) process.exit(0);
});

// Intercepter Ctrl+C (SIGINT)
process.on('SIGINT', () => {
  viteProcess.kill('SIGINT');
  setTimeout(() => {
    runBuildIfNeeded();
  }, 100);
});

// Intercepter SIGTERM
process.on('SIGTERM', () => {
  viteProcess.kill('SIGTERM');
  setTimeout(() => {
    runBuildIfNeeded();
  }, 100);
});

// Intercepter la fermeture du terminal
process.on('exit', () => {
  if (!isExiting && viteProcess.pid) {
    viteProcess.kill();
  }
});
