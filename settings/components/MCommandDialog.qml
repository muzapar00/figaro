import QtQuick
import QtQuick.Layouts
import Quickshell.Io
import ".."

// Modal that shows a CLI command the user has to run themselves (the settings
// GUI cannot drive the microphone for `figaro enroll-voice`). The command is
// copied with wl-copy, with an xclip fallback for X11.
Item {
    id: root

    property bool open: false
    property string title: ""
    property string command: ""
    property string note: ""
    property string copiedText: ""

    signal closed()

    visible: open
    z: 60

    function show() {
        root.open = true;
        root.copiedText = "";
    }
    function close() {
        root.open = false;
        root.closed();
    }
    function copyCommand() {
        if (root.command.length === 0) return;
        copyProcess.exec([
            "/bin/sh", "-c",
            "printf '%s' \"$1\" | wl-copy 2>/dev/null || printf '%s' \"$1\" | xclip -selection clipboard 2>/dev/null",
            "sh", root.command,
        ]);
        root.copiedText = "已复制到剪贴板";
        copiedTimer.restart();
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
        width: Math.min(540, root.width - 60)
        implicitHeight: panelLayout.implicitHeight + 32
        radius: Theme.radiusCard
        color: Theme.cardBg
        border.width: 0.5
        border.color: Qt.rgba(1, 1, 1, 0.16)

        MouseArea { anchors.fill: parent }   // swallow clicks behind the panel

        ColumnLayout {
            id: panelLayout
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.margins: 16
            spacing: 12

            Text {
                Layout.fillWidth: true
                text: root.title
                color: Theme.text
                font.family: Theme.fontSans
                font.pixelSize: 15
                font.weight: Font.DemiBold
                wrapMode: Text.WordWrap
            }
            Text {
                Layout.fillWidth: true
                visible: root.note.length > 0
                text: root.note
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
                wrapMode: Text.WordWrap
                lineHeight: 1.3
            }
            Rectangle {
                Layout.fillWidth: true
                implicitHeight: commandText.implicitHeight + 24
                radius: 7
                color: Theme.insetBg
                border.width: 1
                border.color: Qt.rgba(1, 1, 1, 0.10)

                // Plain Text, not TextEdit: TextEdit segfaults the Qt software
                // renderer in this Quickshell build (crash at startup), and the
                // whole command can be copied with the button below.
                Text {
                    id: commandText
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.margins: 10
                    text: root.command
                    color: Theme.text
                    font.family: "JetBrains Mono, " + Theme.fontCJK
                    font.pixelSize: 12
                    wrapMode: Text.Wrap
                }
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: 8
                Text {
                    visible: root.copiedText.length > 0
                    text: root.copiedText
                    color: Theme.green
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.fsSmall
                }
                Item { Layout.fillWidth: true }
                MButton {
                    text: "复制命令"
                    primary: true
                    onClicked: root.copyCommand()
                }
                MButton {
                    text: "关闭"
                    onClicked: root.close()
                }
            }
        }
    }

    Process {
        id: copyProcess
        running: false
    }

    Timer {
        id: copiedTimer
        interval: 2000
        repeat: false
        onTriggered: root.copiedText = ""
    }
}
