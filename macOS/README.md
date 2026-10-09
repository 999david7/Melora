# Melora for macOS

A native SwiftUI music library and AVFoundation player for macOS 14 or later.
No browser, Node server, account, or subscription is required.

## Build and launch

Install Apple's Command Line Tools (`xcode-select --install`) or Xcode, then:

```sh
cd macOS
./scripts/build-app.sh
open dist/Melora.app
```

Drag `dist/Melora.app` into Applications if you want to keep it there. The script
builds for your Mac's architecture, creates the icon and signs the app locally.
Distribution to other Macs requires Developer ID signing and notarization.
You can also open `Package.swift` in Xcode to develop the app.

Download a DMG from [GitHub Releases](https://github.com/999david7/Melora/releases),
open it, and drag Melora onto the Applications shortcut. To create a DMG locally:

```sh
MELORA_UNIVERSAL=1 ./scripts/build-app.sh
./scripts/create-dmg.sh
```

The universal DMG contains both Apple Silicon and Intel code. Omitting
`MELORA_UNIVERSAL=1` builds a smaller app for your Mac's architecture.

## App updates and releases

Melora checks this repository's latest stable GitHub release at launch and every
six hours. When a newer version is available, it offers **Install & Restart**;
choosing **Later** leaves the current app running. Use **Melora → Check for
Updates…** or the update section in Settings to check immediately. Checks and
installation wait while music imports are running. Music and playlists are kept
outside the app and are preserved during installation.

The installer chooses the ZIP for the running app's architecture, verifies its
GitHub SHA-256 digest, bundle identity, version, macOS requirement and code
signature, and replaces the app after it exits. If the replacement cannot be
launched, the installer restores the previous app. The app and its containing
folder must be writable. Releases without a compatible app ZIP offer the release
page instead.

To publish a new version, push a tag such as `v1.0.1` on the desired commit:

```sh
git tag v1.0.1
git push origin v1.0.1
```

The `macOS release` GitHub Actions workflow builds Apple Silicon and Intel apps,
sets their bundle versions from the tag, and uploads architecture-specific ZIPs
for in-app updates and DMGs for installation before publishing the release. GitHub computes the asset
digests used by the installer. These builds use local ad-hoc signatures; the
workflow does not provide Developer ID signing or notarization.

## Import music

Press **Import a link** (⌘N), paste one or more HTTP(S) links, and import.
Direct audio downloads use URLSession. Video/music pages use
[yt-dlp](https://github.com/yt-dlp/yt-dlp), with FFmpeg converting audio to M4A
and saving a cover image. Supported sites depend on yt-dlp; protected streams,
subscription-only media and arbitrary webpages are not guaranteed to work.
Only import media you have permission to download.

YouTube playlist links work in the same import dialog, including video links
that contain a `list=` parameter. Watch links with an automatically generated
YouTube Mix (`RD…`) import the selected song rather than an inaccessible radio
playlist page. Melora creates a local playlist with the
YouTube name, downloads audio and cover art, and opens it in source order via
**ORDER**. Already downloaded YouTube videos are reused, including videos
previously imported through a shortened link. Reimporting the same source uses
the existing local playlist.

Private, deleted and failed videos are listed under **Downloads**. Other tracks
continue importing. **Retry** tries missing tracks again and reuses successful
imports. Cancelling retains completed downloads and the partial playlist.
Playlists must be accessible without signing in (public or unlisted).

Spotify track, album and public playlist links are also accepted, including
localized and embed links. Melora reads public Spotify catalogue metadata,
checks title, artist and duration against YouTube candidates, downloads a
matching recording, and saves Spotify names and cover art in the local library.
This downloads YouTube audio, not Spotify streams. Versions can differ and
uncertain matches are reported as failures instead of importing an arbitrary hit.
**Open original link** returns to the Spotify track; the download's video metadata
is retained alongside the audio file.

Spotify can expose only a subset of large collections on public pages. The app
checks the full track count and records unexposed entries under **Downloads**;
these are never silently counted as imported. An optional spotDL reader tries
to obtain the complete catalogue, with a timeout before falling back to public
metadata. Your library retains successful tracks and their source order. Retry
reuses completed downloads. Private playlists and shortened share links require
a full, accessible `open.spotify.com` link.

Settings offers **Install full playlist reader** (Homebrew uv + an isolated
Python 3.12 spotDL tool). Video tools are enough for public-page matching.
The executable search also checks `~/.local/bin` for tools installed with uv.

Set up video downloads in Settings using **Install tools with Homebrew**, or:

```sh
brew install yt-dlp ffmpeg deno
```

The app finds tools in `/opt/homebrew/bin`, `/usr/local/bin`, its bundled
`Contents/Helpers` directory, or PATH. Deno (or an installed Node runtime)
is used when available for sites requiring JavaScript extraction. Tools are
not bundled into the application. Keeping yt-dlp up to date helps when sites change.

Downloads run one at a time, with progress, cancellation and retry under
**Downloads**. Repeated identical links are skipped. Jobs are session-only;
failed jobs can be retried while the app is open. Interrupted staging files
are never listed as completed songs. Audio is validated before it joins the library.

Use **Add files** (⌘O) for existing playable audio. Embedded artwork is read
when present. Video imports use the source's thumbnail; missing artwork gets
a neutral disc placeholder. The app does not claim to identify official album art
when the source only provides a video thumbnail.

## Desktop widget

Melora includes a **Now Playing** widget in small, medium and large sizes. Open
Melora once, then right-click the desktop, choose **Edit Widgets…** and search
for Melora. It shows the song, artist, cover and progress, with play/pause
(all sizes), previous and next (medium and large) and the next songs (large).
Clicking elsewhere on the widget opens Melora.

The widget is a sandboxed extension that can only read
`~/Library/Application Support/Melora/Widget/`, where Melora writes the current
song and a small cover. Its buttons work while Melora is running; quitting
Melora shows the widget as stopped.

`scripts/build-app.sh` builds the widget into `Melora.app/Contents/PlugIns/`.
The buttons rely on App Intents metadata, which the script generates with
`appintentsmetadataprocessor` from Xcode. With only the Command Line Tools,
the widget still shows what is playing but its buttons do not respond.

## Your library

Default location: `~/Music/Melora`. Settings lets you choose an existing native
library or a new folder, including an external drive. Switching folders opens
that folder's collection; it does not migrate the previous collection.

```
Melora/
  library.json              # metadata and favourites
  Music/<track UUID>/       # audio, artwork and video metadata
  .incoming/                # temporary imports
```

Paths in the index are relative, so the folder can be moved as a unit. Source
files are copied, never changed. **Remove from library** keeps the audio on
disk; **Show in Finder** reveals it. A damaged index is reported and preserved.
The native index is separate from the original Node/SQLite library. Add audio
files from your existing collection to import them into the native app.

The interface follows the original web player: white paper, thin rules,
monospaced controls, folder/playlist sidebar and a compact transport bar.
Tracks, albums, artists, favourites, artist/album/title search, saved playlists,
play queue, shuffle,
repeat, volume and seeking are included. Media keys and macOS Now Playing
controls are supported. Playback and library browsing work offline after import. Starting a song opens
a right-side **Now Playing** panel with large cover art, track details, live time,
seeking and playback controls. Click the bottom player's cover to toggle it.
The panel and bottom player share the same playback position; the queue remains
available from either player surface.

The moon button sets a **sleep timer** for 15–90 minutes or the end of the
current song. The Now Playing panel shows the remaining time. Expiry pauses
playback; the end-of-song option takes priority over repeat and shuffle.
Cancel the timer from the same menu. Timers apply only while Melora is open.

Playlists support **Rename** and **Duplicate** from their page or sidebar
context menu. Right-click a playlist song to move it up/down or remove it
from that playlist. Choose **ORDER** to see the saved sequence. Removing a
playlist entry keeps its music in the library; a duplicated playlist is
independent of the original YouTube source.

Playback shortcuts: **⌘⇧S** toggles shuffle, **⌘⇧R** cycles repeat, and
**⌘⇧M** toggles mute while remembering the previous volume. The speaker
button also toggles mute. **⌘P** plays/pauses and **⌘← / ⌘→** changes songs.

Search accepts words in any order across titles, artists and albums, ignores
extra whitespace and accents, and has a clear button. **⌘F** focuses search;
**Escape** clears the query, then releases focus when it is already empty.
Long track details are available in hover tooltips. Playlist headers show their
combined duration, and repeated duplicates receive distinct names.

Volume (including mute's restore level), shuffle and repeat are remembered
between launches. Shuffle visits every song once per pass; repeat-all starts a
new pass, and Previous retraces the actual shuffle history. Closing Now Playing
keeps it closed during song changes and pause/resume; the cover button reopens it.

## Tests

```sh
./scripts/test.sh
```

Tests exercise link validation, path and symlink containment, subprocess errors
and cancellation, local HTTP download/import, duplicate detection, persistence,
favourites, failed-download cleanup and preservation of corrupted indexes.
Playlist tests cover source order, unavailable entries, shortened-link reuse,
partial failures, retries, cancellation and persistence.
The HTTP fixture uses the system Python 3 and never contacts a music service.

Feature tests cover playlist edits and copy independence, sleep timer replacement,
cancellation and expiry, end-of-song repeat priority, and restoring muted volume.

Refinement tests cover forgiving search, shuffle exhaustion and history, repeat
cycles, preference restoration, and unique playlist copy names.

Spotify tests cover URL normalization, metadata and cover selection, public-page
limits, conservative audio matching, partial imports and retry reuse. A separate
opt-in live check validates the supplied public playlist and imports its first
song into a temporary folder without altering the user library:

```sh
MELORA_CHECK_SPOTIFY="https://open.spotify.com/playlist/4K7czdqhWnjDxaHJa71jWl" ./scripts/test.sh --filter SpotifyTests/livePublicPlaylistMetadataAndFirstTrackMatch
```

Spotify matching normalizes soundtrack annotations and piano-version labels,
searches up to ten results with a second query when necessary, prefers the
performer's own channel, and excludes tutorials and recordings merely credited
to their arrangement. Artist and duration checks still apply, as do explicit
live/remix/acoustic/instrumental versions. If a candidate cannot download, the
importer tries other confident matches. Regression fixtures cover twelve songs
from the supplied Patrik Pietschmann playlist.

Video downloads prefer native M4A audio. If YouTube refuses the direct stream
with HTTP 403, Melora retries an available segmented audio stream before reporting
the failure.
