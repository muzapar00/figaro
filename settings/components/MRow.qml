import QtQuick
import QtQuick.Layouts
import ".."

// macOS System Settings style row: label + optional subtitle on the left,
// a control on the right, hairline separator underneath.
Item {
    id: root

    property string label: ""
    property string subtitle: ""
    property bool showSeparator: true
    property bool subtitleWrap: false
    property int controlMinWidth: 0
    property alias labelItem: labelText
    property alias subtitleItem: subtitleText

    default property alias controlData: controlSlot.data

    Layout.fillWidth: true
    implicitHeight: Math.max(Theme.rowH, labels.implicitHeight + 14)

    Column {
        id: labels
        anchors.left: parent.left
        anchors.right: controlSlot.left
        anchors.rightMargin: 12
        anchors.verticalCenter: parent.verticalCenter
        spacing: 2

        Text {
            id: labelText
            width: parent.width
            text: root.label
            color: Theme.text
            font.family: Theme.fontSans
            font.pixelSize: Theme.fs
            elide: Text.ElideRight
        }
        Text {
            id: subtitleText
            visible: root.subtitle.length > 0
            width: parent.width
            text: root.subtitle
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsSmall
            wrapMode: root.subtitleWrap ? Text.WordWrap : Text.NoWrap
            elide: root.subtitleWrap ? Text.ElideNone : Text.ElideRight
            lineHeight: 1.15
        }
    }

    Item {
        id: controlSlot
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        width: Math.max(root.controlMinWidth, childrenRect.width)
        height: childrenRect.height
    }

    Rectangle {
        visible: root.showSeparator
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        height: 1
        color: Theme.separator
        opacity: 0.55
    }
}
