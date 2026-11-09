// Browser copy of the desktop app's src/lib/search-rank.js.
const SearchRank = (() => {
// Ranks search results so popular titles come first.
// Cinemeta's search returns movies and series in separate lists ordered only by text relevance,
// so a hit show like "The Office" could sit below a dozen obscure movies.

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

// How well a title matches the query: 3 exact, 2 starts with it, 1.5 all words present,
// 1 found inside a word (office -> officer), 0 no match in the title (e.g. matched an alias).
function matchScore(name, query) {
  const n = normalize(name);
  const q = normalize(query);
  if (!q) return 0;
  if (n === q) return 3;
  if (n.startsWith(q + ' ')) return 2;
  const words = new Set(n.split(' '));
  if (q.split(' ').every((w) => words.has(w))) return 1.5;
  if (n.includes(q)) return 1;
  return 0;
}

// Popularity on a log scale: TMDB popularity (what's being watched now) plus Trakt watchers
// (lasting audience). Missing data counts as 0.
function popularityScore(item) {
  const p = item.popularities || {};
  const mdb = Number(p.moviedb) || 0;
  const trakt = Number(p.trakt) || 0;
  return Math.log1p(mdb) + 0.5 * Math.log1p(trakt);
}

function rankResults(items, query) {
  return items
    .map((item, i) => ({ item, i, score: popularityScore(item) + matchScore(item.name, query) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.item);
}

  return { rankResults, matchScore, popularityScore };
})();
