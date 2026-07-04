'use strict';

const $ = (id) => document.getElementById(id);

// three sound eras: 2004-06 midi, the 2007 soundbank rework, the 2025 remaster
const ERAS = [
  { id: 'original',  label: 'Original',   sub: '2004–2006', max: 2006 },
  { id: 'soundbank', label: 'Soundbank',  sub: '2007–2024', max: 2024 },
  { id: 'remaster',  label: 'Remastered', sub: '2025+',     max: Infinity },
];
const DEFAULT_ERA = 'remaster';   // the current in-game sound

function trackYears(t) {
  if (t.versions && t.versions.length) return t.versions.map(v => v.year).filter(Boolean);
  return t.releaseYear ? [t.releaseYear] : [];
}
const trackEarliest = t => { const y = trackYears(t); return y.length ? Math.min(...y) : null; };
const trackLatest   = t => { const y = trackYears(t); return y.length ? Math.max(...y) : null; };

// era cutoff, narrowed by the year inputs
function activeBounds() {
  const era = ERAS.find(e => e.id === state.era) || ERAS[ERAS.length - 1];
  return { min: state.yearMin || -Infinity,
           max: Math.min(era.max, state.yearMax || Infinity) };
}
// does the track's lifespan overlap the window
function inEra(t) {
  const e = trackEarliest(t); if (e == null) return false;
  const { min, max } = activeBounds();
  return e <= max && trackLatest(t) >= min;
}
// newest version at/under the cutoff
function pickVersion(t) {
  if (state.game !== 'osrs' || !t.versions || t.versions.length < 2) return null;
  const { max } = activeBounds();
  const below = t.versions.filter(v => v.year <= max);
  return below.length ? below[below.length - 1] : t.versions[0];
}
function chosenYear(t) { return pickVersion(t)?.year ?? trackLatest(t) ?? t.releaseYear; }

// which version to store for a fav / playlist entry
function versionYearFor(id) {
  const cur = state.current >= 0 ? state.queue[state.current] : null;
  if (cur && cur.id === id && state.currentVersion) return state.currentVersion.year;
  const t = state.tracks.find(x => x.id === id);
  const v = t ? pickVersion(t) : null;
  return v ? v.year : null;
}

const state = {
  tracks: [],
  filtered: [],
  era: DEFAULT_ERA,
  game: 'osrs',           // 'osrs' (OSRS/RS2 timeline, has years) | 'rs3' (yearless)
  search: '',
  yearMin: null,
  yearMax: null,
  members: 'all',
  sortKey: 'releaseYear',
  sortDir: 'asc',
  favsOnly: false,
  queue: [],              // current playable list (= filtered)
  queueMeta: null,        // per-item version pin (playlists)
  current: -1,            // index into queue
  shuffle: false,
  repeat: 'off',          // off | one | all
  favs: (() => {                       // id -> version year
    const raw = JSON.parse(localStorage.getItem('rsmp_favs') || '[]');
    return Array.isArray(raw) ? new Map(raw.map(id => [id, null]))   // old format
                              : new Map(Object.entries(raw));
  })(),
  playlists: JSON.parse(localStorage.getItem('rsmp_playlists') || '[]'),
};

const audio = $('audio');

// data load
async function load() {
  try {
    const [tracks, meta] = await Promise.all([
      fetch('data/tracks.json').then(r => r.json()),
      fetch('data/meta.json').then(r => r.json()).catch(() => null),
    ]);
    state.tracks = tracks;
    if (meta) {
      $('stats').innerHTML =
        `${meta.total.toLocaleString()} tracks &middot; ${meta.byWiki.osrs} OSRS / ${meta.byWiki.rs3} RS3<br>` +
        `OSRS ${meta.osrsYearRange[0]}–${meta.osrsYearRange[1]} &middot; RS3 via archive.org &middot; updated ${new Date(meta.generated).toLocaleDateString()}`;
    }
    initFromUrl();
    buildGameTabs();
    buildEraTabs();
    updateSortHeaders();
    applyMode();
    apply();
    drawIdle();
    loadCounter();
    // shared ?pl= link: import + load
    const plParam = new URLSearchParams(location.search).get('pl');
    if (plParam) {
      const p = importPlaylist(plParam);
      history.replaceState(null, '', location.pathname);
      if (p) playPlaylist(p, false);
    }
    $('loading').classList.add('hidden');
  } catch (e) {
    $('loading').textContent = 'Failed to load data. Run: node scripts/build-index.mjs';
    console.error(e);
  }
}

