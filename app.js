/* global api */
const view = document.getElementById('view');
const playerEl = document.getElementById('player');
const toastEl = document.getElementById('toast');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let heroTimer = null;
let homeCache = null;
let renderId = 0; // bumps on every navigation so slow loads can't paint over a newer screen
const stale = (id) => id !== renderId;

// ---------- helpers ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>',
  info: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2zm0-8h-2V7h2z"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M7 10v11H3V10zm2 11V10l5-8c1.7 0 2.6 1.3 2.2 3L15.4 9H20a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.6 21z"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M17 14V3h4v11zm-2-11v11l-5 8c-1.7 0-2.6-1.3-2.2-3l.8-4H4a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 5.4 3z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 5l-7 7 7 7"/></svg>',
  fullscreen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  exitFullscreen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14zM5 5h6v2H5v12h12v-6h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/></svg>',
};
const iconEl = (name) => h('span', { html: ICON[name], style: 'display:inline-flex' });

function toast(msg, ms = 4000) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (toastEl.hidden = true), ms);
}

function genres(item) {
  return item.genres || item.genre || [];
}

function facts(item) {
  const out = [];
  if (item.imdbRating) out.push(h('span', { class: 'chip' }, `IMDb ${item.imdbRating}`));
  if (item.releaseInfo || item.year) out.push(h('span', {}, item.releaseInfo || item.year));
  if (item.runtime) out.push(h('span', {}, item.runtime));
  const g = genres(item).slice(0, 3).join(', ');
  if (g) out.push(h('span', {}, g));
  out.push(h('span', {}, item.type === 'series' ? 'Series' : 'Movie'));
  return out;
}

function posterImg(src, alt, cls = 'poster') {
  const img = h('img', { class: `${cls} skeleton`, alt: alt || '', loading: 'lazy', src: src || '' });
  img.addEventListener('load', () => img.classList.remove('skeleton'));
  img.addEventListener('error', () => img.classList.remove('skeleton'));
  return img;
}

function slimItem(item) {
  return {
    id: item.id, type: item.type, name: item.name, poster: item.poster, background: item.background,
    genres: genres(item), imdbRating: item.imdbRating, releaseInfo: item.releaseInfo || item.year,
  };
}

// ---------- router ----------
function route() {
  renderId++;
  clearInterval(heroTimer);
  const [, page, type, id] = location.hash.split('/');
  document.querySelectorAll('.rail a').forEach((a) => a.classList.toggle('active', a.dataset.nav === (page || 'home')));
  view.scrollTop = 0;
  if (page === 'search') return renderSearch();
  if (page === 'settings') return renderSettings();
  if (page === 'title') return renderDetails(type, decodeURIComponent(id));
  return renderHome();
}
window.addEventListener('hashchange', route);

const openTitle = (item, videoId) =>
  (location.hash = `#/title/${item.type}/${encodeURIComponent(item.id)}${videoId ? `?v=${encodeURIComponent(videoId)}` : ''}`);

// ---------- home ----------
async function renderHome() {
  const id = renderId;
  view.replaceChildren(h('div', { class: 'hero skeleton' }));
  let home = homeCache;
  try {
    if (!home) home = homeCache = await api.getHome();
  } catch (err) {
    if (stale(id)) return;
    view.replaceChildren(
      h('div', { class: 'page' }, h('h1', {}, 'Can’t load the catalog'),
        h('p', { class: 'empty' }, `The Stremio catalog didn’t respond (${err.message}). Check your internet connection, then try again.`),
        h('button', { class: 'btn primary', onclick: () => { homeCache = null; renderHome(); } }, 'Try again')));
    return;
  }
  const { hasTorrentio } = await api.getSettings();
  if (stale(id)) return;
  const setup = hasTorrentio ? null : h('div', { class: 'setup' },
    h('p', {}, 'To play anything, paste the Torrentio link you were sent into Settings.'),
    h('a', { class: 'btn primary small', href: '#/settings' }, 'Open settings'));
  view.replaceChildren(setup, renderHero(home.hero), h('div', { class: 'rows' }, home.rows.map(renderRow)));
}

