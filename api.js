// iPad version of the desktop app's main process (src/main.js): the same `api` calls the screens use,
// with streams coming only from a Torrentio link set up for TorBox. Torrentio's links play in VLC on
// the iPad; TorBox's own API can't be called from a web page, so this version never talks to it.
/* global Cinemeta, Scoring */

// Tiny localStorage store with the desktop Store's get/set shape. Private browsing can block
// storage; the page still works then, it just asks for the Torrentio link again after a reload.
function makeStore(name, defaults) {
  const keyName = `tbs.${name}`;
  let data = { ...defaults };
  try {
    data = { ...defaults, ...JSON.parse(localStorage.getItem(keyName) || '{}') };
  } catch {
    // unreadable or blocked: keep defaults
  }
  return {
    get: (key) => (key ? data[key] : data),
    set(patch) {
      data = { ...data, ...patch };
      try { localStorage.setItem(keyName, JSON.stringify(data)); } catch { /* storage unavailable */ }
      return data;
    },
  };
}

const settings = makeStore('settings', { torrentio: '' });
const state = makeStore('state', { taste: {}, likes: {}, watched: {} });

// "https://torrentio.strem.fun/torbox=…/manifest.json" (or stremio://…, or …/configure) → its base URL.
const TORRENTIO = /^(?:https|stremio):\/\/torrentio\.strem\.fun\/(.*?)\/?(?:manifest\.json|configure)?\/?$/i;
function torrentioBase(link) {
  const m = String(link || '').trim().match(TORRENTIO);
  return m && /torbox=/i.test(m[1]) ? `https://torrentio.strem.fun/${m[1]}` : null;
}

// Mask the TorBox key inside the link wherever it's shown back.
const maskLink = (link) => String(link || '').replace(/(torbox=)([^|/]+)/i, (_m, p, key) => `${p}••••${key.slice(-4)}`);

function quality(text) {
  const t = text.toLowerCase();
  if (/2160p|\b4k\b|uhd/.test(t)) return '4K';
  if (/1080p/.test(t)) return '1080p';
  if (/720p/.test(t)) return '720p';
  if (/480p|\bsd\b/.test(t)) return '480p';
  return '';
}

function sizeOf(text) {
  const m = text.match(/💾\s*([\d.]+)\s*(GB|MB)/i);
  if (!m) return { size: '', bytes: 0 };
  const bytes = Number(m[1]) * (m[2].toUpperCase() === 'GB' ? 1024 ** 3 : 1024 ** 2);
  return { size: `${m[1]} ${m[2].toUpperCase()}`, bytes };
}

// How likely VLC on an iPad plays it smoothly: small MP4/x264 files best, big HEVC/HDR remuxes worst.
function iPadFriendly(name, bytes) {
  const n = name.toLowerCase();
  let score = 0;
  if (/\.mp4$|\bmp4\b/.test(n)) score += 2;
  if (/x264|h\.?264|avc/.test(n)) score += 2;
  if (/x265|h\.?265|hevc|10.?bit/.test(n)) score -= 1;
  if (/\bhdr|dolby.?vision|\bdv\b|remux/.test(n)) score -= 2;
  if (bytes && bytes > 20 * 1024 ** 3) score -= 2;
  return score;
}