// filter + sort
function apply() {
  const osrs = state.game === 'osrs';   // eras are osrs-only
  const q = state.search.toLowerCase();
  let list = state.tracks.filter(t => {
    if (t.wiki !== state.game) return false;          // osrs and rs3 are separate
    if (osrs && !state.favsOnly && !inEra(t)) return false;   // era filter (favs ignore it)
    if (state.members === 'members' && t.members !== true) return false;
    if (state.members === 'free' && t.members !== false) return false;
    if (state.favsOnly && !state.favs.has(t.id)) return false;
    if (q) {
      const hay = (t.title + ' ' + (t.update||'') + ' ' + (t.composer||'') + ' ' + (t.location||'')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const dir = state.sortDir === 'asc' ? 1 : -1;
  const k = state.sortKey;
  if (k === 'random') {
    for (let i = list.length - 1; i > 0; i--) { const j = Math.random()*(i+1)|0; [list[i],list[j]]=[list[j],list[i]]; }
  } else {
    list.sort((a, b) => {
      let av, bv;
      if (k === 'title') { av = a.title.toLowerCase(); bv = b.title.toLowerCase(); }
      else if (k === 'duration') { av = a.lengthSec ?? Infinity; bv = b.lengthSec ?? Infinity; }
      else if (k === 'releaseYear') { av = chosenYear(a) ?? Infinity; bv = chosenYear(b) ?? Infinity; }
      else { av = a[k] ?? Infinity; bv = b[k] ?? Infinity; }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return a.title.localeCompare(b.title);
    });
  }

  state.filtered = list;
  state.queue = list;
  // favs pin their saved version
  state.queueMeta = state.favsOnly ? list.map(t => ({ v: state.favs.get(t.id) ?? null })) : null;
  render();
  syncUrl();
}

// rendering
function render() {
  const c = $('trackList');
  $('resultCount').textContent = `${state.filtered.length.toLocaleString()} track${state.filtered.length===1?'':'s'}`;
  const playingId = state.current >= 0 ? state.queue[state.current]?.id : null;

  if (!state.filtered.length) {
    c.innerHTML = `<div style="padding:20px;text-align:center;color:#6a5a32">No tracks match these filters.</div>`;
    return;
  }
  // fragment, faster for 2k rows
  const frag = document.createDocumentFragment();
  state.filtered.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'track-row' + (t.id === playingId ? ' playing' : '');
    row.dataset.i = i;
    const fav = state.favs.has(t.id) ? 'on' : '';
    const upUrl = updateUrlFor(t);
    const updateHtml = t.update
      ? (upUrl
          ? ` <a class="title-update" href="${upUrl}" target="_blank" rel="noopener" data-noplay title="View the &quot;${esc(t.update)}&quot; update on the wiki">· ${esc(t.update)}</a>`
          : ` <span class="title-update">· ${esc(t.update)}</span>`)
      : '';
    const nVer = t.versions ? t.versions.length : 0;
    const pinned = state.queueMeta && state.queueMeta[i];   // playlist/favs pin a version
    const yearCell = (pinned ? (pinned.v ?? chosenYear(t)) : chosenYear(t)) ?? '—';
    const verBadge = nVer > 1 ? `<span class="ver-badge" title="${nVer} versions">${nVer}×</span>` : '';
    row.innerHTML =
      `<span class="col-fav"><span class="fav-star ${fav}" data-fav="${t.id}" title="Favourite"></span><span class="add-pl ${inAnyPlaylist(t.id) ? 'in' : ''}" data-add="${t.id}" title="${esc(playlistTip(t.id))}">+</span></span>` +
      `<span class="col-num">${i + 1}</span>` +
      `<span class="col-title">${esc(t.title)}${updateHtml}</span>` +
      `<span class="col-year">${yearCell}${verBadge}</span>` +
      `<span class="col-composer">${esc(t.composer || '')}</span>` +
      `<span class="col-dur">${t.duration || '—'}</span>`;
    frag.appendChild(row);
  });
  c.innerHTML = '';
  c.appendChild(frag);
  alignHeader();
}

// pad the header by the scrollbar width so columns line up
function alignHeader() {
  const list = $('trackList');
  const sbw = list.offsetWidth - list.clientWidth;   // scrollbar width
  document.querySelector('.list-head').style.paddingRight = (10 + sbw) + 'px';
}

function esc(s) { return (s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// toggle a fav, keep the stars in sync
function toggleFav(id) {
  if (state.favs.has(id)) state.favs.delete(id);
  else state.favs.set(id, versionYearFor(id));
  localStorage.setItem('rsmp_favs', JSON.stringify(Object.fromEntries(state.favs)));
  const on = state.favs.has(id);
  const cur = state.current >= 0 ? state.queue[state.current] : null;
  if (cur && cur.id === id) $('npFav').classList.toggle('on', on);
  const star = document.querySelector(`.fav-star[data-fav="${CSS.escape(id)}"]`);
  if (star) star.classList.toggle('on', on);
  if (pipEls && cur && cur.id === id) pipEls.fav.classList.toggle('on', on);
  if (state.favsOnly) apply();   // might've left the favs view
}

// playlists
function savePlaylists() { localStorage.setItem('rsmp_playlists', JSON.stringify(state.playlists)); }
function plId() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function createPlaylist(name, author) {
  const p = { id: plId(), name: (name || 'Untitled').trim().slice(0, 60), author: (author || '').trim().slice(0, 40), tracks: [] };
  state.playlists.push(p); savePlaylists(); return p;
}
function deletePlaylist(id) { state.playlists = state.playlists.filter(p => p.id !== id); savePlaylists(); renderPlaylists(); }
function resolvePlaylist(p) {
  return p.tracks.map(e => ({ t: state.tracks.find(x => x.id === e.id), v: e.v })).filter(x => x.t);
}
function playPlaylist(p, autoplay = true) {
  const items = resolvePlaylist(p);
  if (!items.length) return;
  state.filtered = items.map(x => x.t);
  state.queue = state.filtered;
  state.queueMeta = items.map(x => ({ v: x.v }));
  $('listTitle').textContent = 'Playlist: ' + p.name + (p.author ? ' — ' + p.author : '');
  render();
  closePlaylists();
  if (autoplay) playIndex(0);
}

// share string: "SOR1." + base64url(JSON)
function encodePlaylist(p) {
  const data = { n: p.name, a: p.author, t: p.tracks.map(e => [e.id, e.v]) };
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
  return 'SOR1.' + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodePlaylist(str) {
  try {
    let s = (str || '').trim();
    const m = s.match(/SOR1\.([A-Za-z0-9\-_]+)/);
    s = m ? m[1] : s.replace(/^.*[?&]pl=/, '');
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    const d = JSON.parse(decodeURIComponent(escape(atob(s))));
    if (!d || !Array.isArray(d.t)) return null;
    return { id: plId(), name: (d.n || 'Imported playlist').slice(0, 60), author: (d.a || '').slice(0, 40),
             tracks: d.t.map(e => ({ id: e[0], v: e[1] ?? null })).filter(e => e.id) };
  } catch (_) { return null; }
}
function importPlaylist(str) {
  const p = decodePlaylist(str);
  if (!p || !p.tracks.length) return null;
  state.playlists.push(p); savePlaylists(); return p;
}
function copyShare(p, btn) {
  const code = encodePlaylist(p);
  const done = () => { if (btn) { const o = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = o, 1500); } };
  if (navigator.clipboard) navigator.clipboard.writeText(code).then(done).catch(() => prompt('Copy this share code:', code));
  else prompt('Copy this share code:', code);
}

let plOpen = null;   // expanded playlist

function openPlaylists() { renderPlaylists(); $('plModal').hidden = false; }
function closePlaylists() { $('plModal').hidden = true; }

function trackInPlaylists(id) { return state.playlists.filter(p => p.tracks.some(e => e.id === id)); }
function inAnyPlaylist(id) { return state.playlists.some(p => p.tracks.some(e => e.id === id)); }
function playlistTip(id) {
  const names = trackInPlaylists(id).map(p => p.name);
  return names.length ? 'In: ' + names.join(', ') : 'Add to a playlist';
}
function toggleTrackInPlaylist(plid, trackId) {
  const p = state.playlists.find(x => x.id === plid); if (!p) return;
  if (p.tracks.some(e => e.id === trackId)) p.tracks = p.tracks.filter(e => e.id !== trackId);
  else p.tracks.push({ id: trackId, v: versionYearFor(trackId) });
  savePlaylists();
}
function removeTrackAt(plid, idx) { const p = state.playlists.find(x => x.id === plid); if (p) { p.tracks.splice(idx, 1); savePlaylists(); } }
function moveTrack(plid, idx, dir) {
  const p = state.playlists.find(x => x.id === plid); if (!p) return;
  const j = idx + dir; if (j < 0 || j >= p.tracks.length) return;
  [p.tracks[idx], p.tracks[j]] = [p.tracks[j], p.tracks[idx]]; savePlaylists();
}
// refresh one row's + without a full re-render
function updateRowAddState(trackId) {
  const btn = document.querySelector(`.add-pl[data-add="${CSS.escape(trackId)}"]`);
  if (btn) { btn.classList.toggle('in', inAnyPlaylist(trackId)); btn.title = playlistTip(trackId); }
}

function renderPlaylists() {
  const c = $('plList');
  if (!state.playlists.length) { c.innerHTML = '<p class="pl-empty">No playlists yet. Name one above, then add tracks with the + beside each track in the list.</p>'; return; }
  c.innerHTML = state.playlists.map(p => {
    const open = plOpen === p.id;
    let contents = '';
    if (open) {
      const trks = p.tracks.length ? p.tracks.map((e, i) => {
        const t = state.tracks.find(x => x.id === e.id);
        const ver = (t && t.versions && t.versions.length > 1)
          ? `<select class="pl-ver" data-i="${i}" title="Version to play">${t.versions.map(v => `<option value="${v.year}"${v.year === e.v ? ' selected' : ''}>${v.year}</option>`).join('')}</select>`
          : (e.v ? `<span class="pl-ver-static">${e.v}</span>` : '');
        return `<div class="pl-trk">
          <span class="pl-trk-nm">${i + 1}. ${esc(t ? t.title : '(unknown)')}</span>
          ${ver}
          <span class="pl-trk-btns">
            <button class="pl-mini" data-mv="up" data-i="${i}" title="Move up">↑</button>
            <button class="pl-mini" data-mv="down" data-i="${i}" title="Move down">↓</button>
            <button class="pl-mini" data-rm="${i}" title="Remove">✕</button>
          </span></div>`;
      }).join('') : '<div class="pl-empty2">Empty — add tracks with the + in the list.</div>';
      contents = `<div class="pl-tracks">${trks}</div>`;
    }
    return `<div class="pl-item ${open ? 'open' : ''}" data-id="${p.id}">
      <div class="pl-row">
        <div class="pl-info" data-act="toggle">
          <div class="pl-nm">${open ? '▾ ' : '▸ '}${esc(p.name)}</div>
          <div class="pl-sub">${p.tracks.length} track${p.tracks.length === 1 ? '' : 's'}${p.author ? ' · by ' + esc(p.author) : ''}</div>
        </div>
        <div class="pl-actions">
          <button class="rs-btn" data-act="play">Play</button>
          <button class="rs-btn" data-act="share">Copy code</button>
          <button class="rs-btn" data-act="del">Delete</button>
        </div>
      </div>${contents}
    </div>`;
  }).join('');
}

// checklist popup behind the row +
function closeAddMenu() { const m = $('addMenu'); if (m) m.remove(); document.removeEventListener('mousedown', outsideAdd, true); }
function outsideAdd(e) { const m = $('addMenu'); if (m && !m.contains(e.target)) closeAddMenu(); }
function renderAddMenu(menu, trackId) {
  const rows = state.playlists.map(p => {
    const inIt = p.tracks.some(e => e.id === trackId);
    return `<div class="add-item ${inIt ? 'in' : ''}" data-pl="${p.id}"><span class="add-check">${inIt ? '✓' : ''}</span>${esc(p.name)}</div>`;
  }).join('');
  menu.innerHTML = '<div class="add-head">In which playlists?</div>' +
    (rows || '<div class="add-empty">No playlists yet</div>') +
    '<div class="add-item add-new">+ New playlist…</div>';
}
function showAddMenu(x, y, trackId) {
  closeAddMenu();
  const menu = document.createElement('div');
  menu.id = 'addMenu'; menu.className = 'add-menu';
  renderAddMenu(menu, trackId);
  menu.style.left = Math.min(x, window.innerWidth - 210) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 40) + 'px';
  menu.onclick = (e) => {
    const row = e.target.closest('[data-pl]');
    if (row) { toggleTrackInPlaylist(row.dataset.pl, trackId); updateRowAddState(trackId); closeAddMenu(); return; }
    if (e.target.closest('.add-new')) {
      const name = prompt('Playlist name:');
      if (name) { toggleTrackInPlaylist(createPlaylist(name, '').id, trackId); updateRowAddState(trackId); }
      closeAddMenu();
    }
  };
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('mousedown', outsideAdd, true), 0);
}

function updateSortHeaders() {
  document.querySelectorAll('.list-head .sort-col').forEach(col => {
    const active = col.dataset.sort === state.sortKey;
    col.classList.toggle('sorted', active);
    col.dataset.arrow = active ? (state.sortDir === 'asc' ? '▲' : '▼') : '';
  });
}

// playback
function playIndex(i) {
  if (i < 0 || i >= state.queue.length) return;
  state.current = i;
  const t = state.queue[i];
  let v = pickVersion(t);  // era version (null if single)
  const pin = state.queueMeta && state.queueMeta[i];   // playlist pins a version
  if (pin && pin.v && t.versions && t.versions.length) v = t.versions.find(x => x.year === pin.v) || v;
  state.currentVersion = v;
  audio.src = v ? v.audio : t.audio;
  setLoading(true);
  audio.play().catch(()=>{});
  buildVersionSelector(t, v);
  updateNowPlaying(t, v);
  render();
  const row = document.querySelector(`.track-row[data-i="${i}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

// version dropdown, osrs multi-version only
function buildVersionSelector(t, chosen) {
  const sel = $('versionSel'), label = $('verLabel');
  const has = state.game === 'osrs' && t.versions && t.versions.length >= 2;
  sel.hidden = !has; label.hidden = !has;
  if (!has) { sel.innerHTML = ''; return; }
  sel.innerHTML = t.versions
    .map((v, idx) => `<option value="${idx}">${v.year} version</option>`).join('');
  const idx = chosen ? t.versions.indexOf(chosen) : t.versions.length - 1;
  sel.value = String(idx < 0 ? t.versions.length - 1 : idx);
}

function updateUrlFor(t) {
  if (!t.update || !t.page) return null;
  const base = t.page.split('/w/')[0];
  return `${base}/w/Update:${encodeURIComponent(t.update.replace(/ /g, '_'))}`;
}

function updateNowPlaying(t, v) {
  $('npTitle').textContent = t.title;
  $('npFav').classList.toggle('on', state.favs.has(t.id));
  const bits = [];
  const year = v ? v.year : t.releaseYear;
  if (year) bits.push(year);
  if (t.composer) bits.push(esc(t.composer));
  if (t.members != null) bits.push(t.members ? 'Members' : 'F2P');
  const upUrl = updateUrlFor(t);
  if (t.update) bits.push(upUrl ? `<a href="${upUrl}" target="_blank" rel="noopener">${esc(t.update)} ↗</a>` : esc(t.update));
  if (t.page) bits.push(`<a href="${t.page}" target="_blank" rel="noopener">${t.wiki.toUpperCase()} wiki ↗</a>`);
  $('npMeta').innerHTML = bits.join(' · ');
  syncPip();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.composer || 'Jagex', album: `RuneScape (${t.wiki.toUpperCase()})` });
  }
}

function next(auto) {
  if (!state.queue.length) return;
  if (auto && state.repeat === 'one') { audio.currentTime = 0; audio.play(); return; }
  let i;
  if (state.shuffle) {
    i = Math.random() * state.queue.length | 0;
  } else {
    i = state.current + 1;
    if (i >= state.queue.length) {
      if (state.repeat === 'all' || !auto) i = 0; else { audio.pause(); return; }
    }
  }
  playIndex(i);
}
function prev() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  let i = state.current - 1;
  if (i < 0) i = state.queue.length - 1;
  playIndex(i);
}

// ui builders
function buildEraTabs() {
  const nav = $('eras');
  nav.innerHTML = '';
  ERAS.forEach(e => {
    const b = document.createElement('button');
    b.className = 'era-tab' + (e.id === state.era ? ' active' : '');
    b.innerHTML = `${e.label}<span class="era-sub">${e.sub}</span>`;
    b.title = `Play every track as it sounded in ${e.sub}`;
    b.onclick = () => {
      state.era = e.id;
      [...nav.children].forEach(c => c.classList.remove('active'));
      b.classList.add('active');
      updateListTitle();
      apply();
    };
    nav.appendChild(b);
  });
}

// osrs vs rs3
const GAMES = [
  { id: 'osrs', label: 'OSRS / RuneScape 2' },
  { id: 'rs3',  label: 'RuneScape 3' },
];
function buildGameTabs() {
  const nav = $('games');
  nav.innerHTML = '';
  GAMES.forEach(g => {
    const b = document.createElement('button');
    b.className = 'era-tab game-tab' + (g.id === state.game ? ' active' : '');
    b.textContent = g.label;
    b.onclick = () => {
      if (state.game === g.id) return;
      state.game = g.id;
      [...nav.children].forEach(c => c.classList.remove('active'));
      b.classList.add('active');
      if (state.game === 'rs3' && state.sortKey === 'releaseYear') {
        state.sortKey = 'title'; state.sortDir = 'asc'; updateSortHeaders();
      }
      applyMode();
      apply();
    };
    nav.appendChild(b);
  });
}

// toggle the year UI per game
function applyMode() {
  const rs3 = state.game === 'rs3';
  document.body.classList.toggle('mode-rs3', rs3);
  $('eras').style.display = rs3 ? 'none' : '';
  $('eraHint').style.display = rs3 ? 'none' : '';
  $('yearFilter').style.display = rs3 ? 'none' : '';
  updateListTitle();
}

function updateListTitle() {
  if (state.favsOnly) { $('listTitle').textContent = 'Favourites ★'; return; }
  if (state.game === 'rs3') { $('listTitle').textContent = 'RuneScape 3: all tracks'; return; }
  const e = ERAS.find(e => e.id === state.era);
  $('listTitle').textContent = e ? `OSRS · ${e.label} sound (${e.sub})` : 'OSRS';
}

// events
function wire() {
  let searchTimer;
  $('search').oninput = (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = e.target.value.trim(); apply(); }, 180);
  };
  $('yearMin').onchange = (e) => { state.yearMin = e.target.value ? +e.target.value : null; apply(); };
  $('yearMax').onchange = (e) => { state.yearMax = e.target.value ? +e.target.value : null; apply(); };
  $('members').onchange = (e) => { state.members = e.target.value; apply(); };
  $('surprise').onclick = () => {
    if (!state.queue.length) return;
    playIndex(Math.random() * state.queue.length | 0);
  };
  $('onthisday').onclick = () => {
    const now = new Date();
    const md = `-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    state.search = '';
    $('search').value = '';
    // tracks released on today's date
    state.filtered = state.tracks.filter(t => t.wiki === state.game && t.release && t.release.slice(4) === md)
      .sort((a,b)=>(a.releaseYear||0)-(b.releaseYear||0));
    state.queue = state.filtered;
    state.queueMeta = null;
    $('listTitle').textContent = `Released on ${now.toLocaleString('en',{month:'long',day:'numeric'})}`;
    render();
  };
  $('favView').onclick = (e) => {
    state.favsOnly = !state.favsOnly;
    e.target.classList.toggle('active', state.favsOnly);
    updateListTitle();
    apply();
  };
  $('reset').onclick = () => resetFilters();
  // playlists modal
  $('plBtn').onclick = openPlaylists;
  $('plClose').onclick = closePlaylists;
  $('plModal').onclick = (e) => { if (e.target.id === 'plModal') closePlaylists(); };
  $('plCreate').onclick = () => {
    const n = $('plName').value.trim();
    if (!n) { $('plName').focus(); return; }
    createPlaylist(n, $('plAuthor').value); $('plName').value = ''; $('plAuthor').value = ''; renderPlaylists();
  };
  $('plImportBtn').onclick = () => {
    const p = importPlaylist($('plImport').value);
    $('plImport').value = '';
    if (p) renderPlaylists(); else $('plImport').placeholder = 'That code did not work — try again';
  };
  $('plList').onclick = (e) => {
    const item = e.target.closest('.pl-item'); if (!item) return;
    const p = state.playlists.find(x => x.id === item.dataset.id); if (!p) return;
    const mv = e.target.closest('[data-mv]');
    if (mv) { moveTrack(p.id, +mv.dataset.i, mv.dataset.mv === 'up' ? -1 : 1); renderPlaylists(); return; }
    const rm = e.target.closest('[data-rm]');
    if (rm) { const tid = p.tracks[+rm.dataset.rm]?.id; removeTrackAt(p.id, +rm.dataset.rm); renderPlaylists(); if (tid) updateRowAddState(tid); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'toggle') { plOpen = plOpen === p.id ? null : p.id; renderPlaylists(); }
    else if (act === 'play') playPlaylist(p);
    else if (act === 'share') copyShare(p, e.target);
    else if (act === 'del' && confirm(`Delete "${p.name}"?`)) { if (plOpen === p.id) plOpen = null; deletePlaylist(p.id); }
  };
  $('plList').onchange = (e) => {
    const sel = e.target.closest('.pl-ver'); if (!sel) return;
    const item = e.target.closest('.pl-item'); const p = state.playlists.find(x => x.id === item?.dataset.id); if (!p) return;
    const entry = p.tracks[+sel.dataset.i]; if (entry) { entry.v = +sel.value; savePlaylists(); }
  };
  const openAbout = (v) => { $('aboutModal').hidden = !v; };
  $('aboutBtn').onclick = () => openAbout(true);
  $('aboutBtn').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAbout(true); } };
  $('aboutClose').onclick = () => openAbout(false);
  $('aboutModal').onclick = (e) => { if (e.target.id === 'aboutModal') openAbout(false); };
  $('npFav').onclick = () => { const t = state.queue[state.current]; if (t) toggleFav(t.id); };
  $('versionSel').onchange = (e) => {
    const t = state.queue[state.current];
    if (!t || !t.versions) return;
    const v = t.versions[+e.target.value];
    if (!v) return;
    state.currentVersion = v;
    const pos = audio.currentTime, playing = !audio.paused;
    audio.src = v.audio;
    setLoading(true);
    audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = Math.min(pos, audio.duration || pos); } catch (_) {} }, { once: true });
    if (playing) audio.play().catch(()=>{});
    updateNowPlaying(t, v);
  };

  // track list clicks
  $('trackList').onclick = (e) => {
    const star = e.target.closest('[data-fav]');
    if (star) {
      e.stopPropagation();
      toggleFav(star.dataset.fav);
      return;
    }
    const add = e.target.closest('[data-add]');
    if (add) { e.stopPropagation(); showAddMenu(e.clientX, e.clientY, add.dataset.add); return; }
    if (e.target.closest('[data-noplay]')) return; // update link, let it open
    const row = e.target.closest('.track-row');
    if (row) playIndex(+row.dataset.i);
  };

  // sortable column headers
  document.querySelector('.list-head').onclick = (e) => {
    const col = e.target.closest('[data-sort]');
    if (!col) return;
    const key = col.dataset.sort;
    if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    else { state.sortKey = key; state.sortDir = 'asc'; }
    updateSortHeaders();
    apply();
  };

  // player controls
  initPlayerIcons();
  $('playpause').onclick = () => { if (state.current < 0) playIndex(0); else if (audio.paused) audio.play(); else audio.pause(); };
  $('next').onclick = () => next(false);
  $('prev').onclick = prev;
  $('shuffle').onclick = toggleShuffle;
  $('repeat').onclick = cycleRepeat;
  $('vol').oninput = (e) => { audio.volume = e.target.value / 100; if (pipEls) pipEls.vol.value = e.target.value; };
  audio.volume = 0.8;

  // seek
  $('seek').oninput = (e) => { if (audio.duration) audio.currentTime = (e.target.value/1000) * audio.duration; };
  audio.ontimeupdate = () => {
    if (audio.duration) {
      $('seek').value = (audio.currentTime / audio.duration) * 1000;
      $('curTime').textContent = fmt(audio.currentTime);
      $('durTime').textContent = fmt(audio.duration);
    }
  };
  audio.onplay = () => { setPlayIcon(true); startViz(); };
  audio.onpause = () => { setPlayIcon(false); stopViz(); };
  audio.onended = () => next(true);
  if ('documentPictureInPicture' in window) { $('pipBtn').hidden = false; $('pipBtn').onclick = openPip; }
  // buffering indicator
  audio.onwaiting = () => setLoading(true);
  audio.onstalled = () => setLoading(true);
  audio.onplaying = () => setLoading(false);
  audio.oncanplay = () => setLoading(false);
  audio.onerror = () => setLoading(false);

  // keyboard
  document.onkeydown = (e) => {
    if (e.key === 'Escape' && !$('aboutModal').hidden) { $('aboutModal').hidden = true; return; }
    if (e.key === 'Escape' && !$('plModal').hidden) { closePlaylists(); return; }
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); $('playpause').click(); }
    else if (e.code === 'ArrowRight' && e.shiftKey) next(false);
    else if (e.code === 'ArrowLeft' && e.shiftKey) prev();
    else if (e.code === 'ArrowRight') audio.currentTime += 5;
    else if (e.code === 'ArrowLeft') audio.currentTime -= 5;
    else if (e.key === '/') { e.preventDefault(); $('search').focus(); }
  };
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('previoustrack', prev);
    navigator.mediaSession.setActionHandler('nexttrack', () => next(false));
  }
  window.addEventListener('resize', alignHeader);
}

