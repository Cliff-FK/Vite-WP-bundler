import { spawn } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundlerRoot = resolve(__dirname, '..');

/**
 * Démarrage parallèle optimisé :
 * 1. Génération du MU-plugin
 * 2. Démarrage de Vite en parallèle (ne dépend pas du MU-plugin)
 */

console.log('🚀 Démarrage parallèle du bundler...\n');

// Générer le MU-plugin en arrière-plan
const muPluginProcess = spawn('node', ['plugins/generate-mu-plugin.js'], {
  cwd: bundlerRoot,
  shell: true,
  stdio: 'inherit'
});

// Petit délai pour que le MU-plugin démarre en premier (non bloquant)
setTimeout(() => {
  // Démarrer Vite immédiatement après
  const viteProcess = spawn('vite', [], {
    cwd: bundlerRoot,
    shell: true,
    stdio: 'inherit'
  });

  // Gérer les signaux de fermeture
  process.on('SIGINT', () => {
    console.log('\n🛑 Arrêt du serveur de développement...');
    viteProcess.kill('SIGINT');
    muPluginProcess.kill('SIGINT');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    viteProcess.kill('SIGTERM');
    muPluginProcess.kill('SIGTERM');
    process.exit(0);
  });

  viteProcess.on('exit', (code) => {
    if (code !== 0) {
      console.error(`❌ Vite s'est arrêté avec le code ${code}`);
      process.exit(code);
    }
  });
}, 100);

muPluginProcess.on('error', (err) => {
  console.error('❌ Erreur génération MU-plugin:', err);
  process.exit(1);
});
