import QtQuick
import QtQuick.Layouts
import ".."

// macOS-style title bar: traffic lights, centered title, status pills.
// Dragging is handed to the compositor with FloatingWindow.startSystemMove().
Item {
    id: root

    property var targetWindow: null
    property int buttonSize: 16
    property string title: ""
    property string subtitle: ""
    property string statusText: ""
    property color statusTone: Theme.textDim
    property bool statusVisible: true
    property string modeText: ""

    height: Theme.titleBarH

    Rectangle {
        anchors.fill: parent
        color: "transparent"
    }

    // drag surface (under the buttons so the lights still click)
    MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.LeftButton
        onPressed: {
            if (root.targetWindow) root.targetWindow.startSystemMove();
        }
    }

    Row {
        id: lights
        anchors.left: parent.left
        anchors.leftMargin: 16
        anchors.verticalCenter: parent.verticalCenter
        spacing: root.buttonSize >= 20 ? 9 : 8
        z: 2

        MTrafficLight {
            size: root.buttonSize
            tone: "#ff5f57"
            glyph: "close"
            onClicked: Qt.quit()
        }
        MTrafficLight {
            size: root.buttonSize
            tone: "#febc2e"
            glyph: "minus"
            onClicked: {
                if (root.targetWindow) root.targetWindow.minimized = true;
            }
        }
        MTrafficLight {
            size: root.buttonSize
            tone: "#28c840"
            glyph: "plus"
            onClicked: {
                if (root.targetWindow) root.targetWindow.maximized = !root.targetWindow.maximized;
            }
        }
    }

    Column {
        anchors.centerIn: parent
        spacing: 0
        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            text: root.title
            color: Theme.text
            font.family: Theme.fontSans
            font.pixelSize: 13
            font.weight: Font.DemiBold
        }
        Text {
            visible: root.subtitle.length > 0
            anchors.horizontalCenter: parent.horizontalCenter
            text: root.subtitle
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
        }
    }

    RowLayout {
        anchors.right: parent.right
        anchors.rightMargin: 16
        anchors.verticalCenter: parent.verticalCenter
        spacing: 8
        z: 2

        Text {
            visible: root.modeText.length > 0
            text: root.modeText
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            Layout.alignment: Qt.AlignVCenter
        }
        MPill {
            visible: root.statusVisible && root.statusText.length > 0
            text: root.statusText
            tone: root.statusTone
        }
        Item { width: 120; height: 1 }
    }
}
