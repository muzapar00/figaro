import QtQuick
import ".."

// macOS text field: 28px tall, inset dark fill, accent focus ring.
Rectangle {
    id: root

    property alias text: input.text
    property string placeholder: ""
    property int inputWidth: 220
    property bool readOnly: false
    property bool password: false

    signal accepted()
    signal edited(string value)

    implicitWidth: inputWidth
    implicitHeight: Theme.controlH
    radius: 7
    color: Theme.insetBg
    border.width: 1
    border.color: input.activeFocus ? Theme.accent : "#2f2f36"

    TextInput {
        id: input
        anchors.fill: parent
        anchors.leftMargin: 8
        anchors.rightMargin: 8
        verticalAlignment: TextInput.AlignVCenter
        color: Theme.text
        selectionColor: Theme.accent
        selectedTextColor: "#ffffff"
        font.family: Theme.fontSans
        font.pixelSize: Theme.fs
        readOnly: root.readOnly
        echoMode: root.password ? TextInput.Password : TextInput.Normal
        passwordCharacter: "•"
        clip: true
        selectByMouse: true
        onAccepted: root.accepted()
        onTextEdited: root.edited(input.text)
    }

    Text {
        anchors.left: parent.left
        anchors.leftMargin: 9
        anchors.verticalCenter: parent.verticalCenter
        visible: input.text.length === 0
        text: root.placeholder
        color: Theme.textFaint
        font.family: Theme.fontSans
        font.pixelSize: Theme.fs
        elide: Text.ElideRight
        width: parent.width - 18
    }
}