function resetFilters() {
  // reset filters, keep the game
  const sortKey = state.game === 'rs3' ? 'title' : 'releaseYear';
  Object.assign(state, { era:DEFAULT_ERA, search:'', yearMin:null, yearMax:null, members:'all', sortKey, sortDir:'asc', favsOnly:false });
  $('search').value = ''; $('yearMin').value=''; $('yearMax').value='';
  $('members').value='all';
  $('favView').classList.remove('active');
  buildEraTabs(); updateSortHeaders(); applyMode(); apply();
}

function fmt(s) { s = Math.floor(s||0); return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`; }
function setLoading(on) { $('npLoad').hidden = !on; }

// visitor counter, once per session; hides if the service is down
async function loadCounter() {
  const el = $('counterDigits');
  const show = (n) => { el.textContent = String(n).padStart(6, '0'); };
  const cached = sessionStorage.getItem('rsmp_visits');
  if (cached) { show(+cached); return; }
  try {
    const r = await fetch('https://api.counterapi.dev/v1/sounds-of-runescape/visits/up');
    const n = (await r.json()).count;
    if (typeof n !== 'number') throw 0;
    sessionStorage.setItem('rsmp_visits', n);
    show(n);
  } catch (_) {
    $('counter').style.display = 'none';
  }
}

// player icons (win2000)
const ICONS = {
  prev: `<svg class="ico" viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="3" width="2.4" height="10"/><path d="M14 3 L14 13 L6 8 Z"/></svg>`,
  next: `<svg class="ico" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3 L10 8 L2 13 Z"/><rect x="11.6" y="3" width="2.4" height="10"/></svg>`,
  play: `<svg class="ico" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 2.5 L13.5 8 L3.5 13.5 Z"/></svg>`,
  pause: `<svg class="ico" viewBox="0 0 16 16" fill="currentColor"><rect x="3.6" y="3" width="3.2" height="10"/><rect x="9.2" y="3" width="3.2" height="10"/></svg>`,
  shuffle: `<svg class="ico" viewBox="0 0 16 16" fill="currentColor"><g fill="none" stroke="currentColor" stroke-width="1.7"><path d="M1 4.5 H4.5 L10 11.5 H13.5"/><path d="M1 11.5 H4.5 L10 4.5 H13.5"/></g><path d="M11.4 1.8 L15.2 4.5 L11.4 7.2 Z"/><path d="M11.4 8.8 L15.2 11.5 L11.4 14.2 Z"/></svg>`,
  repeat: `<svg class="ico" viewBox="0 0 16 16" fill="currentColor"><g fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 8 A4 4 0 0 1 8 4 H11"/><path d="M12 8 A4 4 0 0 1 8 12 H5"/></g><path d="M10 1.5 L13.6 4 L10 6.5 Z"/><path d="M6 9.5 L2.4 12 L6 14.5 Z"/></svg>`,
  repeatOne: `<svg class="ico" viewBox="0 0 16 16" fill="currentColor"><g fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 8 A4 4 0 0 1 8 4 H11"/><path d="M12 8 A4 4 0 0 1 8 12 H5"/></g><path d="M10 1.5 L13.6 4 L10 6.5 Z"/><path d="M6 9.5 L2.4 12 L6 14.5 Z"/><text x="8" y="10.6" text-anchor="middle" font-size="7.5" font-family="Tahoma,Arial,sans-serif" font-weight="bold" stroke="none">1</text></svg>`,
  volume: `<svg class="ico" viewBox="0 0 16 16" fill="currentColor"><path d="M2 6 H4.3 L8 3 V13 L4.3 10 H2 Z"/><g fill="none" stroke="currentColor" stroke-width="1.3"><path d="M10.3 5.6 A3.4 3.4 0 0 1 10.3 10.4"/><path d="M12.1 3.6 A6 6 0 0 1 12.1 12.4"/></g></svg>`,
  popout: `<svg class="ico" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3 H9 V5 H4 V12 H11 V9 H13 V14 H2 Z"/><path d="M9.5 2 H14 V6.5 H12 V5.1 L8.6 8.5 L7.5 7.4 L10.9 4 H9.5 Z"/></svg>`,
};
function initPlayerIcons() {
  $('prev').innerHTML = ICONS.prev;
  $('playpause').innerHTML = ICONS.play;
  $('next').innerHTML = ICONS.next;
  $('shuffle').innerHTML = ICONS.shuffle;
  $('repeat').innerHTML = ICONS.repeat;
  $('volIco').innerHTML = ICONS.volume;
  if ($('pipBtn')) $('pipBtn').innerHTML = ICONS.popout;
}