async function listStreams(type, id) {
  const base = torrentioBase(settings.get('torrentio'));
  if (!base) return { streams: [], errors: [], hasSources: false };
  const res = await fetch(`${base}/stream/${type}/${encodeURIComponent(id)}.json`).catch(() => null);
  if (!res || !res.ok) return { streams: [], errors: [`Torrentio didn’t respond${res ? ` (${res.status})` : ''}. Check your internet connection and try again.`], hasSources: true };
  const body = await res.json();
  // Problems (a wrong key, an expired plan) come back as one placeholder stream that links to a video
  // of the message, rather than as an error.
  const notices = (body.streams || []).filter((s) => /\/videos\//.test(s.url || ''));
  if (notices.length && notices.length === (body.streams || []).length) {
    const why = String(notices[0].title || '').split('\n')[0];
    return { streams: [], errors: [`Torrentio says: ${why} Ask for a new Torrentio link.`], hasSources: true };
  }
  const streams = (body.streams || []).filter((s) => s.url && !/\/videos\//.test(s.url)).map((s) => {
    const lines = String(s.title || '').split('\n');
    const fileName = lines[0] || '';
    const { size, bytes } = sizeOf(s.title || '');
    const seeders = (String(s.title || '').match(/👤\s*(\d+)/) || [])[1];
    return {
      // Torrentio starts the name with [TB+] when the file is already on TorBox, [TB download] when not.
      cached: /^\[TB\+\]/.test(s.name || ''),
      quality: quality(`${s.name} ${fileName}`),
      title: fileName,
      source: (lines.find((l) => l.includes('⚙️')) || '').replace(/.*⚙️\s*/, '') || 'Torrentio',
      size,
      sizeBytes: bytes,
      seeders: seeders ? Number(seeders) : null,
      friendly: iPadFriendly(`${fileName} ${s.behaviorHints?.filename || ''}`, bytes),
      url: s.url,
    };
  });
  const rank = { '1080p': 4, '720p': 3, '4K': 2, '480p': 1, '': 0 };
  streams.sort((a, b) => b.cached - a.cached || b.friendly - a.friendly || rank[b.quality] - rank[a.quality] || (b.seeders || 0) - (a.seeders || 0));
  return { streams, errors: [], hasSources: true };
}

// eslint-disable-next-line no-unused-vars
const api = {
  getSettings: async () => ({ torrentio: maskLink(settings.get('torrentio')), hasTorrentio: Boolean(torrentioBase(settings.get('torrentio'))) }),
  async setTorrentio(link) {
    if (!torrentioBase(link)) throw new Error('That isn’t a Torrentio link set up for TorBox. It should start with https://torrentio.strem.fun/torbox=');
    settings.set({ torrentio: link.trim() });
    return maskLink(link);
  },
  // Confirms the link answers, using a well-known title.
  async testTorrentio() {
    const { streams, errors } = await listStreams('movie', 'tt0111161');
    if (errors.length) throw new Error(errors[0]);
    return { total: streams.length, ready: streams.filter((s) => s.cached).length };
  },

  async getHome() {
    const catalogs = await Cinemeta.homeCatalogs();
    const home = Scoring.buildHome(catalogs, state.get('taste'));
    const recent = Object.values(state.get('watched'))
      .sort((a, b) => b.at - a.at)
      .slice(0, 20)
      .map((w) => ({ ...w.item, videoId: w.videoId, videoName: w.videoName }));
    if (recent.length) home.rows.unshift({ id: 'continue', title: 'Recently Watched', items: recent });
    return home;
  },
  search: (q) => Cinemeta.search(q),
  getMeta: (type, id) => Cinemeta.meta(type, id),
  listStreams,

  // Remembers what was sent to VLC so it shows under Recently Watched.
  async markWatched(item, videoId, videoName) {
    const watched = { ...state.get('watched'), [item.id]: { item, videoId, videoName, at: Date.now() } };
    state.set({ watched });
  },

  async tasteEvent(item, kind) {
    const delta = { play: 1, like: 2, dislike: -2 }[kind];
    if (!delta) return;
    const taste = Scoring.updateTaste(state.get('taste'), item, delta);
    const likes = { ...state.get('likes') };
    if (kind === 'like') likes[item.id] = 1;
    if (kind === 'dislike') likes[item.id] = -1;
    state.set({ taste, likes });
    return likes[item.id] || 0;
  },
  resetTaste: async () => state.set({ taste: {}, likes: {} }) && true,
  getLike: async (id) => state.get('likes')[id] || 0,
};
