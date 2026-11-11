import QtQuick
import QtQuick.Layouts
import ".."

// Modal used by the "ⓘ" explainers (why you need your own API key, what
// long-term memory uploads, ...). Text only + an optional external link.
Item {
    id: root

    property bool open: false
    property string title: ""
    property string body: ""
    property string linkLabel: ""
    property string linkUrl: ""

    signal closed()

    visible: open
    z: 61

    function show() {
        root.open = true;
    }
    function close() {
        root.open = false;
        root.closed();
    }

    Rectangle {
        anchors.fill: parent
        color: Qt.rgba(0, 0, 0, 0.55)
        MouseArea {
            anchors.fill: parent
            onClicked: root.close()
        }
    }

    Rectangle {
        id: panel
        anchors.centerIn: parent
        width: Math.min(560, root.width - 60)
        implicitHeight: panelLayout.implicitHeight + 32
        radius: Theme.radiusCard
        color: Theme.cardBg
        border.width: 0.5
        border.color: Qt.rgba(1, 1, 1, 0.16)

        MouseArea { anchors.fill: parent }

        ColumnLayout {
            id: panelLayout
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.margins: 18
            spacing: 12

            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                MIcon {
                    kind: "info"
                    size: 18
                    color: Theme.accent
                }
                Text {
                    Layout.fillWidth: true
                    text: root.title
                    color: Theme.text
                    font.family: Theme.fontSans
                    font.pixelSize: 16
                    font.weight: Font.DemiBold
                    wrapMode: Text.WordWrap
                }
            }
            Text {
                Layout.fillWidth: true
                text: root.body
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fs
                wrapMode: Text.WordWrap
                lineHeight: 1.35
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                MButton {
                    visible: root.linkUrl.length > 0
                    text: root.linkLabel.length > 0 ? root.linkLabel : I18n.t("打开链接")
                    icon: "external"
                    onClicked: Qt.openUrlExternally(root.linkUrl)
                }
                Item { Layout.fillWidth: true }
                MButton {
                    text: I18n.t("关闭")
                    primary: true
                    onClicked: root.close()
                }
            }
        }
    }
}
