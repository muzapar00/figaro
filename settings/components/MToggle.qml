import QtQuick
import ".."

// macOS (Big Sur+) switch: 40x24 capsule, white knob, green when on.
Item {
    id: root

    property bool checked: false
    property bool interactive: true
    signal toggled(bool value)

    implicitWidth: 40
    implicitHeight: 24

    Rectangle {
        id: track
        anchors.fill: parent
        radius: height / 2
        color: root.checked ? Theme.green : Theme.toggleOff
        Behavior on color {
            ColorAnimation { duration: 120 }
        }
    }

    Rectangle {
        id: knob
        width: 20
        height: 20
        radius: 10
        y: 2
        x: root.checked ? parent.width - width - 2 : 2
        color: "#f7f7fa"
        Behavior on x {
            NumberAnimation { duration: 140; easing.type: Easing.OutCubic }
        }
        Rectangle {
            anchors.fill: parent
            radius: parent.radius
            color: Qt.rgba(0, 0, 0, 0.13)
            anchors.margins: -1
            z: -1
            visible: false
        }
    }

    MouseArea {
        anchors.fill: parent
        cursorShape: root.interactive ? Qt.PointingHandCursor : Qt.ArrowCursor
        onClicked: {
            if (!root.interactive) return;
            root.checked = !root.checked;
            root.toggled(root.checked);
        }
    }
}