function renderHero(items) {
  if (!items.length) return h('div');
  let index = 0;
  const bgA = h('div', { class: 'hero-bg' });
  const bgB = h('div', { class: 'hero-bg', style: 'opacity:0' });
  const body = h('div', { class: 'hero-body' });
  const reel = h('div', { class: 'hero-reel', role: 'tablist', 'aria-label': 'Featured titles' });
  let front = bgA;

  const show = (i) => {
    index = (i + items.length) % items.length;
    const item = items[index];
    const back = front === bgA ? bgB : bgA;
    back.style.backgroundImage = `url("${item.background.replace('/medium/', '/large/')}")`;
    back.style.opacity = 1;
    front.style.opacity = 0;
    front = back;

    const title = h('h1', { class: 'hero-title' }, item.name);
    const logo = item.logo ? h('img', { class: 'hero-logo', src: item.logo, alt: item.name }) : null;
    if (logo) {
      title.hidden = true;
      logo.addEventListener('error', () => { logo.remove(); title.hidden = false; });
    }
    body.replaceChildren(
      logo, title,
      h('div', { class: 'hero-facts' }, item.reasons.filter((r) => !r.endsWith('IMDb')).map((r) => h('span', { class: 'chip teal' }, r)), facts(item)),
      h('p', { class: 'hero-desc' }, item.description),
      h('div', { class: 'hero-actions' },
        h('button', { class: 'btn primary', onclick: () => openTitle(item, item.type === 'movie' ? 'autoplay' : null) }, iconEl('play'), item.type === 'movie' ? 'Play' : 'Episodes'),
        h('button', { class: 'btn ghost', onclick: () => openTitle(item) }, iconEl('info'), 'Details'))
    );
    [...reel.children].forEach((b, n) => { b.classList.toggle('on', n === index); b.setAttribute('aria-selected', n === index); });
  };

  items.forEach((item, n) =>
    reel.append(h('button', { role: 'tab', 'aria-label': item.name, title: item.name, style: `background-image:url("${item.background}")`, onclick: () => { show(n); restart(); } })));

  const restart = () => {
    clearInterval(heroTimer);
    if (!reducedMotion) heroTimer = setInterval(() => show(index + 1), 9000);
  };
  const hero = h('section', { class: 'hero', onmouseenter: () => clearInterval(heroTimer), onmouseleave: restart }, bgA, bgB, body, reel);
  show(0);
  restart();
  return hero;
}

function renderRow(row) {
  const wide = row.id === 'continue';
  const scroller = h('div', { class: 'scroller' }, row.items.map((item) => renderCard(item, wide)));
  const nudge = (dir) => scroller.scrollBy({ left: dir * scroller.clientWidth * 0.85 });
  return h('section', { class: 'row' },
    h('h2', {}, row.title),
    h('div', { class: 'row-wrap' },
      h('button', { class: 'row-arrow left', 'aria-label': 'Scroll left', onclick: () => nudge(-1) }, '‹'),
      scroller,
      h('button', { class: 'row-arrow right', 'aria-label': 'Scroll right', onclick: () => nudge(1) }, '›')));
}

function renderCard(item, wide = false) {
  const why = item.videoName || (item.reasons && item.reasons[0]) || item.releaseInfo || '';
  const src = wide ? item.background || item.poster : item.poster;
  return h('button', { class: `card${wide ? ' wide' : ''}`, title: (item.reasons || []).join(', ') || item.name, onclick: () => openTitle(item, item.videoId) },
    posterImg(src, item.name),
    item.progress ? h('div', { class: 'bar' }, h('i', { style: `width:${Math.round(item.progress * 100)}%` })) : null,
    h('div', { class: 'name' }, item.name),
    h('div', { class: 'why' }, why));
}

// ---------- search ----------
let searchSeq = 0;
function renderSearch() {
  const results = h('div', { class: 'grid' });
  const status = h('p', { class: 'empty' }, 'Search movies and shows by title.');
  let t;
  const input = h('input', {
    class: 'search-box', type: 'search', placeholder: 'Search movies and shows', 'aria-label': 'Search',
    oninput: () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const q = input.value.trim();
        if (q.length < 2) { results.replaceChildren(); status.textContent = 'Search movies and shows by title.'; return; }
        status.textContent = 'Searching…';
        const mine = ++searchSeq;
        try {
          const items = await api.search(q);
          if (mine !== searchSeq) return; // a newer search started; drop this stale result
          status.textContent = items.length ? '' : `No titles match “${q}”.`;
          results.replaceChildren(...items.map((i) => renderCard(i)));
        } catch (err) {
          if (mine !== searchSeq) return;
          status.textContent = `Search failed: ${err.message}`;
        }
      }, 350);
    },
  });
  view.replaceChildren(h('div', { class: 'page' }, h('h1', {}, 'Search'), input, status, results));
  input.focus();
}

