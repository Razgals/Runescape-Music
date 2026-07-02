# Sounds of RuneScape

A web player for the whole RuneScape soundtrack, Old School and RS3. It's styled after
the old 2005 RuneScape.com, and the player controls are made to look like an old Windows
media player. Every track streams from the wikis and the Internet Archive.

The gameplay gets all the nostalgia, but the music was just as much a part of it. Play a
few seconds of an old login theme and you are right back there. This is a place for that.

## The good part: era snapshots

RuneScape's music has been re-recorded a few times over the years, and the app knows
about it. Old School tracks carry their real per-version release dates (parsed from the
wiki's `Versions` tables), so you can pick an **era** and hear the whole library exactly
as it sounded then:

- **Original** — the 2004 to 2006 MIDI soundtrack, thin and wonderful.
- **Soundbank** — the March 2007 rework, the classic Old School sound (2007 to 2024).
- **Remastered** — the 2025 16-bit re-recordings, the current in-game sound.

Switch eras and a track like *Inspiration* plays its 2004, 2007, or 2025 version
automatically. Over 800 Old School tracks have more than one version; a picker in the
player lets you flip between them per track.

## Everything else it does

- **Two libraries** — Old School / RuneScape 2 (with the era snapshots and years) and
  RuneScape 3 (browsed as its own yearless collection).
- **Player** — play, pause, prev, next, shuffle, repeat (off / all / one), seek, volume,
  and a segmented LED equalizer that mirrors out from the centre. OS media keys work too.
- **Search and filter** — full-text search across title, update and composer; members vs
  free-to-play; a release-year range for Old School.
- **Sort** — click any column header (Track, Year, Composer, Length) to sort.
- **Favourites** — star tracks; they persist in your browser.
- **Surprise me** and **On this day** — a random pick, or tracks released on today's date.
- **Shareable URLs** — your game, era and search live in the address bar.
- **Keyboard** — `Space` play/pause, arrow keys to seek, `Shift`+arrows to skip tracks,
  `/` to jump to search.
- **A visitor counter**, because of course.

Jingles, stings and sound effects are filtered out. Around **2,180 tracks** in total
(roughly 875 Old School, 1,300 RuneScape 3).

## How it works

There is no framework and no build step. It is plain HTML, CSS and JavaScript, plus a
small Node crawler that builds the track index.

- **Old School** track data, audio and version history come from the
  [OSRS Wiki](https://oldschool.runescape.wiki).
- **RuneScape 3** audio comes from the Internet Archive
  [runescape-music](https://archive.org/details/runescape-music) collection, with
  composers and metadata matched in from the [RS3 Wiki](https://runescape.wiki).

Audio is never downloaded or bundled. The crawler only records metadata and the `.ogg`
URLs; playback streams live from the source (both send the CORS headers and support range
requests, so seeking and the visualizer work anywhere, including GitHub Pages).

## Run it locally

```bash
npm start        # serves on http://localhost:8080
```

A server is needed because browsers block `fetch()` of local JSON over `file://`. The
included `scripts/serve.mjs` has zero dependencies.

## Rebuild the track index

The index lives in `data/*.json`, pre-built so the app loads instantly. Re-crawl whenever
new music ships:

```bash
npm run refresh                          # OSRS wiki + RS3 wiki + archive.org
node scripts/build-index.mjs osrs        # just one source
node scripts/build-index.mjs --limit 60  # quick test crawl
```

## Deploy on GitHub Pages

Static site, no build step:

1. Push this repo to GitHub (public).
2. **Settings → Pages → Source: Deploy from a branch → `main` / `root`.**
3. It goes live at `https://<user>.github.io/<repo>/`.

### Keep it current, automatically

[`.github/workflows/refresh.yml`](.github/workflows/refresh.yml) re-crawls every week
(and on demand from the Actions tab), commits any changed `data/*.json`, and the push
redeploys Pages on its own. New Jagex releases show up with full metadata, no hands
needed. (Enable **Settings → Actions → Workflow permissions → Read and write** so it can
commit.)

## Project layout

```
index.html               markup
css/style.css            the 2005 RuneScape.com theme
js/app.js                player, filtering, sorting, visualizer
scripts/build-index.mjs  the crawler that builds data/*.json
scripts/serve.mjs        zero-dependency static server
data/                    the pre-built track index (generated)
assets/                  original 2005 RS.com chrome + the favourites star
font/                    the RuneScape UI fonts
```

## Credits

- Old School tracks, audio and versions — [Old School RuneScape Wiki](https://oldschool.runescape.wiki)
- RuneScape 3 composers and metadata — [RuneScape Wiki](https://runescape.wiki)
- RuneScape 3 audio — Internet Archive [runescape-music](https://archive.org/details/runescape-music) collection
- 2005 interface and fonts — [2003scape/rsc-www-archives](https://github.com/2003scape/rsc-www-archives), RuneScape UI fonts by Jagex
- Favourites star — [20xxscape.org](https://20xxscape.org)

RuneScape is a trademark of Jagex Ltd. This is a non-commercial fan project, not
affiliated with or endorsed by Jagex.
