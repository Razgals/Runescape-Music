// Crawls the OSRS & RS3 wikis (MediaWiki API) and builds a static track index.
// Usage:  node scripts/build-index.mjs            (both wikis)
//         node scripts/build-index.mjs osrs       (one wiki)
//         node scripts/build-index.mjs --limit 60 (cap tracks per wiki, for testing)
//
// Output: data/tracks-osrs.json, data/tracks-rs3.json, data/tracks.json, data/meta.json
// audio isn't downloaded, just the .ogg urls

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

const UA = 'RuneScapeMusicPlayer/1.0 (static fan project; wiki + archive.org reader)';

// rs3 audio from the internet archive; composers come from the rs3 wiki
const ARCHIVE_ITEM = 'runescape-music';
const ARCHIVE_BASE = `https://archive.org/download/${ARCHIVE_ITEM}`;

const WIKIS = {
  osrs: { id: 'osrs', name: 'Old School RuneScape', api: 'https://oldschool.runescape.wiki/api.php', base: 'https://oldschool.runescape.wiki' },
  rs3:  { id: 'rs3',  name: 'RuneScape 3',           api: 'https://runescape.wiki/api.php',          base: 'https://runescape.wiki' },
};

const MONTHS = { january:1, february:2, march:3, april:4, may:5, june:6, july:7,
                 august:8, september:9, october:10, november:11, december:12 };

const args = process.argv.slice(2);
const limitArg = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const wikiArg = args.find(a => a === 'osrs' || a === 'rs3');
const targetWikis = wikiArg ? [wikiArg] : ['osrs', 'rs3'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(wiki, params) {
  const url = new URL(wiki.api);
  url.search = new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params }).toString();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 429 || res.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt === 4) throw err;
      await sleep(1500 * (attempt + 1));
    }
  }
}

// --- enumerate every page in Category:Music ---
async function listMusicPages(wiki) {
  const titles = [];
  let cont = {};
  do {
    const data = await api(wiki, {
      action: 'query', list: 'categorymembers',
      cmtitle: 'Category:Music', cmtype: 'page', cmlimit: '500', ...cont,
    });
    for (const m of data.query.categorymembers) {
      if (m.ns === 0 && m.title !== 'Music') titles.push(m.title);
    }
    cont = data.continue || null;
    process.stdout.write(`\r  [${wiki.id}] discovered ${titles.length} pages…`);
  } while (cont && titles.length < limitArg);
  process.stdout.write('\n');
  return titles.slice(0, limitArg);
}

// --- parse {{Infobox Music}} from wikitext into a flat map ---
function parseInfobox(wikitext) {
  const start = wikitext.search(/\{\{\s*Infobox[ _]Music/i);
  if (start === -1) return null;
  // walk braces to find the matching close
  let depth = 0, i = start;
  for (; i < wikitext.length; i++) {
    if (wikitext.startsWith('{{', i)) { depth++; i++; }
    else if (wikitext.startsWith('}}', i)) { depth--; i++; if (depth === 0) break; }
  }
  const body = wikitext.slice(start + 2, i - 1);
  const fields = {};
  // split on top-level pipes only (ignore pipes inside [[...]] / {{...}})
  let buf = '', d2 = 0, b2 = 0;
  const parts = [];
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    if (body.startsWith('{{', j)) { d2++; buf += '{{'; j++; continue; }
    if (body.startsWith('}}', j)) { d2--; buf += '}}'; j++; continue; }
    if (body.startsWith('[[', j)) { b2++; buf += '[['; j++; continue; }
    if (body.startsWith(']]', j)) { b2--; buf += ']]'; j++; continue; }
    if (c === '|' && d2 === 0 && b2 === 0) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  parts.push(buf);
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    fields[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim();
  }
  return fields;
}

// tidy composer credits: drop "(rework)" notes, map mod names, dedupe
const COMPOSER_MAP = { 'mod ian': 'Ian Taylor' };
function normalizeComposer(raw) {
  const s = stripWiki(raw);
  if (!s) return null;
  const seen = new Set(), out = [];
  for (let part of s.split(',')) {
    part = part.replace(/\([^)]*\)/g, '').trim();
    if (!part) continue;
    part = COMPOSER_MAP[part.toLowerCase()] || part;
    const k = part.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(part); }
  }
  return out.join(', ') || null;
}

