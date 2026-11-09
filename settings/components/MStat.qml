import QtQuick
import QtQuick.Layouts
import ".."

// Big-number metric block, used by the overview cards.
Item {
    id: root

    property string label: ""
    property string value: ""
    property string unit: ""
    property color tone: Theme.text
    property string hint: ""

    Layout.fillWidth: true
    implicitHeight: 58

    ColumnLayout {
        anchors.fill: parent
        spacing: 1

        Text {
            Layout.fillWidth: true
            text: root.label
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            elide: Text.ElideRight
        }
        RowLayout {
            Layout.fillWidth: true
            spacing: 3
            Text {
                text: root.value
                color: root.tone
                font.family: Theme.fontSans
                font.pixelSize: 21
                font.weight: Font.DemiBold
            }
            Text {
                visible: root.unit.length > 0
                text: root.unit
                color: Theme.textDim
                font.family: Theme.fontSans
                font.pixelSize: Theme.fsSmall
                Layout.alignment: Qt.AlignBottom
                Layout.bottomMargin: 3
            }
            Item { Layout.fillWidth: true }
        }
        Text {
            visible: root.hint.length > 0
            Layout.fillWidth: true
            text: root.hint
            color: Theme.textFaint
            font.family: Theme.fontSans
            font.pixelSize: Theme.fsTiny
            elide: Text.ElideRight
        }
    }
}