// ---------- details ----------
async function renderDetails(type, rawId) {
  const rid = renderId;
  const [id, query] = rawId.split('?');
  const wanted = new URLSearchParams(query || '').get('v');
  view.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'spinner' })));
  let meta;
  try {
    meta = await api.getMeta(type, id);
  } catch (err) {
    if (stale(rid)) return;
    view.replaceChildren(h('div', { class: 'page' }, h('h1', {}, 'Can’t open this title'), h('p', { class: 'empty' }, err.message)));
    return;
  }
  meta.type = meta.type || type;
  let like = await api.getLike(meta.id);
  if (stale(rid)) return;

  const upBtn = h('button', { class: 'icon-btn', title: 'More like this', 'aria-label': 'More like this', html: ICON.up });
  const downBtn = h('button', { class: 'icon-btn', title: 'Less like this', 'aria-label': 'Less like this', html: ICON.down });
  const paintLike = () => { upBtn.classList.toggle('on', like === 1); downBtn.classList.toggle('on', like === -1); };
  upBtn.onclick = async () => { like = await api.tasteEvent(slimItem(meta), 'like'); paintLike(); homeCache = null; toast('Got it. You’ll see more like this.'); };
  downBtn.onclick = async () => { like = await api.tasteEvent(slimItem(meta), 'dislike'); paintLike(); homeCache = null; toast('Got it. You’ll see less like this.'); };
  paintLike();

  const trailer = (meta.trailerStreams || [])[0];
  const streamsPanel = h('div', { class: 'panel' });
  const info = h('div', {},
    h('h1', {}, meta.name),
    h('div', { class: 'facts' }, facts(meta)),
    h('p', { class: 'desc' }, meta.description),
    meta.cast && meta.cast.length ? h('div', { class: 'cast' }, `Starring ${meta.cast.slice(0, 4).join(', ')}`) : null,
    h('div', { class: 'actions' },
      upBtn, downBtn,
      trailer ? h('button', { class: 'btn ghost small', onclick: () => window.open(`https://www.youtube.com/watch?v=${trailer.ytId}`) }, iconEl('ext'), 'Watch trailer') : null));

  const page = h('div', {},
    meta.background ? h('div', { class: 'details-bg', style: `background-image:url("${meta.background.replace('/medium/', '/large/')}")` }) : null,
    h('div', { class: 'details' }, posterImg(meta.poster, meta.name), info));
  view.replaceChildren(page);

  if (meta.type === 'series') {
    const videos = (meta.videos || []).filter((v) => Number(v.season) > 0);
    const seasons = [...new Set(videos.map((v) => Number(v.season)))].sort((a, b) => a - b);
    const epList = h('div', { class: 'episodes' });
    const wantedVideo = videos.find((v) => v.id === wanted);
    const select = h('select', { 'aria-label': 'Season', onchange: () => paint(Number(select.value)) },
      seasons.map((s) => h('option', { value: s }, `Season ${s}`)));
    const paint = (season, selectId) => {
      const eps = videos.filter((v) => Number(v.season) === season).sort((a, b) => Number(a.episode || a.number) - Number(b.episode || b.number));
      epList.replaceChildren(...eps.map((v) => {
        const epNo = v.episode || v.number;
        const b = h('button', { class: `ep${v.id === selectId ? ' on' : ''}`, onclick: () => {
          epList.querySelectorAll('.ep').forEach((e) => e.classList.remove('on'));
          b.classList.add('on');
          loadStreams(streamsPanel, meta, v.id, `S${season} E${epNo} · ${v.name || v.title || ''}`);
        } },
          posterImg(v.thumbnail, ''),
          h('div', {}, h('b', {}, `${epNo}. ${v.name || v.title || `Episode ${epNo}`}`), h('span', {}, v.overview || v.description || (v.released ? `Aired ${new Date(v.released).toLocaleDateString()}` : ''))));
        return b;
      }));
    };
    const startSeason = wantedVideo ? Number(wantedVideo.season) : seasons[0];
    select.value = startSeason;
    paint(startSeason, wantedVideo && wantedVideo.id);
    info.append(h('div', { class: 'two-col' },
      h('div', { class: 'panel' }, h('div', { class: 'episodes-head' }, h('h3', { style: 'margin:0' }, 'Episodes'), select), epList),
      streamsPanel));
    if (wantedVideo) loadStreams(streamsPanel, meta, wantedVideo.id, `S${wantedVideo.season} E${wantedVideo.episode || wantedVideo.number} · ${wantedVideo.name || ''}`);
    else streamsPanel.replaceChildren(h('h3', {}, 'Streams'), h('p', { class: 'note' }, 'Pick an episode to see its streams.'));
  } else {
    info.append(streamsPanel);
    loadStreams(streamsPanel, meta, meta.id, null, wanted === 'autoplay');
  }
}

