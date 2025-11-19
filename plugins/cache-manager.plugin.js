import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { createHash } from 'crypto';
import { resolve, dirname } from 'path';
import { PATHS, PHP_FILES_TO_SCAN } from '../paths.config.js';

/**
 * Gestionnaire de cache persistent pour les assets détectés
 * Cache invalidé si les fichiers PHP changent
 */

const CACHE_DIR = resolve(PATHS.bundlerRoot, '.cache');
const CACHE_FILE = resolve(CACHE_DIR, 'assets-cache.json');

/**
 * Calcule un hash MD5 du contenu de tous les fichiers PHP scannés
 */
function calculatePhpFilesHash() {
  const hashes = [];

  for (const phpFile of PHP_FILES_TO_SCAN) {
    const phpFilePath = resolve(PATHS.themePath, phpFile);

    if (existsSync(phpFilePath)) {
      const content = readFileSync(phpFilePath, 'utf-8');
      const hash = createHash('md5').update(content).digest('hex');
      hashes.push(`${phpFile}:${hash}`);
    }
  }

  // Combiner tous les hashes
  return createHash('md5').update(hashes.join('|')).digest('hex');
}

/**
 * Lit le cache depuis le fichier
 */
function readCache() {
  if (!existsSync(CACHE_FILE)) {
    return null;
  }

  try {
    const content = readFileSync(CACHE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.warn('Cache corrompu, régénération...');
    return null;
  }
}

/**
 * Écrit le cache dans le fichier
 */
function writeCache(data) {
  try {
    // Créer le dossier .cache s'il n'existe pas
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }

    writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.warn('Impossible d\'écrire le cache:', error.message);
  }
}

/**
 * Récupère les assets depuis le cache ou retourne null si invalide
 * Retourne aussi l'ancien buildFolder s'il existe
 */
export function getCachedAssets() {
  const currentHash = calculatePhpFilesHash();
  const cache = readCache();

  if (!cache) {
    return { assets: null, oldBuildFolder: null };
  }

  // Vérifier si le hash correspond
  if (cache.hash !== currentHash) {
    // console.log('Fichiers PHP modifiés, régénération du cache...');
    // console.log('  Hash ancien:', cache.hash);
    // console.log('  Hash nouveau:', currentHash);
    return { assets: null, oldBuildFolder: cache.assets?.buildFolder || null };
  }

  // console.log('Cache valide, chargement instantané');
  return { assets: cache.assets, oldBuildFolder: null };
}

/**
 * Sauvegarde les assets dans le cache
 */
export function saveCachedAssets(assets) {
  const currentHash = calculatePhpFilesHash();

  const cacheData = {
    hash: currentHash,
    timestamp: new Date().toISOString(),
    assets: assets
  };

  writeCache(cacheData);
}

/**
 * Invalide manuellement le cache
 */
export async function invalidateCache() {
  if (existsSync(CACHE_FILE)) {
    try {
      const { unlinkSync } = await import('fs');
      unlinkSync(CACHE_FILE);
      console.log('Cache invalidé');
    } catch (error) {
      console.warn('Impossible de supprimer le cache:', error.message);
    }
  }
}

/**
 * Supprime un ancien dossier de build
 */
export function deleteOldBuildFolder(oldBuildFolder) {
  if (!oldBuildFolder) return;

  // Retirer le slash de début
  const cleanFolder = oldBuildFolder.replace(/^\//, '');
  const oldBuildPath = resolve(PATHS.themePath, cleanFolder);

  if (existsSync(oldBuildPath)) {
    try {
      rmSync(oldBuildPath, { recursive: true, force: true });
      console.log(`Ancien dossier de build supprimé: ${cleanFolder}/`);
    } catch (error) {
      console.warn(`Impossible de supprimer ${cleanFolder}/:`, error.message);
    }
  }
}
