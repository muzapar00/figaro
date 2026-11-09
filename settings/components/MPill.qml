import QtQuick
import ".."

// macOS-style status capsule, used for connection/service state.
Rectangle {
    id: root

    property string text: ""
    property color tone: Theme.textDim
    property bool dot: true

    implicitWidth: row.implicitWidth + 16
    implicitHeight: 20
    radius: 10
    color: Qt.rgba(root.tone.r, root.tone.g, root.tone.b, 0.16)

    Row {
        id: row
        anchors.centerIn: parent
        spacing: 5

        Rectangle {
            visible: root.dot
            width: 6
            height: 6
            radius: 3
            color: root.tone
            anchors.verticalCenter: parent.verticalCenter
        }
        Text {
            text: root.text
            color: root.tone
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            font.weight: Font.DemiBold
            anchors.verticalCenter: parent.verticalCenter
        }
    }
}
