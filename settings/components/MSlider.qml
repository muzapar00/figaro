import QtQuick
import ".."

// macOS-style slider: 4px track, white 18px knob, value written on release.
Item {
    id: root

    property real from: 0
    property real to: 100
    property real value: 0
    property bool interactive: true
    property color fillColor: "#f2f2f7"

    signal moved(real value)

    implicitWidth: 180
    implicitHeight: 24

    readonly property real ratio: root.to === root.from ? 0 : Math.max(0, Math.min(1, (root.value - root.from) / (root.to - root.from)))
    readonly property real usable: Math.max(0, root.width - knob.width)

    function valueAt(x) {
        const r = Math.max(0, Math.min(1, (x - knob.width / 2) / root.usable));
        return root.from + r * (root.to - root.from);
    }

    Rectangle {
        id: track
        anchors.verticalCenter: parent.verticalCenter
        width: parent.width
        height: 4
        radius: 2
        color: Theme.toggleOff
    }

    Rectangle {
        anchors.verticalCenter: parent.verticalCenter
        height: 4
        radius: 2
        width: knob.x + knob.width / 2
        color: root.fillColor
        opacity: root.interactive ? 1.0 : 0.55
    }

    Rectangle {
        id: knob
        width: 18
        height: 18
        radius: 9
        anchors.verticalCenter: parent.verticalCenter
        x: root.ratio * root.usable
        color: "#f7f7fa"
        border.width: 0.5
        border.color: Qt.rgba(0, 0, 0, 0.20)
    }

    MouseArea {
        anchors.fill: parent
        enabled: root.interactive
        cursorShape: root.interactive ? Qt.PointingHandCursor : Qt.ArrowCursor
        onPressed: (mouse) => {
            root.value = root.valueAt(mouse.x);
        }
        onPositionChanged: (mouse) => {
            if (pressed) root.value = root.valueAt(mouse.x);
        }
        onReleased: root.moved(root.value)
    }
}
