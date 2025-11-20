import { spawn } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundlerRoot = resolve(__dirname, '..');

/**
 * Démarrage du bundler :
 * Le MU-plugin est maintenant généré automatiquement par le plugin Vite
 * Ce script lance simplement Vite qui se charge de tout
 */

console.log('🚀 Démarrage du bundler Vite...\n');

// Démarrer Vite (le plugin generate-mu-plugin.plugin.js génère le MU-plugin automatiquement)
const viteProcess = spawn('vite', [], {
  cwd: bundlerRoot,
  shell: true,
  stdio: 'inherit'
});

// Gérer les signaux de fermeture
process.on('SIGINT', () => {
  console.log('\n🛑 Arrêt du serveur de développement...');
  viteProcess.kill('SIGINT');
  process.exit(0);
});

process.on('SIGTERM', () => {
  viteProcess.kill('SIGTERM');
  process.exit(0);
});

viteProcess.on('exit', (code) => {
  // Codes de sortie normaux lors d'un arrêt volontaire (Ctrl+C, etc.)
  // Code 0 = succès, null = tué par signal, 130 = SIGINT (Ctrl+C)
  if (code !== 0 && code !== null && code !== 130) {
    console.error(`❌ Vite s'est arrêté avec le code ${code}`);
    process.exit(code);
  }
  // Sortie normale
  process.exit(0);
});
