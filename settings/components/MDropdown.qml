import QtQuick
import QtQuick.Layouts
import ".."

// Compact select. The option list expands in place (instead of a floating
// popup) so it can live inside the clipped, scrollable page without z-order
// tricks. Behaves like a macOS pop-up button otherwise.
Item {
    id: root

    property var items: []          // [{id, label}] or ["a", "b"]
    property string currentId: ""
    property string placeholder: I18n.t("选择…")
    property bool interactive: true

    signal picked(string id)

    implicitWidth: 230
    implicitHeight: button.height + (open ? list.height + 4 : 0)

    property bool open: false

    function idAt(i) {
        const it = root.items[i];
        if (it === undefined) return "";
        return typeof it === "object" ? String(it.id) : String(it);
    }
    function labelAt(i) {
        const it = root.items[i];
        if (it === undefined) return "";
        return typeof it === "object" ? String(it.label !== undefined ? it.label : it.id) : String(it);
    }
    function label() {
        for (let i = 0; i < root.items.length; i++)
            if (root.idAt(i) === root.currentId) return root.labelAt(i);
        return root.currentId.length > 0 ? root.currentId : root.placeholder;
    }

    Rectangle {
        id: button
        width: parent.width
        height: Theme.controlH
        radius: 7
        color: mouse.containsMouse ? Theme.controlBgHover : Theme.controlBg
        border.width: 0.5
        border.color: Qt.rgba(1, 1, 1, 0.08)
        opacity: root.interactive ? 1 : 0.6

        Text {
            anchors.left: parent.left
            anchors.leftMargin: 9
            anchors.right: chevron.left
            anchors.rightMargin: 6
            anchors.verticalCenter: parent.verticalCenter
            text: root.label()
            color: Theme.text
            font.family: Theme.fontSans
            font.pixelSize: Theme.fs
            elide: Text.ElideRight
        }
        MIcon {
            id: chevron
            anchors.right: parent.right
            anchors.rightMargin: 7
            anchors.verticalCenter: parent.verticalCenter
            kind: "chevronDown"
            size: 12
            color: Theme.textDim
        }
        MouseArea {
            id: mouse
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: root.interactive ? Qt.PointingHandCursor : Qt.ArrowCursor
            onClicked: root.open = !root.open
        }
    }

    Rectangle {
        id: list
        visible: root.open
        width: parent.width
        height: Math.min(root.items.length * 30 + 8, 210)
        anchors.top: button.bottom
        anchors.topMargin: 4
        radius: 8
        color: Theme.cardBgAlt
        border.width: 0.5
        border.color: Qt.rgba(1, 1, 1, 0.10)
        clip: true

        ListView {
            id: listView
            anchors.fill: parent
            anchors.margins: 4
            model: root.items
            boundsBehavior: Flickable.StopAtBounds

            delegate: Rectangle {
                required property int index
                width: listView.width
                height: 30
                radius: 6
                color: {
                    if (root.idAt(index) === root.currentId) return Qt.rgba(0.04, 0.52, 1.0, 0.22);
                    return itemMouse.containsMouse ? Theme.controlBgHover : "transparent";
                }

                Text {
                    anchors.left: parent.left
                    anchors.leftMargin: 8
                    anchors.right: parent.right
                    anchors.rightMargin: 8
                    anchors.verticalCenter: parent.verticalCenter
                    text: root.labelAt(index)
                    color: Theme.text
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fs
                    elide: Text.ElideRight
                }
                MIcon {
                    visible: root.idAt(index) === root.currentId
                    kind: "check"
                    size: 12
                    color: Theme.accent
                    anchors.right: parent.right
                    anchors.rightMargin: 8
                    anchors.verticalCenter: parent.verticalCenter
                }

                MouseArea {
                    id: itemMouse
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                        root.currentId = root.idAt(index);
                        root.open = false;
                        root.picked(root.currentId);
                    }
                }
            }
        }
    }
}
