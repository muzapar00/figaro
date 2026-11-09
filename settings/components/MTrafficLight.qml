import QtQuick
import ".."

// macOS traffic light button. Size is configurable (settings GUI reads
// ui.windowButtonSize, default 16px; the old hardcoded size was 12px).
Item {
    id: root

    property color tone: Theme.red
    property string glyph: "close"
    property bool enabled: true
    property int size: 16

    signal clicked()

    width: size
    height: size

    Rectangle {
        anchors.fill: parent
        radius: root.size / 2
        color: root.enabled ? root.tone : "#4a4a52"
        border.width: 0.5
        border.color: Qt.rgba(0, 0, 0, 0.19)
    }

    MIcon {
        anchors.centerIn: parent
        visible: lightMouse.containsMouse && root.enabled
        kind: root.glyph
        size: Math.max(7, Math.round(root.size * 0.55))
        color: Qt.rgba(0, 0, 0, 0.53)
    }

    MouseArea {
        id: lightMouse
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: root.enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
        onClicked: {
            if (root.enabled) root.clicked();
        }
    }
}
