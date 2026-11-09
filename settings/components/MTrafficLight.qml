import QtQuick
import ".."

// macOS traffic light button (12px circle, glyph appears on hover).
Item {
    id: root

    property color tone: Theme.red
    property string glyph: "close"
    property bool enabled: true

    signal clicked()

    width: 12
    height: 12

    Rectangle {
        anchors.fill: parent
        radius: 6
        color: root.enabled ? root.tone : "#4a4a52"
        border.width: 0.5
        border.color: Qt.rgba(0, 0, 0, 0.19)
    }

    MIcon {
        anchors.centerIn: parent
        visible: lightMouse.containsMouse && root.enabled
        kind: root.glyph
        size: 8
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