async function loadStreams(panel, meta, videoId, videoName, autoplay = false) {
  const heading = h('h3', {}, videoName ? `Streams for ${videoName}` : 'Streams');
  panel.replaceChildren(heading, h('div', { class: 'spinner' }));
  const { streams, errors, hasSources } = await api.listStreams(meta.type, videoId);
  const body = [];
  if (!hasSources) {
    body.push(h('p', { class: 'note' }, 'Paste your Torrentio link in Settings to see streams.'),
      h('a', { class: 'btn primary small', href: '#/settings' }, 'Open settings'));
  } else if (!streams.length && !errors.length) {
    body.push(h('p', { class: 'note' }, 'No streams found for this title.'));
  }
  for (const e of errors) body.push(h('p', { class: 'note err' }, e));

  const ready = streams.filter((s) => s.cached);
  const later = streams.filter((s) => !s.cached);
  const row = (s) => h('button', { class: 'stream', title: s.title, onclick: () => play(meta, videoId, videoName, s, s.cached ? ready : []) },
    h('span', { class: 'q' }, s.quality || 'SD'),
    h('div', { style: 'min-width:0' },
      h('div', { class: 't' }, s.title),
      h('div', { class: 'm' }, [s.source, s.size, s.seeders != null ? `${s.seeders} seeders` : null].filter(Boolean).join('  ·  '))),
    h('span', { class: `state${s.cached ? ' instant' : ''}` }, s.cached ? (s.friendly > 0 ? 'Ready · best for iPad' : 'Ready') : 'Needs download'));
  if (ready.length) {
    body.push(h('p', { class: 'note' }, 'Ready streams are already on TorBox. The ones at the top play best on an iPad.'),
      h('div', { class: 'streams' }, ready.slice(0, 60).map(row)));
  } else if (streams.length) {
    body.push(h('p', { class: 'note' }, 'Nothing for this title is on TorBox yet, so these may not play.'));
  }
  if (later.length) {
    body.push(h('details', { class: 'more' },
      h('summary', {}, `${later.length} more that need downloading first`),
      h('div', { class: 'streams' }, later.slice(0, 40).map(row))));
  }
  panel.replaceChildren(heading, ...body);
  if (autoplay && ready[0]) play(meta, videoId, videoName, ready[0], ready, true);
  else if (autoplay && streams.length) toast('Nothing is ready for this title yet. Pick a stream below.');
}

