// Browser copy of the desktop app's src/lib/scoring.js.
const Scoring = (() => {
// Featured scoring engine: ranks Cinemeta catalog items into a hero banner and home rows.
// Pure functions only, so it is easy to test (see test/scoring.test.js).

const WEIGHTS = { popularity: 0.35, quality: 0.3, freshness: 0.15, taste: 0.2 };
const LIST_BONUS = 0.08; // per extra list a title appears on
const FRESH_YEARS = 3;

function yearOf(item) {
  if (item.released) {
    const y = new Date(item.released).getUTCFullYear();
    if (!Number.isNaN(y)) return y;
  }
  const m = String(item.year || item.releaseInfo || '').match(/\d{4}/);
  return m ? Number(m[0]) : null;
}

function genresOf(item) {
  return item.genres || item.genre || [];
}

// Merge every catalog list into one pool keyed by id, remembering which lists each title is on.
function buildPool(catalogs) {
  const pool = new Map();
  for (const [type, lists] of Object.entries(catalogs)) {
    for (const [listId, items] of Object.entries(lists)) {
      (items || []).forEach((item, rank) => {
        if (!item || !item.id) return;
        let entry = pool.get(item.id);
        if (!entry) {
          entry = { ...item, type: item.type || type, lists: new Set(), ranks: {} };
          pool.set(item.id, entry);
        }
        entry.lists.add(listId);
        entry.ranks[listId] = rank;
      });
    }
  }
  return [...pool.values()];
}

function rawPopularity(item) {
  const p = item.popularities || {};
  return {
    moviedb: Math.log1p(Number(p.moviedb) || 0),
    trakt: Math.log1p(Number(p.trakt) || 0),
  };
}

function tasteMatch(item, taste) {
  const genres = taste && taste.genres ? taste.genres : {};
  const values = Object.values(genres).filter((v) => v > 0);
  if (!values.length) return null;
  const max = Math.max(...values);
  const g = genresOf(item);
  if (!g.length) return 0;
  const sum = g.reduce((acc, name) => acc + (genres[name] || 0), 0);
  return Math.max(-1, Math.min(1, sum / (max * Math.min(g.length, 2))));
}

function scoreAll(pool, taste = {}, now = new Date()) {
  const raws = pool.map(rawPopularity);
  const maxMdb = Math.max(1e-9, ...raws.map((r) => r.moviedb));
  const maxTrakt = Math.max(1e-9, ...raws.map((r) => r.trakt));
  const nowYear = now.getUTCFullYear();
  const disliked = new Set((taste && taste.disliked) || []);
  const hasTaste = pool.length > 0 && tasteMatch(pool[0], taste) !== null;

  return pool.map((item, i) => {
    const popularity = 0.6 * (raws[i].moviedb / maxMdb) + 0.4 * (raws[i].trakt / maxTrakt);
    const rating = Number(item.imdbRating);
    const quality = rating ? Math.max(0, Math.min(1, (rating - 5) / 4)) : 0.3;
    const year = yearOf(item);
    const age = year ? nowYear - year : 99;
    const freshness = Math.max(0, 1 - age / FRESH_YEARS);
    const taste01 = hasTaste ? tasteMatch(item, taste) : 0;

    const w = hasTaste ? WEIGHTS : { ...WEIGHTS, taste: 0 };
    const total = w.popularity + w.quality + w.freshness + w.taste;
    let score =
      (w.popularity * popularity + w.quality * quality + w.freshness * freshness + w.taste * taste01) / total;
    score += LIST_BONUS * Math.max(0, item.lists.size - 1);
    if (disliked.has(item.id)) score -= 1;

    const reasons = [];
    if (item.lists.has('top') && popularity > 0.6) reasons.push('Trending');
    if (rating >= 7.5) reasons.push(`${rating.toFixed(1)} IMDb`);
    if (year && age <= 1) reasons.push(`New in ${year}`);
    if (hasTaste && taste01 > 0.4) {
      const top = genresOf(item).find((g) => (taste.genres[g] || 0) > 0);
      if (top) reasons.push(`Matches ${top}`);
    }
    if (item.lists.size >= 3) reasons.push(`On ${item.lists.size} lists`);

    return { ...item, lists: [...item.lists], year, score, popularity, quality, freshness, taste: taste01, reasons };
  });
}

// Take up to n items in score order while capping how many share a primary genre.
function pickDiverse(sorted, n, exclude = new Set()) {
  const cap = Math.max(2, Math.ceil(n / 3));
  const counts = {};
  const out = [];
  const skipped = [];
  for (const item of sorted) {
    if (out.length >= n) break;
    if (exclude.has(item.id)) continue;
    const g = genresOf(item)[0] || 'Other';
    if ((counts[g] || 0) >= cap) {
      skipped.push(item);
      continue;
    }
    counts[g] = (counts[g] || 0) + 1;
    out.push(item);
  }
  for (const item of skipped) {
    if (out.length >= n) break;
    out.push(item);
  }
  return out;
}

function byScore(a, b) {
  return b.score - a.score;
}

function similarTo(seed, scored, n) {
  const seedGenres = new Set(genresOf(seed));
  return scored
    .filter((i) => i.id !== seed.id && i.score > -0.5)
    .map((i) => {
      const overlap = genresOf(i).filter((g) => seedGenres.has(g)).length;
      return { item: i, sim: overlap / Math.max(1, seedGenres.size) + (i.type === seed.type ? 0.2 : 0) + 0.3 * i.score };
    })
    .filter((x) => x.sim > 0.5)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, n)
    .map((x) => x.item);
}

/**
 * Build the home screen layout.
 * @param catalogs {movie:{top,year,imdbRating}, series:{...}} arrays of Cinemeta metas
 * @param taste {genres:{name:weight}, disliked:[id], history:[{id,name,type,genres}]}
 */
function buildHome(catalogs, taste = {}, now = new Date(), rowSize = 20) {
  const scored = scoreAll(buildPool(catalogs), taste, now).sort(byScore);
  const usable = scored.filter((i) => i.score > -0.5);

  const heroPool = usable.filter((i) => i.background && i.description);
  const hero = pickDiverse(heroPool, 5);
  // Make sure the hero mixes movies and shows when possible.
  if (hero.length && hero.every((h) => h.type === hero[0].type)) {
    const other = heroPool.find((i) => i.type !== hero[0].type);
    if (other) hero[hero.length - 1] = other;
  }
  const heroIds = new Set(hero.map((h) => h.id));

  const rows = [];
  rows.push({ id: 'picks', title: 'Top Picks for You', items: pickDiverse(usable, rowSize, heroIds) });

  const history = (taste.history || []).slice(-3).reverse();
  for (const seed of history.slice(0, 1)) {
    const items = similarTo(seed, usable, rowSize);
    if (items.length >= 4) rows.push({ id: `because-${seed.id}`, title: `Because you watched ${seed.name}`, items });
  }

  const listRow = (id, title, type, list, sorter = byScore) => {
    const items = usable.filter((i) => i.type === type && i.lists.includes(list)).sort(sorter).slice(0, rowSize);
    if (items.length) rows.push({ id, title, items });
  };
  const byRank = (list) => (a, b) => (a.ranks[list] ?? 999) - (b.ranks[list] ?? 999);

  listRow('trending-movies', 'Trending Movies', 'movie', 'top', byRank('top'));
  listRow('trending-shows', 'Trending Shows', 'series', 'top', byRank('top'));

  const fresh = usable.filter((i) => i.lists.includes('year')).sort(byScore).slice(0, rowSize);
  if (fresh.length) rows.push({ id: 'new', title: 'New Releases', items: fresh });

  const acclaimed = usable
    .filter((i) => i.lists.includes('imdbRating'))
    .sort((a, b) => (Number(b.imdbRating) || 0) - (Number(a.imdbRating) || 0))
    .slice(0, rowSize);
  if (acclaimed.length) rows.push({ id: 'acclaimed', title: 'Critically Acclaimed', items: acclaimed });

  return { hero, rows };
}

// Learn from what the user does. delta: play +1, like +2, dislike -2.
function updateTaste(taste, item, delta) {
  const next = {
    genres: { ...(taste.genres || {}) },
    disliked: [...(taste.disliked || [])],
    history: [...(taste.history || [])],
  };
  for (const g of genresOf(item)) next.genres[g] = (next.genres[g] || 0) + delta;
  if (delta < 0 && !next.disliked.includes(item.id)) next.disliked.push(item.id);
  if (delta > 0) next.disliked = next.disliked.filter((id) => id !== item.id);
  if (delta === 1) {
    next.history = next.history.filter((h) => h.id !== item.id);
    next.history.push({ id: item.id, name: item.name, type: item.type, genres: genresOf(item) });
    next.history = next.history.slice(-50);
  }
  return next;
}

  return { buildPool, scoreAll, pickDiverse, buildHome, updateTaste, yearOf };
})();