// visualizer
// segmented led eq, mirrored around the centre (rs music has little treble)
const VIZ_BARS = 16;  // even, mirrored
const HALF = VIZ_BARS / 2;
const SEG_H = 4, SEG_GAP = 1, BAR_GAP = 2, PEAK_FALL = 0.14;
const USABLE_BINS = 16;  // bins with energy
let vizCtx, analyser, vizData, vizRAF, audioSrc;
let vizPeaks = new Array(VIZ_BARS).fill(0);  // peak caps
let vizMax = new Array(HALF).fill(48);  // per-band auto-gain

function segColour(frac, on) {
  const c = frac < 0.6 ? [144,192,64]      // green (low)
          : frac < 0.85 ? [255,225,57]     // gold (mid)
          : [225,40,20];                    // red (hot)
  return on ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},0.09)`;
}
function drawEq(values) {
  // advance peaks once per frame
  const rows = Math.max(1, Math.floor($('viz').height / (SEG_H + SEG_GAP)));
  for (let i = 0; i < VIZ_BARS; i++) {
    const lit = Math.round((values[i] || 0) / 255 * rows);
    vizPeaks[i] = Math.max(lit, vizPeaks[i] - PEAK_FALL);
  }
  paintEq($('viz'), values);
  if (pipEls && pipEls.viz) paintEq(pipEls.viz, values);   // + the pop-out
}
function paintEq(cv, values) {
  const ctx = cv.getContext('2d');
  const cell = SEG_H + SEG_GAP;
  const rows = Math.max(1, Math.floor(cv.height / cell));
  const barW = (cv.width - BAR_GAP * (VIZ_BARS - 1)) / VIZ_BARS;
  ctx.clearRect(0, 0, cv.width, cv.height);
  for (let i = 0; i < VIZ_BARS; i++) {
    const lit = Math.round((values[i] || 0) / 255 * rows);
    const x = i * (barW + BAR_GAP);
    for (let s = 0; s < rows; s++) {
      const y = cv.height - (s + 1) * cell + SEG_GAP;
      ctx.fillStyle = segColour(s / (rows - 1), s < lit);
      ctx.fillRect(x, y, barW, SEG_H);
    }
    const pk = Math.round(vizPeaks[i]);           // peak-hold cap
    if (pk > 0) {
      ctx.fillStyle = '#fffbe0';
      ctx.shadowColor = '#ffd83c'; ctx.shadowBlur = 4;
      ctx.fillRect(x, cv.height - pk * cell + SEG_GAP, barW, SEG_H);
      ctx.shadowBlur = 0;
    }
  }
}

// pop-out player (document pip)
let pipWin = null, pipEls = null;

function setPlayIcon(playing) {
  $('playpause').innerHTML = playing ? ICONS.pause : ICONS.play;
  if (pipEls) pipEls.play.innerHTML = playing ? ICONS.pause : ICONS.play;
}

// shuffle/repeat shared by the bar + pop-out
function applyShuffle() {
  $('shuffle').classList.toggle('active', state.shuffle);
  if (pipEls) pipEls.shuffle.classList.toggle('active', state.shuffle);
}
function toggleShuffle() { state.shuffle = !state.shuffle; applyShuffle(); }
function applyRepeat() {
  const icon = state.repeat === 'one' ? ICONS.repeatOne : ICONS.repeat;
  const on = state.repeat !== 'off';
  const r = $('repeat');
  r.dataset.mode = state.repeat; r.classList.toggle('active', on); r.innerHTML = icon; r.title = `Repeat: ${state.repeat}`;
  if (pipEls) { pipEls.repeat.classList.toggle('active', on); pipEls.repeat.innerHTML = icon; pipEls.repeat.title = `Repeat: ${state.repeat}`; }
}
function cycleRepeat() {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  applyRepeat();
}

function syncPip() {
  if (!pipEls) return;
  const t = state.current >= 0 ? state.queue[state.current] : null;
  pipEls.title.textContent = t ? t.title : 'Select a track';
  pipEls.meta.textContent = t ? [t.composer, chosenYear(t)].filter(Boolean).join(' · ') : '';
  pipEls.fav.classList.toggle('on', !!(t && state.favs.has(t.id)));
  pipEls.play.innerHTML = audio.paused ? ICONS.play : ICONS.pause;
  pipEls.vol.value = Math.round(audio.volume * 100);
}

async function openPip() {
  if (!('documentPictureInPicture' in window)) return;
  if (pipWin) { try { pipWin.focus(); } catch (_) {} return; }
  try {
    pipWin = await documentPictureInPicture.requestWindow({ width: 380, height: 116 });
  } catch (e) {
    console.warn('Pop-out player unavailable:', e);
    return;
  }
  const doc = pipWin.document;
  const css = doc.createElement('link'); css.rel = 'stylesheet'; css.href = 'css/style.css'; doc.head.appendChild(css);
  const ico = doc.createElement('link'); ico.rel = 'icon'; ico.href = 'assets/icon.ico'; doc.head.appendChild(ico);
  doc.title = 'Sounds of RuneScape';
  doc.body.className = 'pip-body';
  doc.body.innerHTML = `
    <div class="pip-player">
      <div class="pip-top">
        <canvas class="pip-viz" width="120" height="44"></canvas>
        <div class="pip-main">
          <div class="pip-title">Select a track</div>
          <div class="pip-meta"></div>
        </div>
      </div>
      <div class="pip-controls">
        <button class="pl-btn pip-prev"></button>
        <button class="pl-btn big pip-play"></button>
        <button class="pl-btn pip-next"></button>
        <button class="pl-btn pip-shuffle"></button>
        <button class="pl-btn pip-repeat"></button>
        <span class="fav-star pip-fav" title="Favourite"></span>
        <span class="pip-vol"><span class="vol-ico pip-volico"></span><input type="range" min="0" max="100" class="pip-volrange"></span>
      </div>
    </div>`;
  const q = (s) => doc.querySelector(s);
  pipEls = { title: q('.pip-title'), meta: q('.pip-meta'), play: q('.pip-play'), fav: q('.pip-fav'),
             viz: q('.pip-viz'), shuffle: q('.pip-shuffle'), repeat: q('.pip-repeat'), vol: q('.pip-volrange') };
  q('.pip-prev').innerHTML = ICONS.prev;
  q('.pip-next').innerHTML = ICONS.next;
  pipEls.shuffle.innerHTML = ICONS.shuffle;
  q('.pip-volico').innerHTML = ICONS.volume;
  q('.pip-prev').onclick = prev;
  q('.pip-next').onclick = () => next(false);
  pipEls.play.onclick = () => { if (state.current < 0) playIndex(0); else if (audio.paused) audio.play(); else audio.pause(); };
  pipEls.shuffle.onclick = toggleShuffle;
  pipEls.repeat.onclick = cycleRepeat;
  pipEls.fav.onclick = () => { const t = state.queue[state.current]; if (t) toggleFav(t.id); };
  pipEls.vol.oninput = (e) => { audio.volume = e.target.value / 100; $('vol').value = e.target.value; };
  applyShuffle(); applyRepeat();
  pipWin.addEventListener('pagehide', () => { pipWin = null; pipEls = null; });
  syncPip();
  drawIdle();
}
function drawIdle() {
  vizPeaks = new Array(VIZ_BARS).fill(0);
  drawEq(new Array(VIZ_BARS).fill(22));   // idle/resting
}
function startViz() {
  if (vizRAF) return;
  try {
    if (!vizCtx) {
      vizCtx = new (window.AudioContext||window.webkitAudioContext)();
      analyser = vizCtx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.75;
      audioSrc = vizCtx.createMediaElementSource(audio);
      audioSrc.connect(analyser);
      analyser.connect(vizCtx.destination);
      vizData = new Uint8Array(analyser.frequencyBinCount);
    }
    vizCtx.resume();
    drawViz();
  } catch (_) { drawIdle(); /* can fail, ignore */ }
}
function stopViz() {
  if (vizRAF) { cancelAnimationFrame(vizRAF); vizRAF = null; }
  drawIdle();
}
function drawViz() {
  vizRAF = requestAnimationFrame(drawViz);
  analyser.getByteFrequencyData(vizData);
  const top = Math.min(USABLE_BINS, vizData.length);
  // per-band value, auto-gained
  const band = [];
  for (let j = 0; j < HALF; j++) {
    const lo = 1 + Math.floor(j * top / HALF);
    const hi = Math.max(lo + 1, 1 + Math.floor((j + 1) * top / HALF));
    let sum = 0, cnt = 0;
    for (let b = lo; b < hi && b < vizData.length; b++) { sum += vizData[b]; cnt++; }
    const raw = cnt ? sum / cnt : 0;
    vizMax[j] = Math.max(raw, vizMax[j] * 0.99, 38);      // floor so silence doesn't blow up
    band[j] = Math.min(255, (raw / vizMax[j]) * 255);
  }
  // mirror bass into the middle
  const vals = new Array(VIZ_BARS);
  for (let i = 0; i < VIZ_BARS; i++) {
    const d = i < HALF ? (HALF - 1 - i) : (i - HALF);
    vals[i] = band[d];
  }
  drawEq(vals);
}

// url state
function syncUrl() {
  const p = new URLSearchParams();
  if (state.game !== 'osrs') p.set('game', state.game);
  if (state.era !== DEFAULT_ERA) p.set('era', state.era);
  if (state.search) p.set('q', state.search);
  if (state.sortKey !== 'releaseYear') p.set('sort', state.sortKey);
  if (state.sortDir !== 'asc') p.set('dir', state.sortDir);
  const s = p.toString();
  history.replaceState(null, '', s ? '?'+s : location.pathname);
}
function initFromUrl() {
  const p = new URLSearchParams(location.search);
  if (p.get('game') === 'rs3') state.game = 'rs3';
  if (p.get('era')) state.era = p.get('era');
  if (p.get('q')) { state.search = p.get('q'); $('search').value = state.search; }
  if (p.get('sort')) state.sortKey = p.get('sort');
  if (p.get('dir')) state.sortDir = p.get('dir');
}

wire();
load();
