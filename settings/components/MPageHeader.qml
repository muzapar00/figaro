import QtQuick
import QtQuick.Layouts
import ".."

// Page header, matching the large title used in macOS System Settings panes.
Item {
    id: root

    property string title: ""
    property string subtitle: ""
    property string icon: ""

    Layout.fillWidth: true
    implicitHeight: 54

    RowLayout {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: 10

        Rectangle {
            visible: root.icon.length > 0
            width: 30
            height: 30
            radius: 8
            color: Qt.rgba(0.04, 0.52, 1.0, 0.18)
            Layout.alignment: Qt.AlignVCenter
            MIcon {
                anchors.centerIn: parent
                kind: root.icon
                size: 17
                color: Theme.accent
            }
        }

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 1

            Text {
                Layout.fillWidth: true
                text: root.title
                color: Theme.text
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsTitle
                font.weight: Font.DemiBold
                elide: Text.ElideRight
            }
            Text {
                visible: root.subtitle.length > 0
                Layout.fillWidth: true
                text: root.subtitle
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
                elide: Text.ElideRight
            }
        }
    }
}