// ---------- send to VLC ----------
// Play hands the link to VLC (or Infuse) through its x-callback URL. VLC played these links when
// pasted in (Browse → Open Network Stream) but not via vlc://, so Copy link stays as the backup.
const playLinks = {
  vlc: (url) => `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(url)}`,
  infuse: (url) => `infuse://x-callback-url/play?url=${encodeURIComponent(url)}`,
};
// Files Torrentio called ready that turned out to be still downloading on TorBox (this visit only).
const notReadyUrls = new Set();
let playSeq = 0;
// `ready` is the title's list of Ready streams, used to offer (or, when autoplaying, jump to) the next
// one if this file turns out to be still downloading.
function play(meta, videoId, videoName, stream, ready = [], autoplay = false) {
  const mine = ++playSeq;
  const title = videoName ? `${meta.name} · ${videoName}` : meta.name;
  const status = h('p', { class: 'note', role: 'status' });
  const nextReady = () => ready.find((s) => s !== stream && !notReadyUrls.has(s.url));
  const check = h('p', { class: 'note check' }, 'Checking that TorBox has this file ready…');
  api.probeStream(stream.url).then((answer) => {
    if (mine !== playSeq || playerEl.hidden) return; // sheet closed or another stream picked
    if (answer !== 'downloading') { check.remove(); return; }
    notReadyUrls.add(stream.url);
    const next = nextReady();
    if (autoplay && next) {
      toast('That file is still downloading on TorBox. Picked the next ready one.');
      play(meta, videoId, videoName, next, ready, true);
      return;
    }
    check.className = 'note err';
    check.replaceChildren('TorBox is still downloading this file, so VLC would only show a “downloading” message. ',
      next
        ? h('button', { class: 'btn small', onclick: () => play(meta, videoId, videoName, next, ready) }, 'Try the next ready stream')
        : 'Try again in a few minutes, or pick another stream.');
  });
  const linkBox = h('textarea', { class: 'link-box', id: 'stream-link', readonly: true, rows: 2, 'aria-label': 'Stream link' });
  linkBox.value = stream.url;
  const remember = () => {
    api.markWatched(slimItem(meta), videoId, videoName);
    api.tasteEvent(slimItem(meta), 'play');
    homeCache = null;
  };
  const vlcBtn = h('a', { class: 'btn primary big', href: playLinks.vlc(stream.url), onclick: remember }, iconEl('play'), 'Play in VLC');
  const infuseBtn = h('a', { class: 'btn big', href: playLinks.infuse(stream.url), onclick: remember }, 'Play in Infuse');
  const copyBtn = h('button', { class: 'btn small' }, 'Copy link');
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(stream.url);
      status.textContent = 'Copied. Now switch to VLC.';
    } catch {
      linkBox.focus();
      linkBox.select();
      status.textContent = 'Tap Copy in the menu that appears, then switch to VLC.';
    }
    copyBtn.textContent = 'Copied';
    remember();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    playerEl.hidden = true;
    playerEl.replaceChildren();
  };
  document.addEventListener('keydown', onKey);
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title' },
    h('div', { class: 'sheet-head' },
      h('h2', { id: 'sheet-title' }, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', html: ICON.close, onclick: close })),
    h('p', { class: 'sheet-file' }, h('b', {}, [stream.quality, stream.size].filter(Boolean).join(' · ') || 'Stream'), ' ', stream.title),
    check,
    h('div', { class: 'sheet-actions' }, vlcBtn, infuseBtn),
    h('p', { class: 'note' }, 'Not playing after a minute? Come back and pick another Ready stream, ideally an MP4 or x264 one.'),
    h('details', { class: 'more' },
      h('summary', {}, 'Play button not working? Paste the link instead'),
      h('ol', { class: 'steps' },
        h('li', {}, 'Tap ', copyBtn, '.'),
        h('li', {}, 'In VLC, tap ', h('b', {}, 'Browse'), ' in the tabs along the top, then ', h('b', {}, 'Open Network Stream'), '.'),
        h('li', {}, 'Paste the link and tap ', h('b', {}, 'Open Network Stream'), '.')),
      status,
      linkBox));
  playerEl.onclick = (e) => { if (e.target === playerEl) close(); };
  playerEl.replaceChildren(sheet);
  playerEl.hidden = false;
  vlcBtn.focus();
}

// ---------- settings ----------
async function renderSettings() {
  const rid = renderId;
  const s = await api.getSettings();
  if (stale(rid)) return;
  const input = h('input', { id: 'torrentio-link', type: 'url', placeholder: 'https://torrentio.strem.fun/torbox=…/manifest.json', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const note = h('span', { class: 'note' }, s.hasTorrentio ? `Saved: ${s.torrentio}` : 'No link saved yet.');
  const save = async () => {
    note.className = 'note';
    try {
      const masked = await api.setTorrentio(input.value);
      input.value = '';
      note.textContent = `Saved: ${masked}. Checking it…`;
      const r = await api.testTorrentio();
      note.textContent = `Working. ${r.ready} of ${r.total} streams for a test movie are ready on TorBox.`;
      homeCache = null;
    } catch (err) {
      note.textContent = err.message;
      note.className = 'note err';
    }
  };

  view.replaceChildren(h('div', { class: 'page' },
    h('h1', {}, 'Settings'),
    h('div', { class: 'field' },
      h('label', { for: 'torrentio-link' }, 'Torrentio link'),
      h('p', {}, 'Paste the Torrentio link you were sent. It connects this page to TorBox and is kept only in Safari on this iPad.'),
      input,
      h('div', { class: 'inline' }, h('button', { class: 'btn primary small', onclick: save }, 'Save and test'), note)),
    h('div', { class: 'field' },
      h('label', {}, 'Player'),
      h('p', {}, 'Videos play in VLC, a free app.'),
      h('a', { class: 'link', href: 'https://apps.apple.com/app/vlc-media-player/id650377962', target: '_blank', rel: 'noopener' }, 'Get VLC on the App Store')),
    h('div', { class: 'field' },
      h('label', {}, 'Your picks'),
      h('p', {}, 'Featured picks learn from what you watch and rate. Reset to start fresh.'),
      h('button', { class: 'btn small', onclick: async () => { await api.resetTaste(); homeCache = null; toast('Picks reset.'); } }, 'Reset my picks'))));
}

route();
