// Music & Audiobooks: the library tab, album pages and the player bar.
// The same file runs in the desktop app and on the iPad page; only `api` differs underneath
// (desktop asks TorBox directly, the iPad goes through the relay link set in Settings).
/* global h, view, api, toast, renderId, stale, backButton, restoreScreen */

const Listen = (() => {
  // ---------- small storage helpers (per device) ----------
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(`tbs.${k}`)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(`tbs.${k}`, JSON.stringify(v)); } catch { /* storage blocked */ } };
  // album key -> artwork URL, or "miss:<time>". Versioned key: covers saved by older, looser matching are dropped.
  const covers = load('covers2', {});
  const progress = load('listen', {}); // album key -> { track, pos, at }
  const kinds = load('audioKind', {}); // album key -> 'music' | 'audiobook' (user's own choice)

  const SVG = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  const IC = {
    play: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 4.5v15l13-7.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
    prev: SVG('<path d="M19 20 9 12l10-8zM5 19V5"/>'),
    next: SVG('<path d="m5 4 10 8-10 8zM19 5v14"/>'),
    back30: SVG('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui" font-weight="700">30</text>'),
    fwd30: SVG('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui" font-weight="700">30</text>'),
    close: SVG('<path d="M6 6l12 12M18 6 6 18"/>'),
    refresh: SVG('<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>'),
    shuffle: SVG('<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>'),
    queue: SVG('<path d="M3 6h13M3 12h13M3 18h8"/><path fill="currentColor" stroke="none" d="M16 15.5v6l5-3z"/>'),
    plus: SVG('<path d="M12 5v14M5 12h14"/>'),
    remove: SVG('<path d="M7 7l10 10M17 7 7 17"/>'),
  };

  const kindOf = (item) => kinds[item.key] || item.kind;
  const fmt = (s) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    s = Math.floor(s);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  };
  const initials = (t) => String(t || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

  // ---------- library ----------
  let libCache = null; // { at, data }
  async function getLibrary(force = false) {
    if (!force && libCache && Date.now() - libCache.at < 60000) return libCache.data;
    const data = await api.getAudioLibrary();
    // "Not set up yet" isn't worth remembering: the next visit after Settings should see the library.
    libCache = data.needsKey || data.needsRelay ? null : { at: Date.now(), data };
    return data;
  }

  // ---------- covers (Apple's free iTunes search; works from the iPad page too) ----------
  const coverQueue = [];
  let coverBusy = 0;
  // A miss is stored as "miss:<time>" and tried again a day later (catalogs change, lookups improve).
  const MISS_RETRY_MS = 24 * 3600 * 1000;
  const coverKey = (item) => `${item.key}|${item.artist}|${item.title}`; // a renamed item gets looked up again
  function coverFor(item, img) {
    const known = covers[coverKey(item)];
    if (known && !known.startsWith('miss:')) { img.src = known; return; }
    if (known && Date.now() - Number(known.slice(5)) < MISS_RETRY_MS) return;
    coverQueue.push([item, img]);
    pumpCovers();
  }
  function pumpCovers() {
    while (coverBusy < 3 && coverQueue.length) {
      const [item, img] = coverQueue.shift();
      coverBusy++;
      lookupCover(item)
        .then((url) => { covers[coverKey(item)] = url || `miss:${Date.now()}`; save('covers2', covers); if (url) img.src = url; })
        .catch(() => {})
        .finally(() => { coverBusy--; pumpCovers(); });
    }
  }
  async function itunes(params) {
    const res = await fetch(`https://itunes.apple.com/search?limit=10&${new URLSearchParams(params)}`);
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()).results || [];
  }
  // Apple always returns *something*; only take a cover whose album title really matches ours, and
  // with a known artist the artist must match too (avoids cover versions and tribute albums).
  const matches = (item) => (r) => sameTitle(item.title, r.collectionName) && (!item.artist || sameTitle(item.artist, r.artistName));
  const big = (r) => (r && r.artworkUrl100 ? r.artworkUrl100.replace('100x100bb', '600x600bb') : '');
  async function lookupCover(item) {
    const book = kindOf(item) === 'audiobook';
    const term = `${item.artist} ${item.title}`.replace(/\b(unabridged|abridged|audiobook)\b/gi, '').trim();
    if (book) return big((await itunes({ media: 'audiobook', entity: 'audiobook', term })).find(matches(item)));
    const album = (await itunes({ media: 'music', entity: 'album', term })).find(matches(item));
    if (album) return big(album);
    // Some albums never come up in Apple's album search (Frank Ocean's "Blonde"), but their songs do,
    // each carrying its album's name and cover. Try a couple of this album's own tracks.
    for (const t of item.tracks.slice(0, 2)) {
      const song = (await itunes({ media: 'music', entity: 'song', term: `${item.artist} ${t.title}`.trim() })).find(matches(item));
      if (song) return big(song);
    }
    return '';
  }
  const words = (s) => String(s || '').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').match(/[a-z0-9]+/g) || [];
  function sameTitle(ours, theirs) {
    const a = words(ours).filter((w) => !['the', 'a', 'an', 'of', 'and'].includes(w));
    const b = new Set(words(theirs));
    if (!a.length) return false;
    return a.filter((w) => b.has(w)).length / a.length >= 0.75;
  }

  function coverEl(item, cls = 'acover') {
    const img = h('img', { alt: '', loading: 'lazy' });
    img.addEventListener('load', () => img.classList.add('in'));
    const box = h('div', { class: cls }, h('span', { class: 'ainit' }, initials(item.title)), img);
    coverFor(item, img);
    return box;
  }

  // ---------- library page ----------
  let filterText = '';
  async function renderLibrary(tab) {
    const rid = renderId;
    const books = tab === 'books';
    view.replaceChildren(h('div', { class: 'page' }, h('h1', {}, 'Music & Audiobooks'), h('div', { class: 'spinner' })));
    let data;
    try {
      data = await getLibrary();
    } catch (err) {
      if (stale(rid)) return;
      view.replaceChildren(h('div', { class: 'page' }, h('h1', {}, 'Music & Audiobooks'),
        h('p', { class: 'empty' }, `Couldn’t load your library: ${err.message}`),
        h('button', { class: 'btn primary', onclick: () => { libCache = null; renderLibrary(tab); } }, 'Try again')));
      return;
    }
    if (stale(rid)) return;
    if (data.needsKey || data.needsRelay) {
      view.replaceChildren(h('div', { class: 'page' }, h('h1', {}, 'Music & Audiobooks'),
        h('p', { class: 'empty' }, data.needsRelay
          ? 'Paste the music library link you were sent into Settings to see music and audiobooks.'
          : 'Add your TorBox API key in Settings to see the music and audiobooks in your TorBox.'),
        h('a', { class: 'btn primary small', href: '#/settings' }, 'Open settings')));
      return;
    }
    const all = data.items || [];
    const music = all.filter((i) => kindOf(i) === 'music');
    const bookList = all.filter((i) => kindOf(i) === 'audiobook');
    const shown = (books ? bookList : music)
      .filter((i) => !filterText || `${i.title} ${i.artist} ${i.name}`.toLowerCase().includes(filterText.toLowerCase()))
      // Audiobooks you're partway through come first, most recent on top.
      .sort((a, b) => (books ? (progress[b.key]?.at || 0) - (progress[a.key]?.at || 0) : 0));

    const seg = h('div', { class: 'seg', role: 'tablist' },
      h('a', { href: '#/audio', class: books ? '' : 'on', role: 'tab', 'aria-selected': String(!books) }, `Music · ${music.length}`),
      h('a', { href: '#/audio/books', class: books ? 'on' : '', role: 'tab', 'aria-selected': String(books) }, `Audiobooks · ${bookList.length}`));
    const grid = h('div', { class: 'agrid' });
    const fill = () => grid.replaceChildren(...shown.filter((i) => !filterText || `${i.title} ${i.artist} ${i.name}`.toLowerCase().includes(filterText.toLowerCase())).map(card));
    const filter = h('input', {
      class: 'search-box afilter', type: 'search', placeholder: books ? 'Filter audiobooks' : 'Filter music', 'aria-label': 'Filter', value: filterText,
      oninput: () => { filterText = filter.value.trim(); fill(); },
    });
    const refresh = h('button', { class: 'icon-btn', title: 'Refresh', 'aria-label': 'Refresh', html: IC.refresh,
      onclick: () => { libCache = null; renderLibrary(tab); } });
    const empty = !(books ? bookList : music).length
      ? h('div', { class: 'aempty' },
        h('p', {}, books ? 'No audiobooks in your TorBox yet.' : 'No music in your TorBox yet.'),
        h('p', { class: 'note' }, 'Add albums and audiobooks to TorBox with Debrid Vault (debridvault.elfhosted.com, sign in with your TorBox key), or any other way. They show up here by themselves.'))
      : null;
    view.replaceChildren(h('div', { class: 'page' },
      h('h1', {}, 'Music & Audiobooks'),
      continueRow(all),
      downloadingStrip(data.downloading || []),
      h('div', { class: 'atools' }, seg, filter, refresh),
      empty, grid));
    fill();
    restoreScreen();
  }

  // Albums and audiobooks you were partway through, most recent first. A tap picks up where you left off.
  function continueRow(all) {
    const started = all
      .map((item) => ({ item, p: progress[item.key] }))
      .filter(({ item, p }) => p && !p.done && item.tracks[p.track] && (p.track > 0 || p.pos > 15))
      .sort((a, b) => b.p.at - a.p.at)
      .slice(0, 12);
    if (!started.length) return null;
    return h('section', { class: 'acontinue' },
      h('h2', {}, 'Continue listening'),
      h('div', { class: 'acont-row' }, started.map(({ item, p }) => {
        const book = kindOf(item) === 'audiobook';
        const pct = Math.min(1, (p.track + (p.dur ? p.pos / p.dur : 0)) / item.tracks.length);
        const where = book ? `${item.tracks[p.track].title} · ${fmt(p.pos)}` : `Track ${p.track + 1} · ${item.tracks[p.track].title}`;
        return h('button', { class: 'acont', title: `Resume ${item.title}`, onclick: () => playAlbum(item, p.track, p.pos) },
          h('div', { class: 'acard-art' }, coverEl(item),
            h('span', { class: 'acont-play', html: IC.play }),
            h('div', { class: 'bar' }, h('i', { style: `width:${Math.max(3, Math.round(pct * 100))}%` }))),
          h('div', { class: 'name' }, item.title),
          h('div', { class: 'why' }, where));
      })));
  }

  // Music and audiobooks TorBox is still fetching: they have no files to list until it finishes.
  function downloadingStrip(list) {
    if (!list.length) return null;
    return h('section', { class: 'adownloading' },
      h('h2', {}, 'Downloading on TorBox'),
      h('ul', {}, list.map((d) => h('li', {},
        h('span', { class: 'dl-name', title: d.name }, d.title || d.name),
        h('span', { class: 'dl-bar' }, h('i', { style: `width:${Math.round(d.progress * 100)}%` })),
        h('span', { class: 'dl-pct' }, d.progress > 0 ? `${Math.round(d.progress * 100)}%` : 'Starting')))),
      h('p', { class: 'note' }, 'They appear in your library when TorBox finishes. Use refresh to check.'));
  }

  function card(item) {
    const p = progress[item.key];
    const book = kindOf(item) === 'audiobook';
    const pct = book && p ? Math.min(1, (p.track + (p.dur ? p.pos / p.dur : 0)) / item.tracks.length) : 0;
    const sub = item.artist || `${item.tracks.length} ${book ? (item.tracks.length === 1 ? 'part' : 'parts') : (item.tracks.length === 1 ? 'track' : 'tracks')}`;
    return h('a', { class: 'acard', href: `#/album/${encodeURIComponent(item.key)}`, title: item.name },
      h('div', { class: 'acard-art' }, coverEl(item),
        item.ready ? null : h('span', { class: 'badge' }, 'Downloading'),
        pct > 0 ? h('div', { class: 'bar' }, h('i', { style: `width:${Math.round(pct * 100)}%` })) : null),
      h('div', { class: 'name' }, item.title),
      h('div', { class: 'why' }, sub));
  }

  // ---------- album page ----------
  async function renderAlbum(key) {
    const rid = renderId;
    view.replaceChildren(backButton(), h('div', { class: 'page' }, h('div', { class: 'spinner' })));
    let item;
    try {
      item = ((await getLibrary()).items || []).find((i) => i.key === key);
      if (!item) item = ((await getLibrary(true)).items || []).find((i) => i.key === key);
    } catch (err) {
      if (stale(rid)) return;
      view.replaceChildren(backButton(), h('div', { class: 'page' }, h('h1', {}, 'Can’t open this'), h('p', { class: 'empty' }, err.message)));
      return;
    }
    if (stale(rid)) return;
    if (!item) {
      view.replaceChildren(backButton(), h('div', { class: 'page' }, h('h1', {}, 'Not in your TorBox any more'),
        h('p', { class: 'empty' }, 'It may have been removed from TorBox.')));
      return;
    }
    const book = kindOf(item) === 'audiobook';
    const p = progress[item.key];
    const resumeLabel = book && p && (p.track > 0 || p.pos > 30)
      ? `Resume · ${item.tracks[p.track]?.title || `Part ${p.track + 1}`} · ${fmt(p.pos)}` : null;
    const actions = h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => (resumeLabel ? playAlbum(item, p.track, p.pos) : playAlbum(item, 0, 0)) },
        h('span', { html: IC.play, class: 'ico' }), resumeLabel || 'Play'),
      resumeLabel ? h('button', { class: 'btn ghost small', onclick: () => playAlbum(item, 0, 0) }, 'Start over') : null,
      !book && item.tracks.length > 1 ? h('button', { class: 'btn ghost small', onclick: () => playAlbum(item, Math.floor(Math.random() * item.tracks.length), 0, true) },
        h('span', { html: IC.shuffle, class: 'ico' }), 'Shuffle') : null,
      h('button', { class: 'btn ghost small', onclick: () => addToQueue(item, item.tracks.map((_t, i) => i)) },
        h('span', { html: IC.queue, class: 'ico' }), 'Add to queue'),
      h('button', { class: 'btn ghost small', onclick: () => {
        kinds[item.key] = book ? 'music' : 'audiobook';
        save('audioKind', kinds);
        toast(book ? 'Moved to Music.' : 'Moved to Audiobooks.');
        renderAlbum(key);
      } }, book ? 'Move to Music' : 'Move to Audiobooks'));
    const list = h('ol', { class: 'tracks' }, item.tracks.map((t, i) =>
      h('li', {},
        h('button', { class: `track${isCurrent(item, i) ? ' on' : ''}`, 'data-i': i, onclick: () => playAlbum(item, i, book && p && p.track === i ? p.pos : 0) },
          h('span', { class: 'tn' }, String(i + 1)),
          h('span', { class: 'tt' }, t.title),
          h('span', { class: 'tx' }, t.ext.toUpperCase())),
        h('button', { class: 'tq', title: 'Add to queue', 'aria-label': `Add ${t.title} to queue`, html: IC.plus, onclick: () => addToQueue(item, [i]) }))));
    view.replaceChildren(backButton(), h('div', { class: 'page album' },
      h('div', { class: 'album-head' }, coverEl(item, 'acover big'),
        h('div', {},
          h('p', { class: 'kicker' }, book ? 'Audiobook' : 'Album'),
          h('h1', {}, item.title),
          item.artist ? h('p', { class: 'artist' }, item.artist) : null,
          h('p', { class: 'note' }, `${item.tracks.length} ${book ? 'part' : 'track'}${item.tracks.length === 1 ? '' : 's'}${item.ready ? '' : ' · still downloading on TorBox'}`),
          actions)),
      list));
  }

  // ---------- player ----------
  // Everything plays from a queue of { item, i } (an album/audiobook and a track in it). Playing an
  // album fills the queue with the rest of that album; "Add to queue" appends without interrupting.
  const audio = document.createElement('audio');
  audio.preload = 'auto';
  let queue = [];
  let qi = -1;
  let cur = null; // queue[qi]
  let bar = null;
  let ui = {};
  let panel = null; // the queue list, when open
  let lastSave = 0;
  const speeds = [1, 1.25, 1.5, 1.75, 2, 0.75];

  const isCurrent = (item, i) => cur && cur.item.key === item.key && cur.i === i;

  function buildBar() {
    if (bar) return;
    const btn = (cls, label, html, onclick) => h('button', { class: `pbtn ${cls}`, title: label, 'aria-label': label, html, onclick });
    ui.art = h('div', { class: 'lb-art' });
    ui.title = h('div', { class: 'lb-title' });
    ui.sub = h('div', { class: 'lb-sub' });
    ui.play = btn('main', 'Play', IC.play, () => (audio.paused ? audio.play().catch(() => {}) : audio.pause()));
    ui.back = btn('skip', 'Back 30 seconds', IC.back30, () => seekBy(-30));
    ui.fwd = btn('skip', 'Forward 30 seconds', IC.fwd30, () => seekBy(30));
    ui.speed = h('button', { class: 'pbtn speed', title: 'Speed', 'aria-label': 'Playback speed', onclick: cycleSpeed }, '1×');
    ui.queueBtn = h('button', { class: 'pbtn qbtn', title: 'Queue', 'aria-label': 'Show queue', 'aria-expanded': 'false', html: IC.queue, onclick: toggleQueue },
      ui.qcount = h('span', { class: 'qcount' }));
    ui.seek = h('input', { type: 'range', class: 'lb-seek', min: 0, max: 1000, value: 0, 'aria-label': 'Position',
      oninput: () => { if (audio.duration) audio.currentTime = (ui.seek.value / 1000) * audio.duration; } });
    ui.time = h('span', { class: 'lb-time' }, '0:00');
    ui.dur = h('span', { class: 'lb-time' }, '0:00');
    bar = h('div', { class: 'listen-bar', role: 'region', 'aria-label': 'Now playing' },
      h('a', { class: 'lb-info', href: '#', onclick: (e) => { e.preventDefault(); if (cur) location.hash = `#/album/${encodeURIComponent(cur.item.key)}`; } },
        ui.art, h('div', { class: 'lb-text' }, ui.title, ui.sub)),
      h('div', { class: 'lb-center' },
        h('div', { class: 'lb-buttons' }, ui.back, btn('', 'Previous', IC.prev, prev), ui.play, btn('', 'Next', IC.next, next), ui.fwd),
        h('div', { class: 'lb-progress' }, ui.time, ui.seek, ui.dur)),
      h('div', { class: 'lb-right' }, ui.speed, ui.queueBtn, btn('', 'Close player', IC.close, stop)));
    document.body.append(bar);
  }

  // Play an album or audiobook from track i: the queue becomes the rest of it (or all of it, shuffled).
  function playAlbum(item, i, startAt = 0, shuffled = false) {
    if (!item.tracks[i]) return;
    let order = item.tracks.map((_t, k) => k).slice(i);
    if (shuffled) {
      order = item.tracks.map((_t, k) => k).filter((k) => k !== i);
      for (let k = order.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
      order.unshift(i);
    }
    queue = order.map((k) => ({ item, i: k }));
    qi = 0;
    start(startAt);
  }

  function addToQueue(item, indices) {
    const idle = !cur;
    queue.push(...indices.map((i) => ({ item, i })));
    if (idle) { qi = queue.length - indices.length; start(0); }
    toast(indices.length === 1 ? `Added “${item.tracks[indices[0]].title}” to the queue.` : `Added ${indices.length} tracks to the queue.`, 2500);
    refreshQueue();
  }

  async function start(startAt = 0) {
    const entry = queue[qi];
    if (!entry) return;
    const { item, i } = entry;
    buildBar();
    savePos();
    cur = entry;
    const t = item.tracks[i];
    const book = kindOf(item) === 'audiobook';
    bar.classList.toggle('book', book);
    document.body.classList.add('listening');
    ui.title.textContent = t.title;
    ui.sub.textContent = [item.title, item.artist].filter(Boolean).join(' · ');
    ui.art.replaceChildren(coverEl(item, 'acover tiny'));
    ui.seek.value = 0; ui.time.textContent = '0:00'; ui.dur.textContent = '';
    markTracks();
    refreshQueue();
    try {
      const url = await api.audioUrl(item.source, item.id, t.fileId);
      if (cur !== entry) return; // another track was picked meanwhile
      audio.src = url;
      audio.playbackRate = book ? load('listenSpeed', 1) : 1;
      ui.speed.textContent = `${audio.playbackRate}×`;
      if (startAt > 0) audio.addEventListener('loadedmetadata', () => { audio.currentTime = Math.min(startAt, (audio.duration || startAt) - 1); }, { once: true });
      await audio.play();
    } catch (err) {
      if (err && err.name === 'NotAllowedError') return; // autoplay blocked: the play button still works
      toast(item.ready ? `Couldn’t play this: ${err.message || err}` : 'TorBox is still downloading this. Try again in a minute.');
    }
    setMediaSession(item, t);
  }

  function next() {
    if (qi + 1 < queue.length) { qi++; start(0); }
  }
  function prev() {
    if (!cur) return;
    if (audio.currentTime > 5 || qi === 0) { audio.currentTime = 0; return; }
    qi--;
    start(0);
  }
  function jumpTo(k) {
    if (!queue[k]) return;
    qi = k;
    start(0);
  }
  function removeAt(k) {
    if (k === qi || !queue[k]) return;
    queue.splice(k, 1);
    if (k < qi) qi--;
    refreshQueue();
  }
  function clearUpNext() {
    queue = queue.slice(0, qi + 1);
    refreshQueue();
  }
  function seekBy(s) {
    if (audio.duration) audio.currentTime = Math.max(0, Math.min(audio.duration - 1, audio.currentTime + s));
  }
  function cycleSpeed() {
    const nextSpeed = speeds[(speeds.indexOf(audio.playbackRate) + 1) % speeds.length] || 1;
    audio.playbackRate = nextSpeed;
    save('listenSpeed', nextSpeed);
    ui.speed.textContent = `${nextSpeed}×`;
  }
  function stop() {
    savePos();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    cur = null;
    queue = [];
    qi = -1;
    closeQueue();
    document.body.classList.remove('listening');
    if (bar) { bar.remove(); bar = null; ui = {}; }
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  }

  // ---------- queue panel ----------
  function toggleQueue() { if (panel) closeQueue(); else openQueue(); }
  function openQueue() {
    panel = h('div', { class: 'queue-panel', role: 'dialog', 'aria-label': 'Queue' });
    document.body.append(panel);
    if (ui.queueBtn) { ui.queueBtn.classList.add('on'); ui.queueBtn.setAttribute('aria-expanded', 'true'); }
    refreshQueue();
  }
  function closeQueue() {
    if (panel) { panel.remove(); panel = null; }
    if (ui.queueBtn) { ui.queueBtn.classList.remove('on'); ui.queueBtn.setAttribute('aria-expanded', 'false'); }
  }
  function refreshQueue() {
    const upNext = Math.max(0, queue.length - qi - 1);
    if (ui.qcount) ui.qcount.textContent = upNext ? String(upNext) : '';
    if (!panel) return;
    const row = (entry, k) => {
      const t = entry.item.tracks[entry.i];
      return h('li', { class: k === qi ? 'now' : '' },
        h('button', { class: 'q-item', onclick: () => jumpTo(k), title: k === qi ? 'Playing now' : 'Play this now' },
          coverEl(entry.item, 'acover tiny'),
          h('span', { class: 'q-text' }, h('span', { class: 'q-title' }, t.title), h('span', { class: 'q-sub' }, entry.item.title))),
        k === qi ? h('span', { class: 'q-now' }, 'Now') : h('button', { class: 'q-x', title: 'Remove', 'aria-label': `Remove ${t.title}`, html: IC.remove, onclick: () => removeAt(k) }));
    };
    const rest = queue.slice(qi + 1);
    panel.replaceChildren(
      h('div', { class: 'q-head' }, h('h3', {}, 'Queue'),
        rest.length ? h('button', { class: 'btn ghost small', onclick: clearUpNext }, 'Clear up next') : null,
        h('button', { class: 'pbtn', title: 'Close', 'aria-label': 'Close queue', html: IC.close, onclick: closeQueue })),
      cur ? h('p', { class: 'q-label' }, 'Now playing') : null,
      cur ? h('ul', { class: 'q-list' }, row(cur, qi)) : null,
      h('p', { class: 'q-label' }, rest.length ? `Up next · ${rest.length}` : 'Up next'),
      rest.length
        ? h('ul', { class: 'q-list' }, rest.map((e, n) => row(e, qi + 1 + n)))
        : h('p', { class: 'note' }, 'Nothing queued. Use + next to a track, or “Add to queue” on an album.'));
  }

  // Remember where each audiobook (and album) was left, per device.
  function savePos() {
    if (!cur || !audio.src) return;
    progress[cur.item.key] = { track: cur.i, pos: Math.floor(audio.currentTime || 0), dur: Math.floor(audio.duration || 0), at: Date.now() };
    save('listen', progress);
  }

  function markTracks() {
    document.querySelectorAll('.tracks .track').forEach((b) => b.classList.toggle('on', Boolean(cur) && location.hash === `#/album/${encodeURIComponent(cur.item.key)}` && Number(b.dataset.i) === cur.i));
  }

  audio.addEventListener('timeupdate', () => {
    if (!bar) return;
    if (audio.duration) ui.seek.value = Math.round((audio.currentTime / audio.duration) * 1000);
    ui.time.textContent = fmt(audio.currentTime);
    ui.dur.textContent = fmt(audio.duration);
    if (Date.now() - lastSave > 5000) { lastSave = Date.now(); savePos(); }
  });
  audio.addEventListener('play', () => { if (ui.play) { ui.play.innerHTML = IC.pause; ui.play.title = 'Pause'; } });
  audio.addEventListener('pause', () => { if (ui.play) { ui.play.innerHTML = IC.play; ui.play.title = 'Play'; } savePos(); });
  audio.addEventListener('ended', () => {
    if (!cur) return;
    // Finished the last track of an album/book: it leaves Continue listening.
    if (cur.i === cur.item.tracks.length - 1) {
      progress[cur.item.key] = { track: 0, pos: 0, dur: 0, at: Date.now(), done: true };
      save('listen', progress);
    }
    if (qi + 1 < queue.length) { qi++; start(0); }
  });
  audio.addEventListener('error', () => {
    if (!cur || !audio.getAttribute('src')) return;
    toast(cur.item.ready ? 'This track can’t be played here. Try another one.' : 'TorBox is still downloading this. Try again in a minute.');
  });
  // Starting a video pauses the music.
  document.addEventListener('play', (e) => { if (e.target instanceof HTMLVideoElement) audio.pause(); }, true);
  window.addEventListener('pagehide', savePos);
  window.addEventListener('hashchange', markTracks);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel) closeQueue(); });

  // Lock screen / Control Center / media keys.
  function setMediaSession(item, t) {
    if (!('mediaSession' in navigator)) return;
    const art = covers[coverKey(item)];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: item.artist || '', album: item.title,
      artwork: art ? [{ src: art, sizes: '600x600', type: 'image/jpeg' }] : [],
    });
    const on = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* unsupported action */ } };
    on('play', () => audio.play());
    on('pause', () => audio.pause());
    on('previoustrack', prev);
    on('nexttrack', next);
    on('seekbackward', () => seekBy(-30));
    on('seekforward', () => seekBy(30));
    on('seekto', (d) => { if (Number.isFinite(d.seekTime)) audio.currentTime = d.seekTime; });
  }

  return { renderLibrary, renderAlbum, playAlbum, addToQueue, stop, audio, queue: () => queue.map((e) => `${e.item.title} / ${e.item.tracks[e.i].title}`), qi: () => qi };
})();

// eslint-disable-next-line no-unused-vars
const renderAudio = (tab) => Listen.renderLibrary(tab);
// eslint-disable-next-line no-unused-vars
const renderAlbum = (key) => Listen.renderAlbum(key);
