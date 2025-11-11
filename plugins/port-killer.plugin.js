import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Plugin Vite pour libérer automatiquement le port au démarrage
 * Tue uniquement les processus Node.js qui occupent le port configuré
 *
 * Cas d'usage:
 * - Un précédent `npm run dev` n'a pas été correctement arrêté
 * - Le terminal a été fermé sans kill le processus
 * - Ctrl+C n'a pas fonctionné correctement
 *
 * Sécurité:
 * - Ne tue QUE les processus Node.js (pas d'autres applications)
 * - Affiche un message clair avant de tuer
 * - Gère les erreurs silencieusement (si aucun processus trouvé)
 */
export function portKillerPlugin(port) {
  return {
    name: 'port-killer',

    async buildStart() {
      // Uniquement en mode dev (serve)
      if (this.meta?.watchMode) {
        await killProcessOnPort(port);
      }
    }
  };
}

/**
 * Tue le processus Node.js occupant le port spécifié (Windows uniquement)
 * @param {number} port - Port à libérer
 */
async function killProcessOnPort(port) {
  try {
    // Trouver le PID du processus occupant le port
    const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);

    if (!stdout.trim()) {
      // Aucun processus sur ce port, rien à faire
      return;
    }

    // Extraire le PID (dernière colonne)
    const lines = stdout.trim().split('\n');
    const pids = new Set();

    for (const line of lines) {
      // Format netstat: TCP    [::1]:5173    [::]:0    LISTENING    12345
      const match = line.trim().match(/LISTENING\s+(\d+)$/);
      if (match) {
        pids.add(match[1]);
      }
    }

    if (pids.size === 0) {
      return;
    }

    // Vérifier si c'est un processus Node.js avant de tuer
    for (const pid of pids) {
      try {
        const { stdout: tasklistOutput } = await execAsync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`);

        // Format tasklist CSV: "node.exe","12345","Console","1","123,456 K"
        const isNodeProcess = tasklistOutput.toLowerCase().includes('node.exe');

        if (isNodeProcess) {
          console.log(`🔓 Port ${port} occupé par Node.js (PID ${pid}), libération...`);
          await execAsync(`taskkill /F /PID ${pid}`);
          console.log(`   ✓ Processus ${pid} arrêté`);

          // Attendre un peu pour que le port soit vraiment libéré
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          console.warn(`⚠️  Port ${port} occupé par un processus non-Node (PID ${pid}), ignoré`);
        }
      } catch (err) {
        // Processus déjà mort ou erreur de permission, ignorer
      }
    }

  } catch (err) {
    // Erreurs attendues:
    // - netstat ne trouve rien (port libre)
    // - taskkill échoue (processus déjà mort)
    // On ignore silencieusement ces erreurs
  }
}
