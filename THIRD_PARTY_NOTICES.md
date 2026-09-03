# Third-party notices

Melora itself is MIT licensed (see `LICENSE`). This file records what it
depends on and what that means if you publish, fork, or redistribute it.

## Direct dependencies

| Package | License | Why it is here |
| --- | --- | --- |
| [express](https://github.com/expressjs/express) | MIT | The local HTTP server, including range requests for audio |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | MIT | The index database (SQLite itself is public domain) |
| [music-metadata](https://github.com/Borewit/music-metadata) | MIT | Reading tags, durations and embedded cover art |
| [sharp](https://github.com/lovell/sharp) | Apache-2.0 | Rendering and caching cover art |

Everything pulled in transitively is MIT, ISC, Apache-2.0 or BSD, with one
exception, described next.

## libvips (LGPL) — the one thing worth understanding

`sharp` does not do image processing itself. It calls **libvips**, which npm
installs as a separate prebuilt package (`@img/sharp-libvips-<platform>`) and
which is licensed **LGPL-3.0-or-later**.

This is fine for an MIT project, and here is precisely why:

- libvips is a **shared library** (`libvips-cpp.so.42` / `.dylib` / `.dll`) that
  sharp loads at runtime. The LGPL's conditions on derived works are not
  triggered by dynamic linking of this kind.
- It arrives as its **own npm package with its own license file**. Melora's
  repository contains no libvips code, and this repository is not a combined
  work.
- Your code stays MIT. Anyone receiving Melora can replace the libvips build
  with their own, which is the freedom the LGPL exists to protect.

**When you would need to do something about it:** if you ever ship Melora as a
*single self-contained binary or installer* that bundles libvips (via `pkg`,
Electron, a Docker image you distribute, an App Store build), you should
include libvips' LGPL notice in your distribution and keep users able to
substitute their own build of it. Publishing the source on GitHub, or
publishing to npm where libvips installs itself as a dependency, requires
nothing extra.

If you would rather avoid the question entirely, sharp is used in exactly one
place — `src/art.js` — and only to resize an image. Swapping it for a different
renderer, or serving cover art at its original size with no resizing at all, is
a contained change. Nothing about playback depends on it.

## Codecs and patents

Melora bundles no audio codecs and decodes no audio itself.

- Playback is handled entirely by the **browser's own `<audio>` element**. Melora
  streams bytes off the drive; which formats decode is a property of the
  browser you happen to be using, not of anything shipped here.
- Formats the browser cannot decode are indexed and listed rather than hidden,
  and the interface says they cannot be played instead of failing silently.
- `music-metadata` is a pure-JavaScript **parser**. It reads tag headers and
  frame headers to work out the title and the length; it does not decode audio.
- Cover art is re-encoded as **WebP**, which is royalty-free and BSD-licensed.
  The prebuilt libvips that sharp installs does not include HEVC, so no
  patent-encumbered encoder is distributed.

## What Melora does not do

Relevant if you are weighing up publishing this:

- **No API keys, accounts, or third-party services.** There is nothing to
  configure and no secret to leak in a commit. No MusicBrainz lookups, no
  cover-art downloads, no scrobbling.
- **No network requests, at all.** The server talks to your browser over
  loopback; the page loads no fonts, scripts, styles or images from anywhere
  but itself. You can verify this with the browser's network tab, or by
  unplugging your internet.
- **No telemetry, analytics, or crash reporting.**
- **No listening history beyond a play count.** Melora records how many times a
  track has been played and when it was last played, both in the index on the
  drive, because the interface offers to sort by them. Nothing leaves the
  machine, and pulling the drive takes the history with it.
- **No writes to your audio files.** Tags are read out of them and cached in
  the index. Nothing in this codebase opens an audio file for writing.
- **No bundled media.** Every icon in the interface is an SVG path in
  `public/index.html`, written for this project.
