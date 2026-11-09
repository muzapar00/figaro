import QtQuick
import ".."

// macOS push button (28px tall, 7px radius, subtle raised fill).
Rectangle {
    id: root

    property string text: ""
    property string icon: ""
    property bool primary: false
    property bool danger: false
    property bool enabled: true
    property int iconSize: 13

    signal clicked()

    implicitWidth: Math.max(root.icon.length > 0 || root.text.length > 0 ? 0 : 24,
                            contentRow.implicitWidth + 26)
    implicitHeight: Theme.controlH
    radius: 7
    color: {
        if (!root.enabled) return Theme.controlBg;
        if (root.danger) return mouse.containsMouse ? "#e0433a" : "#c93a31";
        if (root.primary) return mouse.containsMouse ? "#2f9bff" : Theme.accent;
        return mouse.containsMouse ? Theme.controlBgHover : Theme.controlBg;
    }
    border.width: root.primary || root.danger ? 0 : 0.5
    border.color: Qt.rgba(1, 1, 1, 0.08)
    opacity: root.enabled ? 1 : 0.5

    Behavior on color {
        ColorAnimation { duration: 90 }
    }

    Row {
        id: contentRow
        anchors.centerIn: parent
        spacing: root.icon.length > 0 && root.text.length > 0 ? 6 : 0

        MIcon {
            visible: root.icon.length > 0
            kind: root.icon
            size: root.iconSize
            color: root.primary || root.danger ? "#ffffff" : Theme.text
            anchors.verticalCenter: parent.verticalCenter
        }
        Text {
            visible: root.text.length > 0
            text: root.text
            color: root.primary || root.danger ? "#ffffff" : Theme.text
            font.family: Theme.fontSans
            font.pixelSize: Theme.fs
            anchors.verticalCenter: parent.verticalCenter
        }
    }

    MouseArea {
        id: mouse
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: root.enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
        onClicked: {
            if (root.enabled) root.clicked();
        }
    }
}