function durationSecs(d) {
  if (!d) return null;
  const p = d.split(':').map(Number);
  if (p.some(isNaN)) return null;
  return p.length === 2 ? p[0]*60 + p[1] : p.length === 3 ? p[0]*3600 + p[1]*60 + p[2] : null;
}

function stripWiki(s) {
  if (!s) return '';
  return s
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1') // [[a|b]] -> b
    .replace(/\[\[([^\]]*)\]\]/g, '$1')           // [[a]] -> a
    .replace(/'''?/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{[^}]*\}\}/g, '')
    .trim();
}

function parseRelease(raw) {
  if (!raw) return { date: null, year: null };
  const years = [...raw.matchAll(/\b(19\d\d|20\d\d)\b/g)].map(m => Number(m[1]));
  const year = years.length ? Math.min(...years) : null; // earliest year mentioned = original release
  const dm = raw.match(/\b(\d{1,2})\s+([A-Za-z]+)\b/);
  let date = null;
  if (dm && year) {
    const mon = MONTHS[dm[2].toLowerCase()];
    if (mon) date = `${year}-${String(mon).padStart(2,'0')}-${String(dm[1]).padStart(2,'0')}`;
  }
  return { date, year };
}

function fileTitle(raw) {
  if (!raw) return null;
  let t = stripWiki(raw).trim();
  t = t.replace(/^File:/i, '').trim();
  if (!t || !/\.(ogg|mp3|oga)$/i.test(t)) return null;
  return 'File:' + t;
}

// strip the "(music track)" / "(music)" disambiguator from a display title
function cleanTitle(t) { return t.replace(/\s*\((?:music track|music|track)\)\s*$/i, '').trim(); }

// parse the OSRS ==Versions== table (number, date, [[File:...ogg]] per row)
function parseVersions(wikitext) {
  const m = wikitext.match(/==+\s*Versions?\s*==+([\s\S]*?)(?:\n==[^=]|$)/i);
  if (!m) return [];
  const tStart = m[1].indexOf('{|');
  if (tStart === -1) return [];
  const tEnd = m[1].indexOf('|}', tStart);
  const tbl = m[1].slice(tStart, tEnd === -1 ? undefined : tEnd);
  const out = [];
  for (const r of tbl.split(/\n\|-/)) {
    if (/!\s*Version/i.test(r) || /colspan/i.test(r)) continue;
    const fm = r.match(/\[\[File:\s*([^\]|]+?\.ogg)\s*(?:\|[^\]]*)?\]\]/i);
    if (!fm) continue;
    const rel = parseRelease(r);
    if (!rel.year) continue;
    const nm = r.match(/\|\s*(\d+)\s*\n/);
    out.push({ v: nm ? Number(nm[1]) : out.length + 1, year: rel.year, date: rel.date,
               file: 'File:' + fm[1].trim().replace(/_/g, ' '), audio: null });
  }
  out.sort((a, b) => (a.year || 0) - (b.year || 0));
  return out;
}

// --- batch helper ---
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

async function fetchInfoboxes(wiki, titles) {
  const tracks = [];
  const fileNeeded = new Map(); // file title -> [track,...]
  let done = 0;
  for (const batch of chunk(titles, 50)) {
    const data = await api(wiki, {
      action: 'query', titles: batch.join('|'),
      prop: 'revisions|categories', rvprop: 'content', rvslots: 'main',
      cllimit: 'max',
      clcategories: 'Category:Jingles|Category:Sound effects|Category:Music tracks|Category:Unused music',
    });
    for (const page of data.query.pages) {
      if (page.missing) continue;
      const wikitext = page.revisions?.[0]?.slots?.main?.content;
      if (!wikitext) continue;
      const ib = parseInfobox(wikitext);
      if (!ib) continue; // not actually a music track
      const cats = new Set((page.categories || []).map(c => c.title));
      const rel = parseRelease(ib.release);
      const ft = fileTitle(ib.file);
      const versions = parseVersions(wikitext);     // real per-version dates + files (OSRS)
      const track = {
        id: `${wiki.id}:${page.pageid}`,
        wiki: wiki.id,
        title: cleanTitle(page.title),
        number: ib.number ? Number(stripWiki(ib.number).replace(/[^\d]/g,'')) || null : null,
        release: versions.length ? versions[0].date : rel.date,
        releaseYear: versions.length ? versions[0].year : rel.year,   // earliest version = original
        update: stripWiki(ib.update) || null,
        members: ib.members ? /^yes/i.test(stripWiki(ib.members)) : null,
        duration: stripWiki(ib.duration) || null,
        lengthSec: durationSecs(stripWiki(ib.duration)),
        composer: normalizeComposer(ib.composer),
        location: stripWiki(ib.location) || null,
        quest: ib.quest ? !/^(no|n\/a)/i.test(stripWiki(ib.quest)) : null,
        jingle: cats.has('Category:Jingles') || cats.has('Category:Sound effects'),
        unused: cats.has('Category:Unused music'),
        page: `${wiki.base}/w/${encodeURIComponent(page.title.replace(/ /g,'_'))}`,
        audio: null,
        versions: versions.length > 1 ? versions : [],  // only expose when there's a real choice
      };
      tracks.push(track);
      const need = (fileTitleStr, target) => {
        if (!fileTitleStr) return;
        if (!fileNeeded.has(fileTitleStr)) fileNeeded.set(fileTitleStr, []);
        fileNeeded.get(fileTitleStr).push(target);
      };
      need(ft, track);                                  // current/default audio
      for (const v of track.versions) need(v.file, v); // each version's audio
    }
    done += batch.length;
    process.stdout.write(`\r  [${wiki.id}] parsed infoboxes ${Math.min(done,titles.length)}/${titles.length}…`);
    await sleep(120);
  }
  process.stdout.write('\n');
  return { tracks, fileNeeded };
}

async function fetchAudio(wiki, fileNeeded) {
  const fileTitles = [...fileNeeded.keys()];
  let done = 0;
  for (const batch of chunk(fileTitles, 50)) {
    const data = await api(wiki, {
      action: 'query', titles: batch.join('|'),
      prop: 'imageinfo', iiprop: 'url', iilimit: '1',
    });
    // mediawiki may normalise titles, map them back
    const norm = {};
    for (const n of (data.query.normalized || [])) norm[n.to] = n.from;
    for (const page of data.query.pages) {
      const url = page.imageinfo?.[0]?.url;
      if (!url) continue;
      const key = norm[page.title] || page.title;
      for (const target of (fileNeeded.get(key) || fileNeeded.get(page.title) || [])) target.audio = url;
    }
    done += batch.length;
    process.stdout.write(`\r  [${wiki.id}] resolved audio ${Math.min(done,fileTitles.length)}/${fileTitles.length}…`);
    await sleep(120);
  }
  process.stdout.write('\n');
}

// jingles / stings — dropped from the output
function isJingleTrack(t) {
  if (t.jingle) return true;                                  // wiki Category:Jingles / Sound effects
  if (t.lengthSec != null && t.lengthSec < 15) return true;
  if (/\bjingle\b|level up!|\(unlocks\)/i.test(t.title)) return true;
  if (/^(null|silence)\b/i.test(t.title)) return true;
  return false;
}
function fmtDuration(sec) {
  if (sec == null || isNaN(sec)) return null;
  sec = Math.round(sec);
  return `${Math.floor(sec/60)}:${String(sec % 60).padStart(2,'0')}`;
}
// normalise a title for archive<->wiki matching
function normTitle(s) {
  return s.toLowerCase().replace(/\((music track|music|track|theme)\)/g, '').replace(/[^a-z0-9]/g, '');
}

// OSRS: full wiki crawl (infoboxes + audio), jingles dropped.
async function crawl(wiki) {
  console.log(`\n=== Crawling ${wiki.name} (${wiki.id}) ===`);
  const titles = await listMusicPages(wiki);
  const { tracks, fileNeeded } = await fetchInfoboxes(wiki, titles);
  await fetchAudio(wiki, fileNeeded);
  for (const t of tracks) {
    if (!t.versions.length) continue;
    t.versions = t.versions.filter(v => v.audio).map(v => ({ v: v.v, year: v.year, date: v.date, audio: v.audio }));
    if (t.versions.length < 2) t.versions = [];              // need a real choice to keep
    else if (!t.audio) t.audio = t.versions[t.versions.length - 1].audio; // default = latest
  }
  const playable = tracks.filter(t => t.audio && !isJingleTrack(t));
  const multi = playable.filter(t => t.versions.length > 1).length;
  console.log(`  [${wiki.id}] ${tracks.length} tracks → ${playable.length} kept (${multi} with multiple versions)`);
  return playable;
}

// RS3 wiki crawl for metadata only (composer / jingle flag), no audio resolution.
async function crawlInfoOnly(wiki) {
  console.log(`\n=== Crawling ${wiki.name} (${wiki.id}) infoboxes (composer source) ===`);
  const titles = await listMusicPages(wiki);
  const { tracks } = await fetchInfoboxes(wiki, titles);
  console.log(`  [${wiki.id}] ${tracks.length} wiki entries`);
  return tracks;
}

// rs3 = archive.org audio + rs3-wiki composers, matched by title
async function buildRs3FromArchive(wikiTracks) {
  console.log('  [rs3] joining archive.org audio with RS3-wiki composers…');
  const wmap = new Map();
  for (const t of wikiTracks) { const k = normTitle(t.title); if (!wmap.has(k)) wmap.set(k, t); }
  const meta = await (await fetch(`https://archive.org/metadata/${ARCHIVE_ITEM}`, { headers: { 'User-Agent': UA } })).json();
  const oggs = meta.files.filter(f => /\.ogg$/i.test(f.name));
  const out = []; let withComposer = 0, dropped = 0;
  for (const f of oggs) {
    const title = cleanTitle(f.name.replace(/\.ogg$/i, ''));
    const w = wmap.get(normTitle(title));
    const lengthSec = f.length ? Math.round(parseFloat(f.length)) : (w?.lengthSec ?? null);
    if (isJingleTrack({ title, jingle: w?.jingle || false, lengthSec })) { dropped++; continue; }
    if (w?.composer) withComposer++;
    out.push({
      id: `rs3:${normTitle(title) || out.length}`,
      wiki: 'rs3',
      title,
      releaseYear: null, release: null,
      update: w?.update || null,
      members: w?.members ?? null,
      duration: fmtDuration(lengthSec),
      lengthSec,
      composer: w?.composer || null,
      location: w?.location || null,
      page: w?.page || null,
      audio: `${ARCHIVE_BASE}/${encodeURIComponent(f.name)}`,
      source: 'archive.org',
    });
  }
  out.sort((a, b) => a.title.localeCompare(b.title));
  console.log(`  [rs3] ${out.length} tracks from archive.org (${withComposer} with composer, ${dropped} jingles/stings dropped)`);
  return out;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const byWiki = {};
  if (targetWikis.includes('osrs')) {
    const osrs = await crawl(WIKIS.osrs);
    osrs.sort((a, b) => (a.releaseYear || 9999) - (b.releaseYear || 9999) || a.title.localeCompare(b.title));
    byWiki.osrs = osrs;
    await writeFile(join(DATA_DIR, 'tracks-osrs.json'), JSON.stringify(osrs, null, 0));
  }
  if (targetWikis.includes('rs3')) {
    const wikiTracks = await crawlInfoOnly(WIKIS.rs3);
    const rs3 = await buildRs3FromArchive(wikiTracks);
    byWiki.rs3 = rs3;
    await writeFile(join(DATA_DIR, 'tracks-rs3.json'), JSON.stringify(rs3, null, 0));
  }
  const all = [...(byWiki.osrs || []), ...(byWiki.rs3 || [])];
  await writeFile(join(DATA_DIR, 'tracks.json'), JSON.stringify(all, null, 0));
  const years = (byWiki.osrs || []).map(t => t.releaseYear).filter(Boolean);
  const meta = {
    generated: new Date().toISOString(),
    total: all.length,
    byWiki: Object.fromEntries(Object.entries(byWiki).map(([k, v]) => [k, v.length])),
    osrsYearRange: years.length ? [Math.min(...years), Math.max(...years)] : [null, null],
    rs3Source: 'archive.org/details/runescape-music',
  };
  await writeFile(join(DATA_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log('\nDone.', JSON.stringify(meta, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
