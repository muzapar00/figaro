import QtQuick
import QtQuick.Layouts
import ".."

// Collapsible card for the "简化界面" pass: the common controls stay on top,
// less-used groups live in a 高级 section that starts collapsed.
Rectangle {
    id: root

    property string title: "高级"
    property string subtitle: ""
    property bool expanded: false
    property int expandedHeight: -1

    default property alias content: body.data

    Layout.fillWidth: true
    implicitWidth: 400
    implicitHeight: header.height + (root.expanded ? body.implicitHeight + 2 + root.innerPadding : 0)
    radius: Theme.radiusCard
    color: Theme.cardBg

    property real innerPadding: 14

    Item {
        id: header
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        height: 44

        Rectangle {
            anchors.fill: parent
            color: headerMouse.containsMouse ? Qt.rgba(1, 1, 1, 0.035) : "transparent"
            radius: Theme.radiusCard
        }

        MIcon {
            id: chevron
            anchors.left: parent.left
            anchors.leftMargin: root.innerPadding
            anchors.verticalCenter: parent.verticalCenter
            kind: "chevronRight"
            size: 12
            color: Theme.textDim
            rotation: root.expanded ? 90 : 0
            Behavior on rotation {
                NumberAnimation { duration: 120 }
            }
        }
        Column {
            anchors.left: chevron.right
            anchors.leftMargin: 8
            anchors.right: headerRight.left
            anchors.rightMargin: 8
            anchors.verticalCenter: parent.verticalCenter
            spacing: 1
            Text {
                width: parent.width
                text: root.title
                color: Theme.text
                font.family: Theme.fontSans
                font.pixelSize: Theme.fs
                elide: Text.ElideRight
            }
            Text {
                visible: root.subtitle.length > 0
                width: parent.width
                text: root.subtitle
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
                elide: Text.ElideRight
            }
        }
        Text {
            id: headerRight
            anchors.right: parent.right
            anchors.rightMargin: root.innerPadding
            anchors.verticalCenter: parent.verticalCenter
            text: root.expanded ? "收起" : "展开"
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
        }
        MouseArea {
            id: headerMouse
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: root.expanded = !root.expanded
        }
    }

    Rectangle {
        visible: root.expanded
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: header.bottom
        anchors.margins: root.innerPadding
        anchors.topMargin: 0
        height: 1
        color: Theme.separator
        opacity: 0.55
    }

    ColumnLayout {
        id: body
        visible: root.expanded
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: header.bottom
        anchors.topMargin: root.innerPadding + 4
        anchors.leftMargin: root.innerPadding
        anchors.rightMargin: root.innerPadding
        spacing: 4

        Behavior on implicitHeight {
            NumberAnimation { duration: 140 }
        }
    }
}
