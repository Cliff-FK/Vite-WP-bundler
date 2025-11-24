/**
 * Détecteur de sites multisite WordPress
 * Lit le wp-config.php et interroge MySQL en LECTURE SEULE
 * pour récupérer la liste des sites et leurs noms
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import mysql from 'mysql2/promise';
import { decode } from 'html-entities';
import { PATHS } from '../paths.config.js';

const MULTISITE_CACHE_FILE = resolve(PATHS.bundlerRoot, '.cache', 'multisite-urls.json');
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 heures

/**
 * Parse le fichier wp-config.php pour extraire les credentials MySQL
 */
function parseWpConfig() {
  const wpConfigPath = resolve(PATHS.wpRoot, 'wp-config.php');

  if (!existsSync(wpConfigPath)) {
    return null;
  }

  const content = readFileSync(wpConfigPath, 'utf8');

  // Regex pour extraire les constantes DB
  const dbName = content.match(/define\s*\(\s*['"]DB_NAME['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
  const dbUser = content.match(/define\s*\(\s*['"]DB_USER['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
  const dbPassword = content.match(/define\s*\(\s*['"]DB_PASSWORD['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
  const dbHost = content.match(/define\s*\(\s*['"]DB_HOST['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
  const tablePrefix = content.match(/\$table_prefix\s*=\s*['"]([^'"]+)['"]\s*;/);

  if (!dbName || !dbUser || !dbHost || !tablePrefix) {
    return null;
  }

  return {
    host: dbHost[1],
    user: dbUser[1],
    password: dbPassword ? dbPassword[1] : '',
    database: dbName[1],
    tablePrefix: tablePrefix[1]
  };
}

/**
 * Récupère les sites du multisite depuis MySQL (LECTURE SEULE)
 */
async function fetchMultisiteSites(dbConfig) {
  let connection;

  try {
    // Connexion MySQL en LECTURE SEULE
    connection = await mysql.createConnection({
      host: dbConfig.host,
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
      // Options de sécurité pour lecture seule
      multipleStatements: false,
      flags: '-FOUND_ROWS' // Désactive certaines fonctionnalités d'écriture
    });

    // Vérifier si c'est un multisite en cherchant la table wp_blogs
    const blogsTable = `${dbConfig.tablePrefix}blogs`;
    const [tables] = await connection.query(
      `SHOW TABLES LIKE ?`,
      [blogsTable]
    );

    if (tables.length === 0) {
      // Pas de table wp_blogs = pas de multisite
      return null;
    }

    // Récupérer tous les sites actifs (LECTURE SEULE)
    const [sites] = await connection.query(
      `SELECT blog_id, domain, path FROM ${blogsTable} WHERE deleted = 0 AND archived = 0 ORDER BY blog_id ASC`
    );

    if (sites.length === 0) {
      return null;
    }

    // Récupérer le nom de chaque site depuis wp_{blog_id}_options (LECTURE SEULE)
    const sitesWithNames = await Promise.all(
      sites.map(async (site) => {
        const optionsTable = `${dbConfig.tablePrefix}${site.blog_id === 1 ? '' : site.blog_id + '_'}options`;

        try {
          const [rows] = await connection.query(
            `SELECT option_value FROM ${optionsTable} WHERE option_name = 'blogname' LIMIT 1`
          );

          // Décoder les entités HTML (&amp; -> &, etc.)
          const rawSiteName = rows.length > 0 ? rows[0].option_value : `Site ${site.blog_id}`;
          const siteName = decode(rawSiteName);

          // Construire l'URL complète (toujours afficher le port pour cohérence avec Homepage)
          const protocol = PATHS.wpProtocol;
          const url = `${protocol}://${site.domain}:${PATHS.wpPort}${site.path.replace(/\/$/, '')}`;

          return {
            id: site.blog_id,
            name: siteName,
            url: url
          };
        } catch (err) {
          // Si la table n'existe pas, utiliser un nom par défaut
          const protocol = PATHS.wpProtocol;
          const url = `${protocol}://${site.domain}:${PATHS.wpPort}${site.path.replace(/\/$/, '')}`;

          return {
            id: site.blog_id,
            name: `Site ${site.blog_id}`,
            url: url
          };
        }
      })
    );

    return sitesWithNames;

  } catch (error) {
    // En cas d'erreur SQL, on retourne null silencieusement
    return null;
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

/**
 * Récupère le nom du site en non-multisite (depuis wp_options)
 */
async function fetchSingleSiteName(dbConfig) {
  let connection;

  try {
    connection = await mysql.createConnection({
      host: dbConfig.host,
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
      multipleStatements: false,
      flags: '-FOUND_ROWS'
    });

    const optionsTable = `${dbConfig.tablePrefix}options`;
    const [rows] = await connection.query(
      `SELECT option_value FROM ${optionsTable} WHERE option_name = 'blogname' LIMIT 1`
    );

    if (rows.length > 0) {
      return decode(rows[0].option_value);
    }

    return null;

  } catch (error) {
    return null;
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

/**
 * Récupère les sites multisite avec cache
 */
export async function getMultisiteSites() {
  // Vérifier le cache
  if (existsSync(MULTISITE_CACHE_FILE)) {
    try {
      const cacheData = JSON.parse(readFileSync(MULTISITE_CACHE_FILE, 'utf-8'));
      const cacheAge = Date.now() - new Date(cacheData.timestamp).getTime();

      // Si le cache a moins de 24h, le retourner
      if (cacheAge < CACHE_DURATION_MS) {
        return cacheData.sites;
      }
    } catch (err) {
      // Cache corrompu, on continue
    }
  }

  // Parser wp-config.php
  const dbConfig = parseWpConfig();
  if (!dbConfig) {
    return null; // wp-config.php introuvable ou invalide
  }

  // Interroger MySQL en LECTURE SEULE
  const sites = await fetchMultisiteSites(dbConfig);

  if (sites) {
    // Sauvegarder dans le cache
    const cacheDir = dirname(MULTISITE_CACHE_FILE);
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }

    writeFileSync(MULTISITE_CACHE_FILE, JSON.stringify({
      timestamp: new Date().toISOString(),
      sites: sites
    }, null, 2), 'utf-8');
  }

  return sites;
}

/**
 * Récupère le nom du site (multisite ou non)
 * Retourne un array avec un seul élément en non-multisite
 */
export async function getSiteName() {
  // Parser wp-config.php
  const dbConfig = parseWpConfig();
  if (!dbConfig) {
    return null;
  }

  // Récupérer le nom du site
  const siteName = await fetchSingleSiteName(dbConfig);
  return siteName;
}
