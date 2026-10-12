# Melora

**Native macOS app:** Melora now includes a standalone SwiftUI app with music
link downloads, cover art, offline playback, search and favourites. Build it with
`cd macOS && ./scripts/build-app.sh`, then open `dist/Melora.app`.
See [the macOS guide](macOS/README.md) for setup and supported imports.
The macOS app checks GitHub releases and offers to install newer versions.
Version tags build release downloads for Apple Silicon and Intel automatically.

The documentation below describes the original cross-platform Node/web version.

A music library that lives on your external SSD and stays locked until that
exact drive is plugged in.

Runs entirely on your own machine. No account, no API keys, no network calls,
no cloud, no streaming service. Plug the drive in and your records are there;
pull it out and the library goes dark — because the music, the artwork, the
playlists and the index all live on the drive, and the only thing left on your
computer is a note saying which drive to look for.

```
melora init /Volumes/Archive/Music --label "Archive SSD"
melora sync ~/Music
melora serve          # → http://127.0.0.1:4610
```

## What it does

- **Locks itself to one drive.** The library is identified by a marker file at
  its root, not by a mount path, so it keeps working when macOS mounts the
  drive as `/Volumes/Archive 1` or Windows hands it a different letter. The
  library appears when the drive appears — usually within a few seconds — and
  the interface falls back to a lock screen the moment it is unplugged, mid-song
  if that is when you pull it.
- **Plays your collection.** Albums, artists, folders, favourites, a queue,
  shuffle and repeat, seeking, and the keyboard shortcuts you already know.
  Audio is streamed off the drive a range at a time and never cached to your
  internal disk.
- **Keeps playing when the queue runs out.** Autoplay follows the last track
  with a similar one from your library — same artist first, then genre, the
  playlists you made, era and folder. It reads only the index on the drive and
  asks no outside service. Repeat still takes precedence, and autoplay can be
  switched off in **Settings**.
- **Folders, as real folders.** The tree in the sidebar mirrors actual
  directories on the drive. Browse the same structure in Finder or Explorer;
  nothing is hidden inside a database you can't read.
- **Playlists are `.m3u8` files.** They sit in `Playlists/` on the drive with
  relative paths, so VLC, foobar2000, Rockbox and a car stereo can all read
  them, and they travel with the drive. A playlist made in another program
  turns up here after a scan.
- **Reads your tags, never writes them.** Title, artist, album artist, album,
  track and disc numbers, year, genre, length, bitrate and embedded cover art
  come out of the files themselves. Melora never opens an audio file for
  writing. Fix a bad tag in a tag editor and rescan.
- **One-way sync from your computer.** Point Melora at `~/Music` and it copies
  new tracks onto the drive, filed into `Artist/Album/` (or mirroring your
  layout, or all into one folder — your choice), bringing the `cover.jpg` with
  them. Duplicates are caught by content hash, so importing the same folder
  twice does nothing. **Source folders are only ever read.** Nothing in them is
  moved, renamed or deleted.
- **Verifies itself.** The index stores a SHA-256 for every file, so Melora can
  re-hash the whole library and tell you if a file has silently rotted or gone
  missing. A FLAC that has lost a block still plays right up to the damage,
  which is exactly why you want to hear about it before your only copy is the
  broken one.
- **Survives you reorganising it.** Move a track into a different folder in
  Finder and the next scan follows it by content hash, keeping its favourite,
  its note, its play count, and its place in every playlist.

## Download

