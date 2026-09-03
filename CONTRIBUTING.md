# Contributing

Thanks for taking a look.

## Getting set up

```bash
npm install
npm test
```

The tests build real libraries in temporary directories with real audio files
and tear them down afterwards. They touch nothing outside `os.tmpdir()`, and
they point `MELORA_HOME` at a scratch directory so your own pairing is never
read or written.

To try changes by hand, make a fake drive anywhere:

```bash
mkdir -p /tmp/fake-drive
MELORA_HOME=/tmp/melora-dev node src/cli.js init /tmp/fake-drive/Music --label "Fake drive"
MELORA_HOME=/tmp/melora-dev node src/cli.js sync ~/Music
MELORA_HOME=/tmp/melora-dev node src/cli.js serve
```

Deleting `/tmp/fake-drive/Music/.melora-library.json` simulates yanking the
drive; putting it back simulates plugging it in again. That is exactly how the
tests do it, and it is the quickest way to check that the lock still engages
mid-song.

## Things to keep true

These are the properties the project exists for. A change that breaks one of
them needs a good argument.

1. **Nothing about the music lives on the internal disk.** The index, the
   artwork cache and the trash go on the drive. Audio and cover responses are
   sent with `Cache-Control: no-store` so the browser does not build its own
   copy; seeking costs a range request instead.
2. **The lock covers metadata too.** Track titles, artist names and counts are
   as revealing as the audio. Every route that touches them sits behind the
   gate in `src/server.js`.
3. **Your audio files are never written to.** Melora reads tags; it does not
   edit them. Editable state — a favourite, a note, a play count — lives in the
   index, so it cannot disagree with the file you would still have if this
   program disappeared. Deleting moves a file into `.melora/trash/`; nothing is
   ever unlinked. Sync sources are opened read-only.
4. **No network.** No fonts, scripts, styles or images from anywhere but the
   local server. No telemetry, no update checks, no API keys, no scrobbling.
5. **The library is portable and self-describing.** Someone with the drive and
   no copy of this program should still find their music in ordinary folders
   and their playlists in ordinary `.m3u8` files.
6. **No build step for the front end.** `public/` is plain HTML, CSS and ES
   modules; a contributor should be able to edit a file and reload the page.

## Style

Match what is already there. The code favours explanatory comments where a
decision is not obvious from the lines themselves, and skips them where it is.

If you add a dependency, check its license first and add it to
`THIRD_PARTY_NOTICES.md`. Permissive only (MIT, ISC, BSD, Apache-2.0) — a
copyleft dependency changes what people can do with the project.

## Pull requests

Include a test when you fix a bug. `npm test` must pass. Small and focused
beats large and sweeping.
