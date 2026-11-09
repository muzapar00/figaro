import QtQuick
import QtQuick.Layouts
import ".."

// macOS System Settings sidebar: app identity, grouped nav items, selected pill.
Rectangle {
    id: root

    property int currentIndex: 0
    property var model: []
    property string appName: "费加罗"
    property string appSubtitle: "系统设置"
    property string footerText: ""

    signal selected(int index, string key)

    color: Theme.sidebarBg

    Column {
        id: header
        x: 16
        y: 8
        width: parent.width - 32
        spacing: 0

        Row {
            spacing: 9
            Rectangle {
                width: 30
                height: 30
                radius: 8
                color: "#0a84ff"
                MIcon {
                    anchors.centerIn: parent
                    kind: "mic"
                    size: 18
                    color: "#ffffff"
                }
            }
            Column {
                anchors.verticalCenter: parent.verticalCenter
                spacing: 0
                Text {
                    text: root.appName
                    color: Theme.text
                    font.family: Theme.fontSans
                    font.pixelSize: 14
                    font.weight: Font.DemiBold
                }
                Text {
                    text: root.appSubtitle
                    color: Theme.textFaint
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsTiny
                }
            }
        }
    }

    Flickable {
        id: navFlick
        anchors.top: header.bottom
        anchors.topMargin: 16
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: footer.top
        anchors.bottomMargin: 6
        contentHeight: navColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        Column {
            id: navColumn
            x: 8
            width: navFlick.width - 16
            spacing: 2

            Repeater {
                model: root.model

                Item {
                    required property int index
                    required property var modelData
                    width: navColumn.width
                    height: 32

                    Rectangle {
                        anchors.fill: parent
                        radius: 7
                        color: root.currentIndex === index
                            ? "#4a4a55"
                            : navMouse.containsMouse ? "#34343c" : "transparent"
                    }

                    Row {
                        anchors.left: parent.left
                        anchors.leftMargin: 9
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 9

                        MIcon {
                            kind: modelData.icon
                            size: 15
                            color: root.currentIndex === index ? "#ffffff" : Theme.textDim
                            anchors.verticalCenter: parent.verticalCenter
                        }
                        Text {
                            text: modelData.label
                            color: root.currentIndex === index ? "#ffffff" : Theme.text
                            font.family: Theme.fontSans
                            font.pixelSize: Theme.fs
                            font.weight: root.currentIndex === index ? Font.DemiBold : Font.Normal
                            anchors.verticalCenter: parent.verticalCenter
                        }
                    }

                    MouseArea {
                        id: navMouse
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.selected(index, modelData.key)
                    }
                }
            }
        }
    }

    Item {
        id: footer
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.bottomMargin: 10
        height: 42

        Column {
            anchors.left: parent.left
            anchors.leftMargin: 16
            anchors.verticalCenter: parent.verticalCenter
            spacing: 2

            Text {
                text: root.footerText
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsTiny
            }
        }
    }
}
