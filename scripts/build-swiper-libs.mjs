/*------------------------------------*/
// GÉNÉRATION DES MODULES SWIPER VENDORED (_libs/swiper/) + CSS VENDOR (_swiper.css)
/*------------------------------------*/
// Régénère, depuis le package npm `swiper` installé en devDependency de ce bundler, les fichiers
// consommés au runtime par lib-loader.js du thème : un ESM minifié `export default` par module
// (swiper-core.min.js + <module>.min.js en kebab-case) et le CSS bundle officiel.
//
// Usage (après toute mise à jour de version) :
//   cd .vite && npm i -D swiper@<version> && npm run build:swiper
// puis `npm run build` pour propager dans dist/ (copy-minified-libs).
//
// Choix : on émet UN fichier par export de swiper/modules (découverte dynamique, zéro liste en
// dur) — le dossier est le miroir exact du jeu officiel de modules de la version installée. Un
// module non chargeable par lib-loader (hors SWIPER_PARAM_MODULES/effect-*) reste inerte : il
// n'est jamais téléchargé au runtime. Les cibles esbuild = baseline navigateurs officielle de la
// version Swiper installée (v14 : Chrome/Edge 110+, Safari 16.4+, Firefox 110+).

import { build } from 'esbuild';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { PATHS } from '../paths.config.js';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLER_ROOT = resolve(__dirname, '..');

const VERSION = require('swiper/package.json').version;
const TARGET = ['chrome110', 'edge110', 'safari16.4', 'firefox110'];

// ─── Découverte des emplacements cibles dans le thème (rien en dur au-delà des conventions) ───
// Dossier JS : le dossier `_libs/swiper/` existant sous le thème (créé à la 1re vendorisation).
// Fichier CSS : le vendor `_swiper.css` existant sous le thème.
function findDir(base, matcher, depth = 5) {
    if (depth < 0) return null;
    for (const e of readdirSync(base, { withFileTypes: true })) {
        if (!e.isDirectory() || ['node_modules', 'vendor', '.git', 'dist'].includes(e.name)) continue;
        const p = join(base, e.name);
        if (matcher(p)) return p;
        const sub = findDir(p, matcher, depth - 1);
        if (sub) return sub;
    }
    return null;
}
const outDir = findDir(PATHS.themePath, p => p.replace(/\\/g, '/').endsWith('_libs/swiper'));
const cssOut = findDir(PATHS.themePath, p => existsSync(join(p, '_swiper.css')));
if (!outDir) throw new Error('Dossier _libs/swiper introuvable sous ' + PATHS.themePath);
if (!cssOut) throw new Error('Vendor _swiper.css introuvable sous ' + PATHS.themePath);

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const kb = (n) => (statSync(n).size / 1024).toFixed(1) + ' Ko';

// Un build esbuild par entrée virtuelle (stdin) — bundle autonome, minifié, format ESM.
const emit = (contents, name, banner) =>
    build({
        stdin: { contents, resolveDir: BUNDLER_ROOT, sourcefile: name + '.entry.js' },
        bundle: true,
        minify: true,
        format: 'esm',
        target: TARGET,
        banner: { js: banner },
        outfile: join(outDir, name + '.min.js'),
        logLevel: 'warning',
    }).then(() => name + '.min.js');

const before = new Set(readdirSync(outDir).filter(f => f.endsWith('.min.js')));

// Modules : découverts en important réellement swiper/modules (source de vérité de la version).
const moduleExports = Object.keys(await import('swiper/modules')).filter(n => n !== 'default').sort();

const jobs = [
    emit(`export { default } from 'swiper';`, 'swiper-core',
        `/* Swiper ${VERSION} core (build maison esbuild, cf. lib-loader.js) */`),
    ...moduleExports.map(name =>
        emit(`export { ${name} as default } from 'swiper/modules';`, kebab(name),
            `/* Swiper ${VERSION} module ${name} (build maison esbuild) */`)),
];
const written = await Promise.all(jobs);

