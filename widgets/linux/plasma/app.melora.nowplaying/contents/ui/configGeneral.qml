import QtQuick
import QtQuick.Controls as QQC2
import org.kde.kcmutils as KCM
import org.kde.kirigami as Kirigami

KCM.SimpleKCM {
    property alias cfg_server: server.text

    Kirigami.FormLayout {
        QQC2.TextField {
            id: server
            Kirigami.FormData.label: "Melora address:"
            placeholderText: "http://127.0.0.1:4610"
        }
        QQC2.Label {
            text: "Change this only if you started Melora with --port or --host."
            font: Kirigami.Theme.smallFont
            opacity: 0.7
        }
    }
}
