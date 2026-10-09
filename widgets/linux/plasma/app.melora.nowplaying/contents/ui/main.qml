/*
 * Melora Now Playing for KDE Plasma 6.
 *
 * Polls Melora's /api/now-playing once a second and sends play/pause/next/
 * previous to /api/remote/<command>. The X-Melora-Remote header on those
 * requests is required; it is what stops web pages from sending them.
 */
import QtQuick
import QtQuick.Layouts
import org.kde.plasma.plasmoid
import org.kde.plasma.core as PlasmaCore
import org.kde.plasma.components as PlasmaComponents
import org.kde.kirigami as Kirigami

PlasmoidItem {
    id: root

    readonly property string server: (Plasmoid.configuration.server || "http://127.0.0.1:4610").replace(/\/+$/, "")
    property var view: null
    property bool reachable: false
    property double fetchedAt: 0
    property double now: Date.now()

    readonly property bool locked: reachable && view !== null && view.locked === true
    readonly property bool active: reachable && view !== null && view.active === true
    readonly property bool playing: active && view.playing === true
    readonly property bool controllable: active && view.controllable === true
    readonly property double position: active
        ? Math.min(view.duration || 0, view.position + (playing ? (now - fetchedAt) / 1000 : 0))
        : 0

    readonly property string titleText: !reachable ? "Melora is not running"
        : locked ? "Drive not connected"
        : active ? (view.track.title || "Untitled")
        : "Nothing playing"
    readonly property string subtitleText: !reachable ? "Start it with npm start"
        : locked ? "Plug in the library drive"
        : active ? [view.track.artist, view.track.album].filter(s => s).join(" — ")
        : "Open Melora in your browser"

    toolTipMainText: titleText
    toolTipSubText: subtitleText
    Plasmoid.icon: "media-optical-audio"
    Plasmoid.status: active ? PlasmaCore.Types.ActiveStatus : PlasmaCore.Types.PassiveStatus

    function clock(seconds) {
        const total = Math.floor(seconds || 0)
        const rest = total % 60
        return Math.floor(total / 60) + ":" + (rest < 10 ? "0" : "") + rest
    }

    function poll() {
        const request = new XMLHttpRequest()
        request.onreadystatechange = () => {
            if (request.readyState !== XMLHttpRequest.DONE) return
            if (request.status === 200) {
                try {
                    root.view = JSON.parse(request.responseText)
                    root.reachable = true
                    root.fetchedAt = Date.now()
                    return
                } catch (error) {}
            }
            root.reachable = false
            root.view = null
        }
        request.open("GET", server + "/api/now-playing")
        request.send()
    }

    function send(command) {
        const request = new XMLHttpRequest()
        request.onreadystatechange = () => {
            if (request.readyState === XMLHttpRequest.DONE) refreshSoon.restart()
        }
        request.open("POST", server + "/api/remote/" + command)
        request.setRequestHeader("X-Melora-Remote", "1")
        request.send()
    }

    Timer { interval: 1000; running: true; repeat: true; triggeredOnStart: true; onTriggered: root.poll() }
    Timer { interval: 250; running: root.playing; repeat: true; onTriggered: root.now = Date.now() }
    Timer { id: refreshSoon; interval: 150; onTriggered: root.poll() }

    // On a panel: an icon that toggles playback, middle-click for next.
    compactRepresentation: MouseArea {
        acceptedButtons: Qt.LeftButton | Qt.MiddleButton | Qt.RightButton
        onClicked: (mouse) => {
            if (mouse.button === Qt.MiddleButton && root.controllable) root.send("next")
            else root.expanded = !root.expanded
        }
        Kirigami.Icon {
            anchors.fill: parent
            source: root.playing ? "media-playback-pause" : "media-optical-audio"
        }
    }

    // On the desktop, or when the panel icon is opened.
    fullRepresentation: Item {
        Layout.minimumWidth: Kirigami.Units.gridUnit * 18
        Layout.minimumHeight: Kirigami.Units.gridUnit * 6
        Layout.preferredWidth: Kirigami.Units.gridUnit * 22
        Layout.preferredHeight: Kirigami.Units.gridUnit * 7

        RowLayout {
            anchors.fill: parent
            anchors.margins: Kirigami.Units.smallSpacing
            spacing: Kirigami.Units.largeSpacing

            Rectangle {
                Layout.fillHeight: true
                Layout.preferredWidth: height
                radius: 3
                color: Qt.rgba(Kirigami.Theme.textColor.r, Kirigami.Theme.textColor.g, Kirigami.Theme.textColor.b, 0.06)
                border.color: Qt.rgba(Kirigami.Theme.textColor.r, Kirigami.Theme.textColor.g, Kirigami.Theme.textColor.b, 0.12)
                clip: true

                Kirigami.Icon {
                    anchors.centerIn: parent
                    width: parent.width * 0.4
                    height: width
                    source: "media-optical-audio"
                    opacity: 0.35
                    visible: cover.status !== Image.Ready
                }
                Image {
                    id: cover
                    anchors.fill: parent
                    fillMode: Image.PreserveAspectCrop
                    asynchronous: true
                    cache: false
                    source: root.active && root.view.art ? root.view.art : ""
                }
            }

            ColumnLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: 2

                PlasmaComponents.Label {
                    text: (!root.reachable ? "Melora" : root.locked ? "Locked" : !root.active ? "Melora" : root.playing ? "Now playing" : "Paused").toUpperCase()
                    font.family: "monospace"
                    font.pointSize: Kirigami.Theme.smallFont.pointSize * 0.9
                    font.letterSpacing: 1.4
                    opacity: 0.6
                }
                PlasmaComponents.Label {
                    Layout.fillWidth: true
                    text: root.titleText
                    font.weight: Font.Medium
                    elide: Text.ElideRight
                }
                PlasmaComponents.Label {
                    Layout.fillWidth: true
                    text: root.subtitleText
                    opacity: 0.65
                    elide: Text.ElideRight
                }

                Item { Layout.fillHeight: true }

                Rectangle {
                    Layout.fillWidth: true
                    height: 2
                    color: Qt.rgba(Kirigami.Theme.textColor.r, Kirigami.Theme.textColor.g, Kirigami.Theme.textColor.b, 0.15)
                    Rectangle {
                        height: parent.height
                        width: root.active && root.view.duration ? parent.width * Math.min(1, root.position / root.view.duration) : 0
                        color: Kirigami.Theme.textColor
                    }
                }

                RowLayout {
                    Layout.fillWidth: true
                    PlasmaComponents.Label {
                        text: root.clock(root.position)
                        font.family: "monospace"
                        font.pointSize: Kirigami.Theme.smallFont.pointSize
                        opacity: 0.6
                    }
                    Item { Layout.fillWidth: true }
                    PlasmaComponents.ToolButton {
                        icon.name: "media-skip-backward"
                        enabled: root.controllable
                        onClicked: root.send("previous")
                        PlasmaComponents.ToolTip { text: "Previous" }
                    }
                    PlasmaComponents.ToolButton {
                        icon.name: root.playing ? "media-playback-pause" : "media-playback-start"
                        enabled: root.controllable
                        onClicked: root.send("toggle")
                        PlasmaComponents.ToolTip { text: root.playing ? "Pause" : "Play" }
                    }
                    PlasmaComponents.ToolButton {
                        icon.name: "media-skip-forward"
                        enabled: root.controllable
                        onClicked: root.send("next")
                        PlasmaComponents.ToolTip { text: "Next" }
                    }
                    Item { Layout.fillWidth: true }
                    PlasmaComponents.Label {
                        text: root.clock(root.active ? root.view.duration : 0)
                        font.family: "monospace"
                        font.pointSize: Kirigami.Theme.smallFont.pointSize
                        opacity: 0.6
                    }
                }
            }
        }
    }
}
