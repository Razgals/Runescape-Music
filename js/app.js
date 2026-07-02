/* ===== RuneScape Music Player ===== */
'use strict';

const $ = (id) => document.getElementById(id);

// RuneScape's audio history has three real "sound eras" set by engine reworks
// (verified from the version-year data): the 2004–06 MIDI originals, the March
// 2007 soundbank rework (the classic OSRS sound, in use 2007–2024), and the 2025
// 16-bit remaster. Each era is a *snapshot*: it plays every track as it sounded
// then — so picking an era is like time-travelling the whole soundtrack.
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

// Active upper bound (era snapshot year, further narrowed by the year-range inputs).
function activeBounds() {
  const era = ERAS.find(e => e.id === state.era) || ERAS[ERAS.length - 1];
  return { min: state.yearMin || -Infinity,
           max: Math.min(era.max, state.yearMax || Infinity) };
}
// A track belongs to the snapshot if its lifespan overlaps the window.
function inEra(t) {
  const e = trackEarliest(t); if (e == null) return false;
  const { min, max } = activeBounds();
  return e <= max && trackLatest(t) >= min;
}
// Play the newest version at/under the snapshot year — how the track sounded then.
function pickVersion(t) {
  if (state.game !== 'osrs' || !t.versions || t.versions.length < 2) return null;
  const { max } = activeBounds();
  const below = t.versions.filter(v => v.year <= max);
  return below.length ? below[below.length - 1] : t.versions[0];
}
function chosenYear(t) { return pickVersion(t)?.year ?? trackLatest(t) ?? t.releaseYear; }

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
  current: -1,            // index into queue
  shuffle: false,
  repeat: 'off',          // off | one | all
  favs: new Set(JSON.parse(localStorage.getItem('rsmp_favs') || '[]')),
};

const audio = $('audio');

// ===================== Data load =====================
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
    $('loading').classList.add('hidden');
  } catch (e) {
    $('loading').textContent = 'Failed to load data. Run: node scripts/build-index.mjs';
    console.error(e);
  }
}

