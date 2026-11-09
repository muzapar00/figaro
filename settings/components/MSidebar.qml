import QtQuick
import QtQuick.Layouts
import ".."

// macOS System Settings sidebar. Primary pages stay visible; the less-used
// pages live under a collapsible "高级" section (简化界面 pass).
Rectangle {
    id: root

    property int currentIndex: 0
    property string currentKey: ""
    property var model: []
    property string appName: "费加罗"
    property string appSubtitle: "系统设置"
    property string footerText: ""

    property bool advancedOpen: false

    signal selected(int index, string key)

    readonly property var primaryItems: {
        const out = [];
        for (let i = 0; i < root.model.length; i++)
            if (!root.model[i].advanced) out.push({ index: i, item: root.model[i] });
        return out;
    }
    readonly property var advancedItems: {
        const out = [];
        for (let i = 0; i < root.model.length; i++)
            if (root.model[i].advanced) out.push({ index: i, item: root.model[i] });
        return out;
    }

    color: Theme.sidebarBg

    // Auto-expand the advanced group when the current page lives there (e.g.
    // opened by the test harness through an IPC page call).
    onCurrentKeyChanged: {
        for (let i = 0; i < root.advancedItems.length; i++) {
            if (root.advancedItems[i].item.key === root.currentKey) {
                root.advancedOpen = true;
                return;
            }
        }
    }

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
                model: root.primaryItems

                Item {
                    required property var modelData
                    width: navColumn.width
                    height: 32

                    Rectangle {
                        anchors.fill: parent
                        radius: 7
                        color: root.currentKey === modelData.item.key
                            ? "#4a4a55"
                            : navMouse.containsMouse ? "#34343c" : "transparent"
                    }

                    Row {
                        anchors.left: parent.left
                        anchors.leftMargin: 9
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 9
                        MIcon {
                            kind: modelData.item.icon
                            size: 15
                            color: root.currentKey === modelData.item.key ? "#ffffff" : Theme.textDim
                            anchors.verticalCenter: parent.verticalCenter
                        }
                        Text {
                            text: modelData.item.label
                            color: root.currentKey === modelData.item.key ? "#ffffff" : Theme.text
                            font.family: Theme.fontSans
                            font.pixelSize: Theme.fs
                            font.weight: root.currentKey === modelData.item.key ? Font.DemiBold : Font.Normal
                            anchors.verticalCenter: parent.verticalCenter
                        }
                    }

                    MouseArea {
                        id: navMouse
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.selected(modelData.index, modelData.item.key)
                    }
                }
            }

            // ---- advanced section ----
            Item {
                width: navColumn.width
                height: 34
                Rectangle {
                    anchors.fill: parent
                    radius: 7
                    color: advMouse.containsMouse ? "#34343c" : "transparent"
                }
                Row {
                    anchors.left: parent.left
                    anchors.leftMargin: 9
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 6
                    MIcon {
                        kind: "chevronRight"
                        size: 11
                        color: Theme.textFaint
                        rotation: root.advancedOpen ? 90 : 0
                        anchors.verticalCenter: parent.verticalCenter
                        Behavior on rotation {
                            NumberAnimation { duration: 120 }
                        }
                    }
                    Text {
                        text: "高级"
                        color: Theme.textFaint
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fsSmall
                        font.weight: Font.DemiBold
                        anchors.verticalCenter: parent.verticalCenter
                    }
                    Text {
                        text: "(" + root.advancedItems.length + ")"
                        color: Theme.textFaint
                        font.family: Theme.fontSans
                        font.pixelSize: Theme.fsTiny
                        anchors.verticalCenter: parent.verticalCenter
                    }
                }
                MouseArea {
                    id: advMouse
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.advancedOpen = !root.advancedOpen
                }
            }

            Repeater {
                model: root.advancedOpen ? root.advancedItems : []

                Item {
                    required property var modelData
                    width: navColumn.width
                    height: 30

                    Rectangle {
                        anchors.fill: parent
                        radius: 7
                        color: root.currentKey === modelData.item.key
                            ? "#4a4a55"
                            : advItemMouse.containsMouse ? "#34343c" : "transparent"
                    }

                    Row {
                        anchors.left: parent.left
                        anchors.leftMargin: 22
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 9
                        MIcon {
                            kind: modelData.item.icon
                            size: 14
                            color: root.currentKey === modelData.item.key ? "#ffffff" : Theme.textDim
                            anchors.verticalCenter: parent.verticalCenter
                        }
                        Text {
                            text: modelData.item.label
                            color: root.currentKey === modelData.item.key ? "#ffffff" : Theme.text
                            font.family: Theme.fontSans
                            font.pixelSize: Theme.fsSmall
                            anchors.verticalCenter: parent.verticalCenter
                        }
                    }

                    MouseArea {
                        id: advItemMouse
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.selected(modelData.index, modelData.item.key)
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