// CSS vendor du thème (nom/emplacement conservés, importé par style.scss) : core + SEULS les
// modules dont le CSS est réellement consommé — miroir CSS du chargement JS à la carte de
// lib-loader.js. Découverte dynamique (rien en dur) :
//   - noms de modules-params = la constante SWIPER_PARAM_MODULES lue DANS lib-loader.js (source
//     de vérité unique) ; un module est retenu si sa clé de config apparaît dans le code du thème
//     (`nav: {...}` JS ou `'nav' =>` PHP) — même logique de détection que le runtime : ajouter
//     demain un réglage `scrollbar` dans un bloc ⇒ son CSS revient tout seul au prochain
//     build:swiper, comme son JS au runtime.
//   - effets = exports Effect* de swiper/modules, retenus si l'effet apparaît quoté ('fade')
//     dans le code du thème (configs + effectMap des render.php).
//   - a11y TOUJOURS inclus : lib-loader le charge inconditionnellement (parité bundle).
// Un faux positif de scan coûte quelques centaines d'octets ; un module raté = style manquant
// visible au front → le rapport ci-dessous liste inclus/exclus pour audit à chaque régénération.
const swiperPkgDir = dirname(require.resolve('swiper/package.json'));
const themeSrcFiles = (function walk(d) {
    const out = [];
    for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) {
            if (!['node_modules', 'vendor', '.git', 'dist', '_libs'].includes(e.name)) out.push(...walk(join(d, e.name)));
        } else if (/\.(js|php)$/.test(e.name) && !e.name.endsWith('.min.js') && e.name !== 'lib-loader.js') {
            out.push(join(d, e.name));
        }
    }
    return out;
})(PATHS.themePath);
const themeCorpus = themeSrcFiles.map(f => readFileSync(f, 'utf8')).join('\n');

const libLoaderPath = themeSrcFiles.length && join(PATHS.themePath, 'sources', 'js', 'modules', 'lib-loader.js');
const libLoaderSrc = readFileSync(libLoaderPath, 'utf8');
const paramModules = (libLoaderSrc.match(/SWIPER_PARAM_MODULES\s*=\s*\[([^\]]+)\]/) || [, ''])[1]
    .match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) ?? [];
if (!paramModules.length) throw new Error('SWIPER_PARAM_MODULES introuvable dans lib-loader.js — scan CSS impossible');

const usedParams = paramModules.filter(p => p === 'a11y'
    || new RegExp(`[^\\w.$-]${p}['"]?\\s*[:=]`).test(themeCorpus));
const effectNames = moduleExports.filter(n => n.startsWith('Effect')).map(n => kebab(n).replace(/^effect-/, ''));
const usedEffects = effectNames.filter(e => new RegExp(`['"]${e}['"]`).test(themeCorpus));

const cssParts = [require.resolve('swiper/package.json').replace(/package\.json$/, 'swiper.css')];
for (const p of usedParams) {
    const f = join(swiperPkgDir, 'modules', `${kebab(p)}.css`);
    if (existsSync(f) && statSync(f).size > 0) cssParts.push(f);
}
for (const e of usedEffects) {
    const f = join(swiperPkgDir, 'modules', `effect-${e}.css`);
    if (existsSync(f) && statSync(f).size > 0) cssParts.push(f);
}
const excluded = [...paramModules.filter(p => !usedParams.includes(p)), ...effectNames.filter(e => !usedEffects.includes(e)).map(e => 'effect-' + e)];

const cssDst = join(cssOut, '_swiper.css');
const cssHeader = (readFileSync(cssParts[0], 'utf8').match(/^\/\*[\s\S]*?\*\//) || [''])[0];
await build({
    stdin: { contents: cssParts.map(f => readFileSync(f, 'utf8')).join('\n'), resolveDir: swiperPkgDir, loader: 'css', sourcefile: '_swiper.entry.css' },
    minify: true,
    target: TARGET,
    banner: { css: cssHeader + `\n/* CSS à la carte (cf. en-tête build-swiper-libs.mjs) — modules : ${[...usedParams, ...usedEffects.map(e => 'effect-' + e)].join(', ')} */` },
    outfile: cssDst,
    allowOverwrite: true,
    logLevel: 'warning',
});

// ─── Rapport ───
console.log(`\nSwiper ${VERSION} → ${outDir}`);
written.sort().forEach(f => console.log(`  ${before.has(f) ? '↻' : '＋'} ${f.padEnd(26)} ${kb(join(outDir, f))}`));
const orphans = [...before].filter(f => !written.includes(f));
if (orphans.length) console.log(`  ⚠ orphelins (plus émis par cette version, à supprimer ?) : ${orphans.join(', ')}`);
console.log(`  ↻ ${cssDst} ${kb(cssDst)}`);
console.log(`  CSS inclus : core + ${[...usedParams, ...usedEffects.map(e => 'effect-' + e)].join(', ')}`);
console.log(`  CSS exclus (aucun usage détecté dans le thème) : ${excluded.join(', ')}`);
console.log(`\nPenser à : npm run build (propagation dist/) + vérifier les commentaires de version (lib-loader.js, style.scss).`);
