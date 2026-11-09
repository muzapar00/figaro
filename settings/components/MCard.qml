import QtQuick
import QtQuick.Layouts
import ".."

// macOS-style grouped card: rounded 12, flat dark fill, inset content.
Rectangle {
    id: root

    property string title: ""
    property string subtitle: ""
    property real contentSpacing: 0
    property real innerPadding: 14

    default property alias content: contentLayout.data

    Layout.fillWidth: true
    implicitWidth: 400
    implicitHeight: layout.implicitHeight + root.innerPadding * 2
    radius: Theme.radiusCard
    color: Theme.cardBg

    ColumnLayout {
        id: layout
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: root.innerPadding
        spacing: 8

        Text {
            visible: root.title.length > 0
            Layout.fillWidth: true
            text: root.title
            color: Theme.textDim
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            font.weight: Font.DemiBold
            font.letterSpacing: 0.3
        }
        Text {
            visible: root.subtitle.length > 0
            Layout.fillWidth: true
            text: root.subtitle
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            wrapMode: Text.WordWrap
            lineHeight: 1.25
        }
        ColumnLayout {
            id: contentLayout
            Layout.fillWidth: true
            Layout.topMargin: root.title.length > 0 || root.subtitle.length > 0 ? 2 : 0
            spacing: root.contentSpacing
        }
    }
}