Every [release](https://github.com/999david7/Melora/releases) has ready-made
builds of this web version that include Node.js, so nothing else needs
installing:

- **Windows:** `Melora-windows-x64.zip`. Unzip it and double-click `Melora.exe`.
- **Linux:** `Melora-linux-x64.tar.gz` or `Melora-linux-arm64.tar.gz`. Extract
  it and run `./melora`.

Started with no arguments, the executable runs the server and opens the
interface in your browser. With arguments it is the `melora` command, so
`Melora.exe init E:\Music` and `./melora sync ~/Music` work. Keep the `app`
folder next to the executable. On macOS, use the native app instead.

To build one yourself, run `node packaging/build-portable.mjs` with an official
Node.js 24 build (Homebrew's Node can't make single executables). It packages
for the computer it runs on and writes the archive to `dist-portable/`.

## Install

Needs [Node.js](https://nodejs.org) 20.11 or newer.

```bash
git clone https://github.com/999david7/Melora.git
cd Melora
npm install
```

On Windows there is nothing to type: double-click `start.bat`. It installs the
dependencies the first time, starts the server and opens the interface once it
is answering. Arguments are passed through, so `start.bat --port 5000` works.

## Set up

Plug in the drive, then create the library on it:

```bash
node src/cli.js init /Volumes/Archive/Music --label "Archive SSD"
```

On Linux that path is usually `/media/<you>/<drive>/...`, on Windows
`E:\Music`. Pointing `init` at a folder that already holds a Melora library
pairs with it instead of creating a new one — that is how you use the same
drive from a second computer.

Then start it:

```bash
npm start          # → http://127.0.0.1:4610
```

or on Windows, double-click `start.bat`.

You can also do the whole setup in the browser: run `npm start` first and the
page walks you through picking a folder, with shortcuts to wherever your system
mounts removable drives.

## Getting music in

Either drop files into the folders on the drive yourself and press **Scan**, or
let Melora copy them in:

```bash
node src/cli.js sync ~/Music
node src/cli.js sync ~/Downloads/rips --into "New" --organize mirror
```

Add source folders in **Settings** and the **Sync** button imports from all of
them. `--organize` takes `artist` (the default, `Imported/Talk Talk/Spirit of
Eden/`), `mirror` (keeps your folder layout) or `flat`.

Every copy is verified by re-reading it off the drive and comparing hashes, so
a bad cable or a full disk fails loudly instead of leaving you a truncated
track you won't notice for two years.

## Commands

| Command | What it does |
| --- | --- |
| `melora init <folder>` | Create a library on the drive and pair with it |
| `melora attach <folder>` | Pair with a library that already exists |
| `melora serve` | Start the web interface |
| `melora status` | Where the drive is and what is in the library |
| `melora scan` | Reconcile the index with the files on the drive |
| `melora sync [folder]` | Copy new music in from your sources |
| `melora verify` | Re-hash every file and report anything that changed |
| `melora prune` | Forget index entries whose files are gone |
| `melora forget` | Unpair this computer; nothing on the drive changes |

Run them as `node src/cli.js <command>`, or `npm link` once to get a `melora`
command on your `PATH`.

## Keyboard

`Space` plays and pauses. `←` `→` seek five seconds; hold `Shift` to change
track, or use `N` and `P`. `F` favourites what is playing, `S` shuffles, `M`
mutes, `Q` shows the queue, `/` jumps to search, `Esc` closes.

## Desktop widgets

Melora shows what is playing, with play/pause, previous and next, in desktop
widgets: a [Rainmeter](https://www.rainmeter.net) skin on Windows, a KDE Plasma
widget on Linux, and a mini player window at `http://127.0.0.1:4610/widget/` on
any system. It also appears in the system media controls (the Windows media
flyout and MPRIS on Linux). See [the widgets guide](widgets/README.md) for setup.
The native macOS app has its own WidgetKit widget.

## Cover art

Melora looks inside the file first — an embedded picture is what the person who
made the file chose, and it is right even when one folder holds several albums.
Failing that it takes `cover.jpg`, `folder.jpg`, `front.jpg` or `album.jpg`
from the folder, or a lone image if that is all there is. Drop artwork into an
album folder and press **Scan**: covers are reconciled separately from the
audio, so adding a picture is noticed even though no track changed.

Rendered covers are cached as WebP in `.melora/cache/` **on the drive**, keyed
by content hash, so a whole album shares one rendering and replacing the
artwork misses the cache instead of serving the old picture forever.

## Playlists

A playlist is a UTF-8 `.m3u8` file in `Playlists/` on the drive:

```
#EXTM3U
#PLAYLIST:Late night
#EXTINF:559,Talk Talk - The Rainbow
../Talk Talk/Spirit of Eden/01 The Rainbow.wav
```

Paths are relative to the playlist file, so the drive can be mounted anywhere
and copied to anyone. The files are the source of truth; the index mirrors them
so the interface can query them, and a scan reconciles the two in both
directions. An entry pointing at a file that is not there keeps its place in
the list, marked, rather than quietly disappearing — and renaming a folder
inside Melora rewrites the playlists that reach into it.

Entries that point outside the library, or at a URL, are ignored rather than
followed.

## How the locking works, honestly

Melora writes a `.melora-library.json` file at the root of your library
containing a random id. Your computer stores that id in
`~/.melora/config.json`. Every few seconds Melora checks whether a folder
carrying that id is reachable; when it isn't, the server refuses every request
for audio, artwork, a track title, an artist or a count with `423 Locked`, and
the interface shows a lock screen.

**This is a "not without the drive" guarantee, not an encryption guarantee.**
Anyone holding the drive can play the music on it, because they are ordinary
files in ordinary folders — which is deliberate, so your collection outlives
this program. If you want the contents unreadable without a key, put the
library on an encrypted volume (FileVault, LUKS, BitLocker, VeraCrypt) and let
Melora sit on top of it. The two work together well: the encrypted volume
protects the music, Melora keeps it off your internal disk and out of your
library when the drive is away.

What Melora *does* guarantee is that nothing about your music is left behind on
the computer. The index, the artwork cache and the trash all live in `.melora/`
on the drive. Audio and cover responses are sent with `Cache-Control: no-store`
so the browser does not quietly build a copy of your library in its own disk
cache — seeking costs a range request against the drive instead. The only local
file is the pairing.

## Where everything lives

```
<your drive>/Music/
├── .melora-library.json       the marker that identifies this library
├── .melora/
│   ├── index.db               SQLite: tracks, tags, playlists, hashes
│   ├── cache/                 rendered cover art (WebP)
│   └── trash/                 deleted tracks, by date — never erased
├── Playlists/
│   └── Late night.m3u8        ordinary M3U, readable by anything
├── Talk Talk/
│   └── Spirit of Eden/
│       ├── 01 The Rainbow.flac
│       └── cover.jpg
└── Imported/…
```

`~/.melora/config.json` on your computer holds the drive id, its label, where
it was last seen, and your sync sources. Delete it and you lose nothing but the
pairing — `melora attach` puts it back.

## Deleting things

"Move to trash" moves the file into `.melora/trash/<date>/` on the drive. It is
never unlinked. To actually free the space, delete that folder yourself once
you're sure. `melora prune` only forgets index rows for files that are already
gone; it never touches a file.

## Safety notes

- The server listens on `127.0.0.1` only. It has no login of its own, so if you
  change the host to expose it on your network, anyone who can reach that
  address can play your library. It will warn you when you do.
- Requests are rejected unless the `Host` header is local, which closes off DNS
  rebinding from a page you have open in another tab.
- The page runs under a strict Content-Security-Policy and loads nothing
  external.

## File formats

MP3, M4A/AAC, ALAC, FLAC, Ogg Vorbis, Opus, WAV and AIFF play in any current
browser. Formats no browser can decode — WMA, APE, WavPack, Musepack, DSD,
tracker modules — are **indexed, counted, searchable and listed** with their
tags; they simply cannot be played from this interface, and the row says so
rather than failing silently when you press play. The files are still on the
drive, and any desktop player will open them.

Which of the playable formats actually decode depends on your browser, not on
Melora. Safari plays ALAC; Chrome and Firefox do not.

## Development

```bash
npm test        # 126 tests, no network, no fixtures to download
```

The tests build real libraries in temp directories with real audio files —
genuine RIFF/WAVE with a genuine tag block, and a genuine MPEG stream behind a
genuine ID3v2 tag with embedded cover art — then do things like delete the
marker file mid-run to check that the lock actually engages.

```
src/
├── volume.js    finding the drive, and noticing when it leaves
├── db.js        schema
├── audio.js     formats, hashing, reading tags
├── art.js       cover art: finding it, rendering it, caching it
├── library.js   folders, tracks, albums, artists, playlists, search
├── playlists.js reading and writing the .m3u8 files on the drive
├── scanner.js   reconciling the index with the disk; verify
├── sync.js      importing from your computer
├── server.js    HTTP, streaming, and the lock that gates all of it
└── cli.js
public/
├── index.html   markup and the inline SVG icon set
├── styles.css   the whole theme, driven by tokens at the top of the file
├── player.js    the audio element, the queue, shuffle and repeat
├── app.js       views, lists, the transport, polling
└── ui.js        DOM helpers, dialogs, formatting
```

There is no bundler, no transpiler and no framework. Edit a file in `public/`,
reload the page.

The interface is deliberately monochrome and typographic: paper ground,
hairline rules, uppercase letterspaced monospace for every piece of chrome,
light display type for anything that is actual content. Colour is reserved —
gold marks a favourite, red marks a destructive action, and nothing else is
tinted, so album covers are the only saturated thing on screen.

Every colour, rule weight and dimension is a custom property in `:root` at the
top of `styles.css`; restyling means editing that block, not hunting through
rules. Type comes from system font stacks because the page must not fetch
anything over the network — if you want the display face to look closer to a
designed specimen, drop a `.woff2` into `public/`, add an `@font-face` block,
and point `--sans` at it. That stays entirely offline.

`public/player.js` knows nothing about the DOM beyond the `<audio>` element:
everything that shows what is playing subscribes to it and re-renders, which
keeps the transport, the track list and the queue from each having their own
idea of the truth.

## License

MIT — see [LICENSE](LICENSE). Dependency licenses and the one LGPL component
worth understanding before you redistribute are covered in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