// ===================== Filtering / sorting =====================
function apply() {
  const osrs = state.game === 'osrs';   // era snapshots only apply to the OSRS timeline
  const q = state.search.toLowerCase();
  let list = state.tracks.filter(t => {
    if (t.wiki !== state.game) return false;          // OSRS vs RS3 are separate entities
    if (osrs && !inEra(t)) return false;              // in the era's soundtrack snapshot
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
  render();
  syncUrl();
}

// ===================== Rendering =====================
function render() {
  const c = $('trackList');
  $('resultCount').textContent = `${state.filtered.length.toLocaleString()} track${state.filtered.length===1?'':'s'}`;
  const playingId = state.current >= 0 ? state.queue[state.current]?.id : null;

  if (!state.filtered.length) {
    c.innerHTML = `<div style="padding:20px;text-align:center;color:#6a5a32">No tracks match these filters.</div>`;
    return;
  }
  // build with documentFragment for speed (2.5k rows)
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
    const yearCell = chosenYear(t) ?? '—';
    const verBadge = nVer > 1 ? `<span class="ver-badge" title="${nVer} versions">${nVer}×</span>` : '';
    row.innerHTML =
      `<span class="col-fav"><span class="fav-star ${fav}" data-fav="${t.id}" title="Favourite"></span></span>` +
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

// Pad the header by the scrollbar width so its columns line up with the rows below.
function alignHeader() {
  const list = $('trackList');
  const sbw = list.offsetWidth - list.clientWidth;   // vertical scrollbar width (0 if none)
  document.querySelector('.list-head').style.paddingRight = (10 + sbw) + 'px';
}

function esc(s) { return (s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// Toggle a favourite from anywhere and keep the list star + mini-player star in sync.
function toggleFav(id) {
  if (state.favs.has(id)) state.favs.delete(id); else state.favs.add(id);
  localStorage.setItem('rsmp_favs', JSON.stringify([...state.favs]));
  const on = state.favs.has(id);
  const cur = state.current >= 0 ? state.queue[state.current] : null;
  if (cur && cur.id === id) $('npFav').classList.toggle('on', on);
  const star = document.querySelector(`.fav-star[data-fav="${CSS.escape(id)}"]`);
  if (star) star.classList.toggle('on', on);
  if (state.favsOnly) apply();   // a track may have left the favourites view
}

function updateSortHeaders() {
  document.querySelectorAll('.list-head .sort-col').forEach(col => {
    const active = col.dataset.sort === state.sortKey;
    col.classList.toggle('sorted', active);
    col.dataset.arrow = active ? (state.sortDir === 'asc' ? '▲' : '▼') : '';
  });
}

// ===================== Playback =====================
function playIndex(i) {
  if (i < 0 || i >= state.queue.length) return;
  state.current = i;
  const t = state.queue[i];
  const v = pickVersion(t);                 // era-appropriate version, or null for single-file
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

// Version selector in the player — only for OSRS tracks with a real choice.
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

// ===================== UI builders =====================
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

// Two distinct entities: OSRS (RS2 timeline, has years) and RS3 (yearless).
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

// Show/hide year-dependent UI depending on the selected game.
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

// ===================== Events =====================
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
    // temporary filter: tracks (in the current game) whose release matches today's month-day
    state.filtered = state.tracks.filter(t => t.wiki === state.game && t.release && t.release.slice(4) === md)
      .sort((a,b)=>(a.releaseYear||0)-(b.releaseYear||0));
    state.queue = state.filtered;
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

  // track list: play + favourite (event delegation)
  $('trackList').onclick = (e) => {
    const star = e.target.closest('[data-fav]');
    if (star) {
      e.stopPropagation();
      toggleFav(star.dataset.fav);
      return;
    }
    if (e.target.closest('[data-noplay]')) return; // update link — let it open
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
  $('shuffle').onclick = () => { state.shuffle = !state.shuffle; $('shuffle').classList.toggle('active', state.shuffle); };
  $('repeat').onclick = () => {
    state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
    const btn = $('repeat');
    btn.dataset.mode = state.repeat;
    btn.classList.toggle('active', state.repeat !== 'off');
    btn.innerHTML = state.repeat === 'one' ? ICONS.repeatOne : ICONS.repeat;
    btn.title = `Repeat: ${state.repeat}`;
  };
  $('vol').oninput = (e) => { audio.volume = e.target.value / 100; };
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
  audio.onplay = () => { $('playpause').innerHTML = ICONS.pause; startViz(); };
  audio.onpause = () => { $('playpause').innerHTML = ICONS.play; stopViz(); };
  audio.onended = () => next(true);
  // buffering indicator
  audio.onwaiting = () => setLoading(true);
  audio.onstalled = () => setLoading(true);
  audio.onplaying = () => setLoading(false);
  audio.oncanplay = () => setLoading(false);
  audio.onerror = () => setLoading(false);

  // keyboard
  document.onkeydown = (e) => {
    if (e.key === 'Escape' && !$('aboutModal').hidden) { $('aboutModal').hidden = true; return; }
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
  // resets filters but keeps the currently-selected game
  const sortKey = state.game === 'rs3' ? 'title' : 'releaseYear';
  Object.assign(state, { era:DEFAULT_ERA, search:'', yearMin:null, yearMax:null, members:'all', sortKey, sortDir:'asc', favsOnly:false });
  $('search').value = ''; $('yearMin').value=''; $('yearMax').value='';
  $('members').value='all';
  $('favView').classList.remove('active');
  buildEraTabs(); updateSortHeaders(); applyMode(); apply();
}

function fmt(s) { s = Math.floor(s||0); return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`; }
function setLoading(on) { $('npLoad').hidden = !on; }

// Retro visitor counter — increments once per browser session; hides if the free
// counter service is unreachable so a broken widget never shows.
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

// ===================== Player icons (Windows 2000 / WMP 6.4 style) =====================
const ICONS = {
  prev: `<svg class="ico" viewBox="0 0 16 16" fill="currentColor"><rect x="2" y="3" width="2.4" height="10"/><path d="M14 3 L14 13 L6 8 Z"/></svg>`,
  next: `<svg class="ico" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3 L10 8 L2 13 Z"/><rect x="11.6" y="3" width="2.4" height="10"/></svg>`,
  play: `<svg class="ico" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 2.5 L13.5 8 L3.5 13.5 Z"/></svg>`,
  pause: `<svg class="ico" viewBox="0 0 16 16" fill="currentColor"><rect x="3.6" y="3" width="3.2" height="10"/><rect x="9.2" y="3" width="3.2" height="10"/></svg>`,
  shuffle: `<svg class="ico" viewBox="0 0 16 16" fill="currentColor"><g fill="none" stroke="currentColor" stroke-width="1.7"><path d="M1 4.5 H4.5 L10 11.5 H13.5"/><path d="M1 11.5 H4.5 L10 4.5 H13.5"/></g><path d="M11.4 1.8 L15.2 4.5 L11.4 7.2 Z"/><path d="M11.4 8.8 L15.2 11.5 L11.4 14.2 Z"/></svg>`,
  repeat: `<svg class="ico" viewBox="0 0 16 16" fill="currentColor"><g fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 8 A4 4 0 0 1 8 4 H11"/><path d="M12 8 A4 4 0 0 1 8 12 H5"/></g><path d="M10 1.5 L13.6 4 L10 6.5 Z"/><path d="M6 9.5 L2.4 12 L6 14.5 Z"/></svg>`,
  repeatOne: `<svg class="ico" viewBox="0 0 16 16" fill="currentColor"><g fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 8 A4 4 0 0 1 8 4 H11"/><path d="M12 8 A4 4 0 0 1 8 12 H5"/></g><path d="M10 1.5 L13.6 4 L10 6.5 Z"/><path d="M6 9.5 L2.4 12 L6 14.5 Z"/><text x="8" y="10.6" text-anchor="middle" font-size="7.5" font-family="Tahoma,Arial,sans-serif" font-weight="bold" stroke="none">1</text></svg>`,
  volume: `<svg class="ico" viewBox="0 0 16 16" fill="currentColor"><path d="M2 6 H4.3 L8 3 V13 L4.3 10 H2 Z"/><g fill="none" stroke="currentColor" stroke-width="1.3"><path d="M10.3 5.6 A3.4 3.4 0 0 1 10.3 10.4"/><path d="M12.1 3.6 A6 6 0 0 1 12.1 12.4"/></g></svg>`,
};
function initPlayerIcons() {
  $('prev').innerHTML = ICONS.prev;
  $('playpause').innerHTML = ICONS.play;
  $('next').innerHTML = ICONS.next;
  $('shuffle').innerHTML = ICONS.shuffle;
  $('repeat').innerHTML = ICONS.repeat;
  $('volIco').innerHTML = ICONS.volume;
}

// ===================== Visualizer =====================
// Old-school segmented LED equalizer: chunky green→gold→red LED cells with dim
// ghosts and slow-falling peak caps. Mirrored around the centre — bass sits in
// the middle and the spectrum fans out symmetrically to both edges — so the whole
// width moves even though RuneScape music has little high-frequency energy.
const VIZ_BARS = 16;                           // even, mirrored around the centre
const HALF = VIZ_BARS / 2;
const SEG_H = 4, SEG_GAP = 1, BAR_GAP = 2, PEAK_FALL = 0.14;
const USABLE_BINS = 16;                        // the low/low-mid range that actually has energy
let vizCtx, analyser, vizData, vizRAF, audioSrc;
let vizPeaks = new Array(VIZ_BARS).fill(0);    // per-bar peak-hold cap level (segments), decays
let vizMax = new Array(HALF).fill(48);         // auto-gain per frequency band (mirrored to both sides)

function segColour(frac, on) {
  const c = frac < 0.6 ? [144,192,64]      // green (low)
          : frac < 0.85 ? [255,225,57]     // gold (mid)
          : [225,40,20];                    // red (hot)
  return on ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},0.09)`;
}
function drawEq(values) {
  const cv = $('viz'), ctx = cv.getContext('2d');
  const cell = SEG_H + SEG_GAP;
  const rows = Math.max(1, Math.floor(cv.height / cell));
  const barW = (cv.width - BAR_GAP * (VIZ_BARS - 1)) / VIZ_BARS;
  ctx.clearRect(0, 0, cv.width, cv.height);
  for (let i = 0; i < VIZ_BARS; i++) {
    const lit = Math.round((values[i] || 0) / 255 * rows);
    vizPeaks[i] = Math.max(lit, vizPeaks[i] - PEAK_FALL);
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
function drawIdle() {
  vizPeaks = new Array(VIZ_BARS).fill(0);
  drawEq(new Array(VIZ_BARS).fill(22));   // bottom LED lit, ghost grid showing, still
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
  } catch (_) { drawIdle(); /* CORS/audio source may block; non-fatal */ }
}
function stopViz() {
  if (vizRAF) { cancelAnimationFrame(vizRAF); vizRAF = null; }
  drawIdle();
}
function drawViz() {
  vizRAF = requestAnimationFrame(drawViz);
  analyser.getByteFrequencyData(vizData);
  const top = Math.min(USABLE_BINS, vizData.length);
  // one value per frequency band (bass -> higher), each auto-gained to its own peak
  const band = [];
  for (let j = 0; j < HALF; j++) {
    const lo = 1 + Math.floor(j * top / HALF);
    const hi = Math.max(lo + 1, 1 + Math.floor((j + 1) * top / HALF));
    let sum = 0, cnt = 0;
    for (let b = lo; b < hi && b < vizData.length; b++) { sum += vizData[b]; cnt++; }
    const raw = cnt ? sum / cnt : 0;
    vizMax[j] = Math.max(raw, vizMax[j] * 0.99, 38);      // floor avoids silence blow-up
    band[j] = Math.min(255, (raw / vizMax[j]) * 255);
  }
  // mirror: bass (band 0) in the two centre bars, higher bands out toward the edges
  const vals = new Array(VIZ_BARS);
  for (let i = 0; i < VIZ_BARS; i++) {
    const d = i < HALF ? (HALF - 1 - i) : (i - HALF);
    vals[i] = band[d];
  }
  drawEq(vals);
}

// ===================== URL state (shareable) =====================
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
