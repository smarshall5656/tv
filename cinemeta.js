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
  return [...movies, ...series];
}

async function meta(type, id) {
  const data = await getJson(`${BASE}/meta/${type}/${id}.json`);
  return data.meta;
}

  return { homeCatalogs, search, meta };
})();
