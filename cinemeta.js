// Browser copy of the desktop app's src/lib/cinemeta.js.
const Cinemeta = (() => {
// Client for Stremio's official Cinemeta add-on (catalogs, search, title details).
const BASE = 'https://v3-cinemeta.strem.io';
const TTL_MS = 30 * 60 * 1000;
const cache = new Map();

async function getJson(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Cinemeta ${res.status} for ${url}`);
  const value = await res.json();
  cache.set(url, { at: Date.now(), value });
  return value;
}

async function catalog(type, list, extra = '') {
  const data = await getJson(`${BASE}/catalog/${type}/${list}${extra ? `/${extra}` : ''}.json`);
  return data.metas || [];
}

// Fetch Popular (top), New (year) and Featured (imdbRating) for movies and series.
async function homeCatalogs() {
  const types = ['movie', 'series'];
  const lists = ['top', 'year', 'imdbRating'];
  const out = { movie: {}, series: {} };
  await Promise.all(
    types.flatMap((type) =>
      lists.map(async (list) => {
        try {
          out[type][list] = await catalog(type, list);
        } catch (err) {
          console.warn(err.message);
          out[type][list] = [];
        }
      })
    )
  );
  return out;
}

async function search(query) {
  const q = encodeURIComponent(query.trim());
  const [movies, series] = await Promise.all([
    catalog('movie', 'top', `search=${q}`).catch(() => []),
    catalog('series', 'top', `search=${q}`).catch(() => []),
  ]);
  const results = [...movies, ...series];
  // Search hits carry no popularity numbers, so read them from each title's details (cached).
  const metas = await mapLimit(results, 16, (r) => withTimeout(meta(r.type, r.id), 3000).catch(() => null));
  const enriched = results.map((r, i) => {
    const m = metas[i];
    if (!m) return r;
    return { ...r, popularities: m.popularities, popularity: m.popularity, imdbRating: m.imdbRating ?? r.imdbRating };
  });
  return SearchRank.rankResults(enriched, query);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(t));
}

async function meta(type, id) {
  const data = await getJson(`${BASE}/meta/${type}/${id}.json`);
  return data.meta;
}

  return { homeCatalogs, search, meta };
})();
