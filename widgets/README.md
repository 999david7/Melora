# Melora desktop widgets

Now playing with play/pause, previous and next, on your desktop.

| Platform | Widget | Where it lives |
| --- | --- | --- |
| macOS | Native WidgetKit widget, small, medium and large | Built into `Melora.app`, see [the macOS guide](../macOS/README.md#desktop-widget) |
| Windows | [Rainmeter](https://www.rainmeter.net) skin | [`windows/Melora`](windows/Melora) |
| Linux (KDE Plasma 6) | Plasma widget for the desktop or a panel | [`linux/plasma/app.melora.nowplaying`](linux/plasma/app.melora.nowplaying) |
| Any platform | Mini player window | `http://127.0.0.1:4610/widget/` |

The Windows, Linux and mini player widgets work with the Node/web version of
Melora. Playback happens in the browser tab, so keep Melora open in a tab. The
widgets show what that tab is playing and send it commands.

## Windows: Rainmeter

1. Install [Rainmeter](https://www.rainmeter.net) 4.5 or newer.
2. Download `Melora-widget-windows-rainmeter.zip` from
   [Releases](https://github.com/999david7/Melora/releases) and unzip it into
   `Documents\Rainmeter\Skins\` (or copy the `widgets\windows\Melora` folder there).
3. Right-click the Rainmeter tray icon, choose **Refresh all**, then
   **Skins → Melora → NowPlaying → NowPlaying.ini**.

Drag the widget wherever you want it. Right-click it to open Melora or the mini
player. If you start Melora with `--port`, change `Server` in
`Melora\@Resources\Variables.inc`.

The buttons send commands with `curl.exe`, which comes with Windows 10 and 11.

## Linux: KDE Plasma 6

Download `Melora-widget-linux-plasma.plasmoid` from
[Releases](https://github.com/999david7/Melora/releases), then:

```bash
kpackagetool6 --type Plasma/Applet --install Melora-widget-linux-plasma.plasmoid
```

From a checkout, pass `widgets/linux/plasma/app.melora.nowplaying` instead.

Right-click the desktop or a panel, choose **Add Widgets…**, and add
**Melora Now Playing**. On a panel it shows an icon: click it to see the player,
and middle-click to skip to the next song. To use a different port, right-click
the widget and choose **Configure Melora Now Playing…**.

To update an installed copy, use `--upgrade` instead of `--install`.

## Any platform: the mini player

Open `http://127.0.0.1:4610/widget/` for a compact player you can keep in a small
window. In Chrome or Edge, use **Install page as app** (or **Apps → Install this
site as an app**) to give it its own window and a launcher or Start menu entry.
You can also open it directly as a small app window:

```bash
chrome --app=http://127.0.0.1:4610/widget/ --window-size=380,150
```

## System media controls

Melora also tells the browser what it is playing through the Media Session API.
The browser shows it in the Windows media controls (volume flyout and lock
screen), and on Linux it publishes it over MPRIS, the standard used by GNOME's
notification area, KDE's Media Player widget and most panel players. Their
play, pause, next and previous buttons work without installing a widget.

## Building your own

Any widget engine that can make HTTP requests can use Melora:

| Request | Answer |
| --- | --- |
| `GET /api/now-playing` | JSON: `locked`, `active`, `playing`, `controllable`, `track` (`title`, `artist`, `album`), `position` and `duration` in seconds, `art` (URL of a 300 px JPEG), `upNext`, `shuffle`, `repeat` |
| `GET /api/now-playing.txt` | The same as `key=value` lines in a fixed order, for engines without JSON support |
| `POST /api/remote/toggle`, `/next`, `/previous` | Sends a command to the tab that is playing. Requires the header `X-Melora-Remote: 1`. Answers `409` when Melora is not open in a browser tab. |

```bash
curl -X POST -H "X-Melora-Remote: 1" http://127.0.0.1:4610/api/remote/toggle
```

The header requirement prevents websites from controlling playback: browsers
cannot send a custom header to Melora without its permission, and Melora never
grants it. As with the rest of the library, nothing is answered while the
drive is unplugged. `/api/now-playing` then reports `"locked": true`.
