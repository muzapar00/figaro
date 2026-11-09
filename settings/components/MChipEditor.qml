import QtQuick
import QtQuick.Layouts
import ".."

// Editable list of short phrases (wake words / dismiss / cancel phrases).
// Chips are removed with the × and added with the input underneath; every edit
// emits the complete new array so the parent can write it to the daemon config
// immediately.
Item {
    id: root

    property var values: []
    property string placeholder: "输入短语后回车"
    property bool editable: true
    property string addLabel: "添加"
    property string emptyText: "（空）"

    signal edited(var values)

    Layout.fillWidth: true
    implicitHeight: column.implicitHeight

    function copyValues() {
        const out = [];
        const src = root.values || [];
        for (let i = 0; i < src.length; i++) out.push(String(src[i]));
        return out;
    }

    function add() {
        const value = addInput.text.trim();
        if (value.length === 0) return;
        const next = root.copyValues();
        if (next.indexOf(value) < 0) next.push(value);
        addInput.text = "";
        root.edited(next);
    }

    function removeAt(index) {
        const next = root.copyValues();
        if (index < 0 || index >= next.length) return;
        next.splice(index, 1);
        root.edited(next);
    }

    ColumnLayout {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        spacing: 6

        Flow {
            Layout.fillWidth: true
            spacing: 6

            Repeater {
                model: root.values

                Rectangle {
                    id: chip
                    required property var modelData
                    required property int index

                    width: chipRow.implicitWidth + 14
                    height: 24
                    radius: 12
                    color: Theme.insetBg
                    border.width: 0.5
                    border.color: Qt.rgba(1, 1, 1, 0.10)

                    Row {
                        id: chipRow
                        anchors.centerIn: parent
                        spacing: 5

                        Text {
                            text: String(chip.modelData)
                            color: Theme.text
                            font.family: Theme.fontSans
                            font.pixelSize: Theme.fsSmall
                            anchors.verticalCenter: parent.verticalCenter
                        }
                        MIcon {
                            visible: root.editable
                            kind: "close"
                            size: 9
                            color: chipMouse.containsMouse ? Theme.red : Theme.textFaint
                            anchors.verticalCenter: parent.verticalCenter
                            MouseArea {
                                id: chipMouse
                                anchors.fill: parent
                                anchors.margins: -3
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: root.removeAt(chip.index)
                            }
                        }
                    }
                }
            }

            Text {
                visible: root.values.length === 0
                text: root.emptyText
                color: Theme.textFaint
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            visible: root.editable

            MTextField {
                id: addInput
                Layout.fillWidth: true
                placeholder: root.placeholder
                onAccepted: root.add()
            }
            MButton {
                text: "+ " + root.addLabel
                icon: "plus"
                onClicked: root.add()
            }
        }
    }
}
